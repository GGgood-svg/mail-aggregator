'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProbeCache, versions, getDiagnosticReport } = require('../server/diagnostics');

test('diagnostics coalesce, expire and discard late results after a configuration or credential change', async () => {
  let target = 'one', clock = 0;
  const calls = [];
  const cache = createProbeCache({ key: () => target, now: () => clock,
    probe: () => new Promise(resolve => { calls.push({ target, resolve }); }) });
  const first = cache.get(), second = cache.get();
  await new Promise(setImmediate);
  assert.deepEqual(calls.map(item => item.target), ['one']);
  target = 'two';
  cache.invalidate();
  const third = cache.get();
  calls[0].resolve('old observation');
  await new Promise(setImmediate);
  assert.deepEqual(calls.map(item => item.target), ['one', 'two']);
  calls[1].resolve('new observation');
  assert.deepEqual(await Promise.all([first, second, third]), Array(3).fill('new observation'));
  clock = 9_999;
  assert.equal(await cache.get(), 'new observation');
  clock++;
  const refresh = cache.get();
  await new Promise(setImmediate);
  assert.equal(calls.length, 3);
  calls[2].resolve('fresh observation');
  assert.equal(await refresh, 'fresh observation');
});

test('diagnostics export only approved versions, counters, paths by role and recovery status', () => {
  const marker = 'DO-NOT-EXPORT-FIXTURE';
  const dirs = { root: `/data/${marker}`, secrets: `/data/${marker}/secrets`,
    tmp: `/data/${marker}/tmp`, logs: `/data/${marker}/logs` };
  const db = { prepare: query => ({ get: () => query.includes('sqlite_master') ? { name: 'restore_state' } :
    { operation_id: marker, outcome: 'committed', recorded_at: '2026-11-23T00:00:00Z', log: marker } }) };
  const report = getDiagnosticReport({ dirs, db, installed: versions('2.4.5', marker),
    capacity: { status: 'low', minimumMb: 512, error: marker, observations: [
      { storage: dirs.root, availableMb: 12, availableInodes: 3, password: marker },
      { storage: dirs.logs, uses: ['logs', marker], status: 'unavailable', code: 'capacity_unavailable',
        failure: 'read_only', protection: marker },
      { storage: dirs.tmp, uses: ['temporary'], status: 'unavailable', failure: marker },
      { storage: `/unknown/${marker}`, availableMb: 123, availableInodes: 0 },
    ] }, queues: { password: { running: 1, queued: 2, secret: marker }, mailTasks: { running: 2, currentFolder: marker } } });
  assert.doesNotMatch(JSON.stringify(report), new RegExp(marker));
  assert.deepEqual(report.storage.observations, [
    { storage: 'application', availableMb: 12, availableInodes: 3 },
    { storage: 'logs', availableMb: null, availableInodes: null, uses: ['logs'],
      status: 'unavailable', code: 'capacity_unavailable', failure: 'read_only' },
    { storage: 'temporary', availableMb: null, availableInodes: null, uses: ['temporary'],
      status: 'unavailable', code: null },
  ]);
  assert.deepEqual(report.restore.last, { outcome: 'committed', at: '2026-11-23T00:00:00.000Z' });
  assert.equal(report.queues.password.queued, 2);
  assert.equal(report.versions.imapsync, null);
});
