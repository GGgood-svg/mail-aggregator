'use strict';

const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');

function unavailable(code = 'PASSWORD_BUSY') {
  return Object.assign(new Error('密码验证服务繁忙或暂时不可用，请稍后重试'), { code, statusCode: 503 });
}

class PasswordPool {
  constructor({ size = Math.min(2, Math.max(1, os.availableParallelism() - 1)), maxQueue = 16,
    timeoutMs = 10000, createWorker = () => new Worker(path.join(__dirname, 'password-worker.js')) } = {}) {
    this.size = size;
    this.maxQueue = maxQueue;
    this.timeoutMs = timeoutMs;
    this.createWorker = createWorker;
    this.workers = new Set();
    this.queue = [];
    this.nextId = 0;
    this.closed = false;
  }

  hash(password) { return this.submit('hash', password); }
  compare(password, hash) { return this.submit('compare', password, hash); }

  status() {
    const workers = [...this.workers];
    return { running: workers.filter(slot => slot.job).length, queued: this.queue.length,
      stopping: workers.filter(slot => slot.stopping).length, capacity: this.size, maxQueue: this.maxQueue };
  }

  submit(operation, password, hash) {
    if (this.closed || (this.queue.length >= this.maxQueue
        && ![...this.workers].some(slot => !slot.job && !slot.stopping) && this.workers.size >= this.size)) {
      return Promise.reject(unavailable());
    }
    return new Promise((resolve, reject) => {
      const job = { id: ++this.nextId, operation, password, hash, resolve, reject, timer: null };
      job.timer = setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        const slot = [...this.workers].find(item => item.job === job);
        this.settle(job, unavailable('PASSWORD_TIMEOUT'));
        if (slot) this.stop(slot);
      }, this.timeoutMs);
      this.queue.push(job);
      this.drain();
    });
  }

  settle(job, error, result) {
    clearTimeout(job.timer);
    // Drop our references as soon as the operation finishes or is abandoned.
    job.password = job.hash = undefined;
    if (error) job.reject(error); else job.resolve(result);
  }

  stop(slot) {
    if (slot.stopping) return;
    slot.stopping = true;
    if (slot.job) this.settle(slot.job, unavailable('PASSWORD_WORKER_FAILED'));
    slot.job = null;
    // Keep the slot occupied until exit, including after a timeout.
    slot.worker.terminate().catch(() => {});
  }

  drain() {
    while (!this.closed && this.queue.length) {
      let slot = [...this.workers].find(item => !item.job && !item.stopping);
      if (!slot) {
        if (this.workers.size >= this.size) return;
        let worker;
        try { worker = this.createWorker(); }
        catch (_) { this.settle(this.queue.shift(), unavailable('PASSWORD_WORKER_FAILED')); continue; }
        slot = { worker, job: null, stopping: false };
        this.workers.add(slot);
        worker.on('message', message => {
          const job = slot.job;
          if (!job || slot.stopping) return;
          if (message.id !== job.id || message.failed
              || (job.operation === 'hash' ? typeof message.result !== 'string' : typeof message.result !== 'boolean')) {
            this.stop(slot);
            return;
          }
          slot.job = null;
          this.settle(job, null, message.result);
          worker.unref();
          this.drain();
        });
        worker.on('error', () => this.stop(slot));
        worker.on('exit', () => {
          if (slot.job) this.settle(slot.job, unavailable('PASSWORD_WORKER_FAILED'));
          this.workers.delete(slot);
          this.drain();
        });
      }
      const job = this.queue.shift();
      slot.job = job;
      slot.worker.ref();
      try { slot.worker.postMessage({ id: job.id, operation: job.operation, password: job.password, hash: job.hash }); }
      catch (_) { this.stop(slot); }
    }
  }

  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) this.settle(job, unavailable());
    await Promise.all([...this.workers].map(slot => {
      if (slot.job) this.settle(slot.job, unavailable());
      slot.job = null;
      slot.stopping = true;
      return slot.worker.terminate().catch(() => {});
    }));
  }
}

const passwordHasher = new PasswordPool();
module.exports = { PasswordPool, passwordHasher };
