const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { EventEmitter } = require('node:events');
const { withClient } = require('../server/mail-reader');

function client() {
  return { async connect() {}, async logout() {}, close() { this.usable = false; } };
}

test('mail clients enforce per-user and process limits and release slots after errors', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = [];
  const run = (id, work = () => gate) => withClient(work, { createClient: client }, { user: { id } });
  try {
    for (const id of [1, 1, 1, 2, 2, 2, 3, 3]) pending.push(run(id));
    await assert.rejects(run(4), { statusCode: 429 });
  } finally { release(); await Promise.all(pending); }
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  const sameUser = [run(1, () => hold), run(1, () => hold), run(1, () => hold)];
  try {
    await assert.rejects(run(1), { statusCode: 429 });
    await run(2, async () => {});
  } finally { finish(); await Promise.all(sameUser); }
  for (let i = 0; i < 10; i++) {
    await assert.rejects(run(1, async () => { throw new Error('failed'); }), /failed/);
    await assert.rejects(withClient(() => {}, { createClient() { throw new Error('factory'); } }), /factory/);
  }
  await run(1, async () => {});
});

test('timed-out connect cannot start mailbox work after the response ends', async () => {
  let connect, worked = false, closed = 0, loggedOut = false;
  const fake = { connect: () => new Promise(resolve => { connect = resolve; }),
    close() { closed++; }, async logout() { loggedOut = true; } };
  // Keep the event loop alive while the production deadline is unref'ed.
  const keepAlive = delay(40);
  await assert.rejects(withClient(() => { worked = true; }, { createClient: () => fake }, {}, 10), { statusCode: 504 });
  connect();
  await keepAlive;
  assert.equal(worked, false);
  assert.equal(loggedOut, false);
  assert.ok(closed >= 1);
  await withClient(async () => {}, { createClient: client });
});

test('a disconnected request closes its client and cannot start delayed work', async () => {
  const response = new EventEmitter();
  response.writableFinished = false; response.destroyed = false;
  let connect, worked = false, closed = 0;
  const fake = { connect: () => new Promise(resolve => { connect = resolve; }), close() { closed++; }, async logout() {} };
  const pending = withClient(() => { worked = true; }, { createClient: () => fake }, { res: response, user: { id: 55 } });
  await new Promise(resolve => setImmediate(resolve));
  response.emit('close');
  await assert.rejects(pending, { statusCode: 499 });
  connect(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(worked, false); assert.ok(closed >= 1);
  assert.equal(response.listenerCount('close'), 0);
  await withClient(async () => {}, { createClient: client }, { user: { id: 55 } });
});

test('an already disconnected request does not create a client or leave a rejected cancellation promise', async () => {
  const response = new EventEmitter(); response.destroyed = true; response.writableFinished = false;
  let created = false;
  await assert.rejects(withClient(() => {}, { createClient() { created = true; throw Error('factory failed'); } }, { res: response }), { statusCode: 499 });
  await delay(10);
  assert.equal(created, false); assert.equal(response.listenerCount('close'), 0);
});
