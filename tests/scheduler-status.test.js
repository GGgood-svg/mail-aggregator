const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeScheduler } = require('../server/scheduler-status');

const NOW = Date.parse('2026-05-01T10:00:00Z');

test('scheduler health reports healthy recent ticks', () => {
  const result = summarizeScheduler({
    running: true,
    lastTickAt: '2026-05-01T09:59:50.000Z',
    tickIntervalMs: 15000,
    lastError: null,
  }, NOW);
  assert.equal(result.healthCode, 'healthy');
  assert.equal(result.healthy, true);
  assert.equal(result.staleAfterMs, 45000);
});

test('scheduler health distinguishes starting, stopped, error, and stale states', () => {
  assert.equal(summarizeScheduler({ running: true }, NOW).healthCode, 'starting');
  assert.equal(summarizeScheduler({ running: false }, NOW).healthCode, 'stopped');
  assert.equal(summarizeScheduler({
    running: true,
    lastTickAt: '2026-05-01T09:59:59.000Z',
    lastError: 'one failure',
  }, NOW).healthCode, 'error');
  assert.equal(summarizeScheduler({
    running: true,
    lastTickAt: '2026-05-01T09:58:00.000Z',
    tickIntervalMs: 15000,
  }, NOW).healthCode, 'stale');
});
