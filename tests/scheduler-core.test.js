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

test('failure backoff grows, is capped, treats authentication separately and respects manual cancellation', () => {
  const account = { sync_interval: 600, last_sync_at: '2026-05-01 09:00:00', last_sync_status: 'failed', last_sync_category: 'network' };
  assert.equal(scheduleDecision({ ...account, sync_failure_count: 1 }, NOW).retryDelaySeconds, 600);
  assert.equal(scheduleDecision({ ...account, sync_failure_count: 3 }, NOW).retryDelaySeconds, 2400);
  assert.equal(scheduleDecision({ ...account, sync_failure_count: 20 }, NOW).retryDelaySeconds, 21600);
  assert.equal(scheduleDecision({ ...account, last_sync_category: 'auth_failed', sync_failure_count: 1 }, NOW).retryDelaySeconds, 21600);
  assert.equal(scheduleDecision({ ...account, sync_interval: 604800, sync_failure_count: 9 }, NOW).retryDelaySeconds, 604800);
  const cancelled = scheduleDecision({ ...account, sync_failure_count: 8, last_cancelled_at: '2026-05-01 09:55:00' }, NOW);
  assert.equal(cancelled.retryDelaySeconds, 600); assert.equal(cancelled.due, false);
});

test('scheduler skips disabled, active, and not-yet-due accounts and triggers only due work', async () => {
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

  assert.deepEqual(await scheduler.tick(), {
    checked: 4, triggered: 1, active: 1, notDue: 1, disabled: 1, paused: 0, deferred: 0, skipped: 0, errors: 0, blockedByReason: {},
  });
  assert.deepEqual(triggered, [4]);
  assert.equal(drainCount, 1);
  assert.equal(scheduler.getStatus().lastError, null);
});

test('one account failure is isolated and remains visible in scheduler status', async () => {
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

  const result = await scheduler.tick();
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

test('scheduler coalesces overlapping ticks and prevents admission after stop during an async check', async () => {
  let release;
  const checking = new Promise(resolve => { release = resolve; });
  const launched = [], rejectedAfterStop = [];
  const scheduler = createScheduler({
    loadAccounts: () => Array.from({ length: 6 }, (_, i) => ({ id: i + 1, enabled: 1 })),
    hasActiveJob: () => false, drainQueue() {}, logger: { error() {} },
    triggerSync: async (id, { authorize }) => {
      launched.push(id);
      await checking;
      assert.throws(authorize, /调度器已停止/);
      rejectedAfterStop.push(id);
      return { ok: false };
    } });
  const first = scheduler.tick(), second = scheduler.tick();
  assert.equal(first, second);
  assert.deepEqual(launched, [1, 2, 3, 4]);
  scheduler.stop(); release();
  assert.equal((await first).errors, 0);
  assert.deepEqual(launched, [1, 2, 3, 4]);
  assert.deepEqual(rejectedAfterStop, [1, 2, 3, 4]);
});
