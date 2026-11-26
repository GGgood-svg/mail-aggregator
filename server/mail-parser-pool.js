'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');

const unavailable = () => Object.assign(new Error('邮件解析繁忙或暂时不可用，请稍后重试'), { statusCode: 503 });
class MailParserPool {
  constructor({ size = 1, maxQueue = 4, timeoutMs = 15000,
    createWorker = () => new Worker(path.join(__dirname, 'mail-parser-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 128 } }) } = {}) {
    Object.assign(this, { size, maxQueue, timeoutMs, createWorker });
    this.workers = new Set(); this.queue = []; this.nextId = 0; this.closed = false;
  }
  status() {
    const workers = [...this.workers];
    return { running: workers.filter(slot => slot.job).length, queued: this.queue.length,
      stopping: workers.filter(slot => slot.stopping).length, capacity: this.size, maxQueue: this.maxQueue };
  }
  parse(metadata, source, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('请求已取消'), { statusCode: 499 }));
    if (this.closed || (this.workers.size >= this.size && ![...this.workers].some(s => !s.job && !s.stopping) && this.queue.length >= this.maxQueue)) return Promise.reject(unavailable());
    if (Buffer.byteLength(source) > 10 * 1024 * 1024) return Promise.reject(Object.assign(new Error('邮件超过正文预览上限'), { statusCode: 413 }));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.nextId, metadata, source, resolve, reject, signal, settled: false };
      job.cancel = () => this.cancel(job, Object.assign(new Error('请求已取消'), { statusCode: 499 }));
      job.timer = setTimeout(() => this.cancel(job, unavailable()), this.timeoutMs);
      signal?.addEventListener('abort', job.cancel, { once: true });
      this.queue.push(job); this.drain();
    });
  }
  settle(job, error, result) {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.cancel);
    job.source = job.metadata = undefined;
    if (error) job.reject(error); else job.resolve(result);
  }
  cancel(job, error) {
    const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1);
    const slot = [...this.workers].find(s => s.job === job);
    this.settle(job, error); if (slot) this.stop(slot);
  }
  stop(slot) {
    if (slot.stopping) return;
    slot.stopping = true;
    if (slot.job) this.settle(slot.job, unavailable());
    slot.job = null; slot.worker.terminate().catch(() => {});
  }
  drain() {
    while (!this.closed && this.queue.length) {
      let slot = [...this.workers].find(s => !s.job && !s.stopping);
      if (!slot) {
        if (this.workers.size >= this.size) return;
        let worker;
        try { worker = this.createWorker(); } catch (_) { this.settle(this.queue.shift(), unavailable()); continue; }
        slot = { worker, job: null, stopping: false }; this.workers.add(slot);
        worker.on('message', message => {
          const job = slot.job; if (!job || slot.stopping) return;
          if (message.id !== job.id || message.failed || typeof message.result?.html !== 'string' || !Array.isArray(message.result?.attachments)) { this.stop(slot); return; }
          slot.job = null; this.settle(job, null, message.result); worker.unref(); this.drain();
        });
        worker.on('error', () => this.stop(slot));
        worker.on('exit', () => { if (slot.job) this.settle(slot.job, unavailable()); this.workers.delete(slot); this.drain(); });
      }
      const job = this.queue.shift(); slot.job = job; slot.worker.ref();
      try { slot.worker.postMessage({ id: job.id, metadata: job.metadata, source: job.source }); } catch (_) { this.stop(slot); }
    }
  }
  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) this.settle(job, unavailable());
    await Promise.all([...this.workers].map(slot => { this.stop(slot); return slot.worker.terminate().catch(() => {}); }));
  }
}
const mailParser = new MailParserPool();
module.exports = { MailParserPool, mailParser };
