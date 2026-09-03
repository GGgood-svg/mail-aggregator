const test = require('node:test');
const assert = require('node:assert/strict');

const { createProcessTerminator } = require('../server/process-terminator');

function createHarness({ kill } = {}) {
  const signals = [];
  const timers = [];
  const logs = [];
  const child = {
    kill(signal) {
      signals.push(signal);
      if (kill) return kill(signal);
      return true;
    },
  };
  const schedule = (callback, delay) => {
    const timer = {
      callback,
      delay,
      cancelled: false,
      unrefCalled: false,
      unref() { this.unrefCalled = true; },
    };
    timers.push(timer);
    return timer;
  };
  const cancelSchedule = (timer) => { timer.cancelled = true; };
  const logger = {
    warn(message) { logs.push({ level: 'warn', message }); },
    error(message) { logs.push({ level: 'error', message }); },
  };

  return {
    signals,
    timers,
    logs,
    terminator: createProcessTerminator({
      child,
      jobId: 42,
      schedule,
      cancelSchedule,
      logger,
    }),
  };
}

test('termination sends SIGTERM once and escalates to SIGKILL after 10 seconds', () => {
  const harness = createHarness();

  assert.equal(harness.terminator.request('cancelled', '用户取消'), true);
  assert.equal(harness.terminator.request('timed_out', '任务超时'), false);
  assert.deepEqual(harness.signals, ['SIGTERM']);
  assert.deepEqual(harness.terminator.getTermination(), {
    status: 'cancelled',
    message: '用户取消',
  });
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 10000);
  assert.equal(harness.timers[0].unrefCalled, true);

  harness.timers[0].callback();
  assert.deepEqual(harness.signals, ['SIGTERM', 'SIGKILL']);
});

test('completing a process cancels forced termination', () => {
  const harness = createHarness();

  harness.terminator.request('timed_out', '任务超时');
  harness.terminator.complete();
  assert.equal(harness.timers[0].cancelled, true);

  // Even if a stale callback is invoked by a test or unusual timer race, it
  // must observe completed=true and avoid signaling the process again.
  harness.timers[0].callback();
  assert.deepEqual(harness.signals, ['SIGTERM']);
  assert.equal(harness.terminator.request('cancelled', '用户取消'), false);
});

test('signal failures are logged without throwing or losing termination state', () => {
  const harness = createHarness({
    kill(signal) { throw new Error(`${signal} denied`); },
  });

  assert.doesNotThrow(() => harness.terminator.request('cancelled', '用户取消'));
  assert.equal(harness.terminator.getTermination().status, 'cancelled');
  harness.timers[0].callback();
  assert.equal(harness.logs.filter((entry) => entry.level === 'error').length, 2);
});
