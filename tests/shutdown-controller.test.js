const test = require('node:test');
const assert = require('node:assert/strict');

const { createShutdownController } = require('../server/shutdown-controller');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness() {
  const http = deferred();
  const children = deferred();
  const calls = [];
  const timers = [];
  const exits = [];
  const server = {
    close(callback) {
      calls.push('server.close');
      http.promise.then(() => callback());
    },
  };
  const schedule = (callback, delay) => {
    const timer = { callback, delay, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const cancelSchedule = (timer) => { timer.cancelled = true; };
  const shutdown = createShutdownController({
    server,
    stopScheduler: () => calls.push('scheduler.stop'),
    stopMaintenance: () => calls.push('maintenance.stop'),
    terminateChildren: () => {
      calls.push('children.terminate');
      return children.promise;
    },
    schedule,
    cancelSchedule,
    exit: (code) => exits.push(code),
    logger: { log() {}, error() {} },
  });
  return { shutdown, http, children, calls, timers, exits };
}

test('shutdown waits for both HTTP close and child-process finalization', async () => {
  const harness = createHarness();
  const result = harness.shutdown('SIGTERM');
  await Promise.resolve();

  assert.deepEqual(harness.calls, [
    'scheduler.stop',
    'maintenance.stop',
    'server.close',
    'children.terminate',
  ]);
  assert.equal(harness.timers[0].delay, 15000);
  assert.deepEqual(harness.exits, []);

  harness.http.resolve();
  await Promise.resolve();
  assert.deepEqual(harness.exits, []);

  harness.children.resolve();
  await result;
  assert.deepEqual(harness.exits, [0]);
  assert.equal(harness.timers[0].cancelled, true);
});

test('shutdown is idempotent when more than one signal arrives', async () => {
  const harness = createHarness();
  const first = harness.shutdown('SIGTERM');
  const second = harness.shutdown('SIGINT');

  assert.equal(first, second);
  assert.equal(harness.calls.filter((item) => item === 'server.close').length, 1);
  assert.equal(harness.timers.length, 1);

  harness.http.resolve();
  harness.children.resolve();
  await first;
  assert.deepEqual(harness.exits, [0]);
});

test('shutdown force-exits only after the 15-second safety deadline', async () => {
  const harness = createHarness();
  harness.shutdown('SIGTERM');
  await Promise.resolve();

  assert.deepEqual(harness.exits, []);
  harness.timers[0].callback();
  assert.deepEqual(harness.exits, [1]);
});
