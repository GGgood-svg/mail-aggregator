const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSqliteUtc, scheduleDecision, createScheduler } = require('../server/scheduler-core');

const NOW = Date.parse('2026-05-01T10:00:00Z');

test('schedule decisions use the newest completion/cancellation anchor and survive malformed legacy values', () => {
  assert.equal(parseSqliteUtc('2026-05-01 09:55:00'), Date.parse('2026-05-01T09:55:00Z'));
  assert.equal(parseSqliteUtc('broken'), null);

  const recentCancelled = scheduleDecision({
    sync_interval: 600,
    last_sync_at: '2026-05-01 08:00:00',
    last_cancelled_at: '2026-05-01 09:55:00',
  }, NOW);
  assert.equal(recentCancelled.due, false);
  assert.equal(recentCancelled.dueAt, Date.parse('2026-05-01T10:05:00Z'));

  assert.equal(scheduleDecision({ sync_interval: 600, last_sync_at: 'broken' }, NOW).due, true);
  assert.equal(scheduleDecision({ sync_interval: 5 }, NOW).intervalSeconds, 600);
});

test('scheduler skips disabled, active, and not-yet-due accounts and triggers only due work', () => {
  const triggered = [];
  let drainCount = 0;
  const scheduler = createScheduler({
    now: () => NOW,
    loadAccounts: () => [
      { id: 1, enabled: 0, sync_interval: 600 },
      { id: 2, enabled: 1, sync_interval: 600 },
      { id: 3, enabled: 1, sync_interval: 600, last_cancelled_at: '2026-05-01 09:55:00' },
      { id: 4, enabled: 1, sync_interval: 600, last_cancelled_at: '2026-05-01 09:49:00' },
    ],
    hasActiveJob: (id) => id === 2,
    triggerSync: (id) => { triggered.push(id); return { ok: true }; },
    drainQueue: () => { drainCount++; },
    logger: { error() {} },
  });

  assert.deepEqual(scheduler.tick(), {
    checked: 4, triggered: 1, active: 1, notDue: 1, disabled: 1, errors: 0,
  });
  assert.deepEqual(triggered, [4]);
  assert.equal(drainCount, 1);
  assert.equal(scheduler.getStatus().lastError, null);
});

test('one account failure is isolated and remains visible in scheduler status', () => {
  const triggered = [];
  const logs = [];
  const scheduler = createScheduler({
    now: () => NOW,
    loadAccounts: () => [
      { id: 1, enabled: 1, sync_interval: 600 },
      { id: 2, enabled: 1, sync_interval: 600 },
    ],
    hasActiveJob: (id) => {
      if (id === 1) throw new Error('database read failed');
      return false;
    },
    triggerSync: (id) => { triggered.push(id); return { ok: true }; },
    drainQueue() {},
    logger: { error(message) { logs.push(message); } },
  });

  const result = scheduler.tick();
  assert.equal(result.errors, 1);
  assert.deepEqual(triggered, [2]);
  assert.match(logs[0], /账号 1/);
  assert.equal(scheduler.getStatus().lastError, '1 个账号调度失败');
});

test('scheduler start and stop are idempotent', () => {
  let intervalCount = 0;
  let clearCount = 0;
  const fakeTimer = { unref() {} };
  const scheduler = createScheduler({
    loadAccounts: () => [],
    hasActiveJob: () => false,
    triggerSync: () => ({ ok: true }),
    drainQueue() {},
    setIntervalFn: () => { intervalCount++; return fakeTimer; },
    clearIntervalFn: (timer) => { assert.equal(timer, fakeTimer); clearCount++; },
    logger: { error() {} },
  });

  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  assert.equal(intervalCount, 1);
  assert.equal(scheduler.stop(), true);
  assert.equal(scheduler.stop(), false);
  assert.equal(clearCount, 1);
});
