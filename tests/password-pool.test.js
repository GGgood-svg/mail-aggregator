'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PasswordPool } = require('../server/password-hasher');

test('production password workers preserve bcrypt hashes and leave the main event loop responsive', async () => {
  const pool = new PasswordPool({ size: 2 });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const [hash, other] = await Promise.all([pool.hash('fictional-password-密码'), pool.hash('another-fictional-password')]);
    assert.match(hash, /^\$2[aby]\$12\$/);
    assert.notEqual(hash, other);
    assert.ok(ticks >= 3, `main event loop only ticked ${ticks} times during hashing`);
    assert.equal(await pool.compare('fictional-password-密码', hash), true);
    assert.equal(await pool.compare('wrong-password', hash), false);
  } finally { clearInterval(timer); await pool.close(); }
});

function fakeWorkers() {
  const workers = [];
  return { workers, createWorker() {
    const worker = new EventEmitter();
    worker.ref = worker.unref = () => {};
    worker.postMessage = message => { worker.message = message; };
    worker.terminate = async () => { worker.terminated = true; };
    workers.push(worker);
    return worker;
  } };
}

test('password pool caps queue length and rejects worker crashes without leaking job input', async () => {
  const fake = fakeWorkers();
  const pool = new PasswordPool({ size: 1, maxQueue: 1, createWorker: fake.createWorker });
  try {
    const first = pool.compare('secret-first', 'hash-first');
    const failed = assert.rejects(first, error => error.code === 'PASSWORD_WORKER_FAILED' && !error.message.includes('secret'));
    const second = pool.compare('secret-second', 'hash-second');
    await assert.rejects(pool.hash('third'), { code: 'PASSWORD_BUSY', statusCode: 503 });
    fake.workers[0].emit('error', Error('private worker error'));
    assert.equal(fake.workers.length, 1, 'replacement must await actual worker exit');
    fake.workers[0].emit('exit', 1);
    await failed;
    assert.equal(fake.workers.length, 2);
    const worker = fake.workers[1];
    worker.emit('message', { id: worker.message.id, result: false });
    assert.equal(await second, false);
    assert.equal(pool.queue.length, 0);
  } finally { await pool.close(); }
});

test('password timeouts free queued inputs but hold the running slot until the thread exits', async () => {
  const fake = fakeWorkers();
  const pool = new PasswordPool({ size: 1, timeoutMs: 30, createWorker: fake.createWorker });
  try {
    await assert.rejects(pool.hash('timeout-fixture'), { code: 'PASSWORD_TIMEOUT' });
    const pending = pool.hash('next-fixture');
    assert.equal(fake.workers.length, 1);
    fake.workers[0].emit('exit', 1);
    const replacement = fake.workers[1];
    replacement.emit('message', { id: replacement.message.id, result: '$2a$12$fixture' });
    assert.equal(await pending, '$2a$12$fixture');
  } finally { await pool.close(); }
  await assert.rejects(pool.hash('closed'), { code: 'PASSWORD_BUSY' });
});
