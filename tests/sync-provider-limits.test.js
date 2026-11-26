'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createDatabase } = require('./fixtures/sync-test-db.cjs');
const { enqueueJob } = require('../server/job-store');
const limits = require('../server/sync-provider-policy');

function suspendRealQueue(db) {
  const filename = path.join(__dirname, '../server/sync.js');
  const load = createRequire(filename);
  const capacityChecks = new Map();
  const modules = {
    './db': { db, DIRS: { root: '/unused-fixture' } },
    './config': { localDovecot: () => ({ host: '127.0.0.1', port: 143, user: 'test' }) },
    './notifications': {},
    './state-lock': { stateWritesBlocked: () => false },
    './maintenance-lock': { current: () => null },
    './resource-limits': { ...load('./resource-limits'), syncDiskCapacity: (_db, _dirs, target) => new Promise(resolve => {
      assert.ok(!capacityChecks.has(target.user));
      capacityChecks.set(target.user, () => {
        capacityChecks.delete(target.user);
        resolve({ ok: false, availableMb: 0, scope: 'account' });
      });
    }) },
  };
  // Keep the real queue and SQLite writes. Suspend preparation before any child or remote access.
  const context = { require: name => Object.hasOwn(modules, name) ? modules[name] : load(name),
    module: { exports: {} }, Buffer, process, setImmediate, console };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { sync: context.module.exports, capacityChecks };
}

test('ready groups share global slots with independent limits and live updates leave in-flight work alone', async t => {
  const db = createDatabase();
  const { sync, capacityChecks } = suspendRealQueue(db);
  t.after(async () => {
    const stop = sync.shutdownGracefully();
    for (const release of capacityChecks.values()) release();
    await stop; await nextTurn(); db.close();
  });
  db.exec(`ALTER TABLE accounts ADD COLUMN provider TEXT;
    ALTER TABLE accounts ADD COLUMN local_user TEXT;
    INSERT INTO settings VALUES('max_concurrent_syncs','3'),('max_concurrent_per_provider','4');`);
  const persist = db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)');
  const overrides = update => persist.run(limits.OVERRIDES_SETTING, JSON.stringify(limits.validateProviderLimitOverrides(update)));
  overrides({ qq: 1, outlook: 2 });
  const seed = db.prepare('INSERT INTO accounts(name,provider,local_user) VALUES(?,?,?)');
  for (const [name, provider] of [['A1','qq'],['A2','qq'],['B1','outlook'],['B2','outlook'],['B3','outlook']]) seed.run(name, provider, name);
  const queue = id => assert.ok(enqueueJob(db, id).ok);
  const state = id => db.prepare('SELECT status,stage,result_code FROM sync_jobs WHERE account_id=?').get(id);
  for (const id of [1, 2, 3, 4]) queue(id);
  sync.drainQueue(); await nextTurn();
  assert.deepEqual([...capacityChecks.keys()], ['A1', 'B1', 'B2']);
  assert.equal(sync.currentRunningCount(), 3);
  assert.equal(state(2).status, 'queued'); assert.equal(state(2).result_code, 'provider_busy');
  for (const id of [1, 3, 4]) assert.equal(state(id).stage, 'preparing');

  overrides({ qq: '', outlook: 1 });
  assert.equal(limits.providerConcurrency(db, 'provider:qq'), 4);
  assert.equal(limits.providerConcurrency(db, limits.providerGroup({ provider: 'custom', host: 'custom.example', port: 993, ssl: true })), 4);
  queue(5);
  // Mark the already deferred job due; production retries it after the existing backoff.
  db.exec("UPDATE sync_jobs SET next_attempt_at=NULL WHERE account_id=2");
  capacityChecks.get('B2')();
  await nextTurn();
  sync.drainQueue(); await nextTurn();
  assert.deepEqual([...capacityChecks.keys()], ['A1', 'B1', 'A2']);
  assert.equal(state(2).stage, 'preparing');
  assert.equal(state(3).stage, 'preparing');
  capacityChecks.get('A1')();
  await nextTurn();
  sync.drainQueue(); await nextTurn();
  assert.equal(state(5).status, 'queued'); assert.equal(state(5).result_code, 'provider_busy');
  assert.deepEqual([...capacityChecks.keys()], ['B1', 'A2']);
});
