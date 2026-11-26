'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createOperationsStore, SAMPLE } = require('../server/operations-store');
const { createOperations, auditRequest, acceptedUpdateOperationId } = require('../server/operations');
const { initializeRestoreState, recordRestoreResult } = require('../server/restore-journal');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...args) => {
    db.exec('BEGIN');
    try { const result = fn(...args); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  let now = 1_800_000_000_000;
  const clock = () => now;
  t.after(() => db.close());
  return { db, clock, store: createOperationsStore(db, { clock }), advance: ms => { now += ms; } };
}
const mountId = 'abcdef12345678901234';
const mail = '12345678901234567890';
const day = 24 * 60 * 60 * 1000;

test('capacity trends retain mount identity, omit unsampled periods and keep low points distinct from unknown inodes', t => {
  const f = fixture(t);
  const firstAt = f.clock();
  const source = { mountId, uses: ['logs', 'database', 'logs', '/srv/private'], ok:true, availableMb:12, availableInodes:undefined,
    unreleasedPrivatePath:'/srv/private' };
  f.store.recordCapacity([source, { ...source, mountId:'rdp://secret' }]);
  f.advance(SAMPLE);
  f.store.recordCapacity([{ ...source, availableMb:0, availableInodes:0, ok:false, code:'low_inodes' }]);
  f.advance(5 * SAMPLE);
  // Reopen the projection using the same SQLite contents after one entire bucket was missed.
  const reopened = createOperationsStore(f.db, { clock:f.clock });
  reopened.recordCapacity([{ ...source, mountId:mail, uses:['mail'] }]);
  const result = reopened.capacityTrend('24h');
  assert.equal(result.volumes.length, 2);
  const observed = result.volumes.find(v => v.mountId === mountId);
  assert.equal(observed.points.length, 96);
  assert.deepEqual(observed.points.slice(-3), [[0,0,2], null, null]);
  assert.deepEqual(observed.latest, { at:firstAt+SAMPLE, uses:['database','logs'], code:'low_inodes', availableMb:0, availableInodes:0, minimumMb:null });
  assert.deepEqual(result.volumes.find(v => v.mountId === mail).points.slice(-3), [null, null, [12,null,1]]);
  assert.equal(result.volumes.find(v => v.mountId === mail).latest.availableInodes, null);
  assert.equal(reopened.capacityTrend('7d').volumes[0].points.length, 168);
  assert.ok(!JSON.stringify(result).includes('/srv/private'));
  f.advance(8*day);
  reopened.recordCapacity([]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM capacity_samples').get().n, 0);
});

test('audit groups failed sign-ins, filters and pages without exposing credentials, addresses or request paths', t => {
  const f = fixture(t);
  const context = { status:401, event:'login', outcome:'rejected', actorId:1, password:'unreleased-password', ip:'192.0.2.42' };
  f.store.recordAudit(context);
  f.store.recordAudit(context);
  f.store.recordAudit({ event:'unexpected raw API field', outcome:'success', status:200 });
  const out = f.store.auditHistory();
  assert.equal(out.events.length,1);
  assert.equal(out.events[0].occurrences,2);
  assert.equal(out.events[0].actorId,null);
  assert.equal(out.events[0].subjectId,null);
  const id = out.events[0].id;
  f.advance(SAMPLE);
  f.store.recordAudit({ event:'user_changed', outcome:'success', status:200, actorId:3, subjectId:4 });
  f.store.recordAudit({ event:'update_install', outcome:'accepted', status:202, actorId:3 });
  const reopened = createOperationsStore(f.db, { clock:f.clock });
  const first = reopened.auditHistory({ actor:3, limit:1 });
  assert.equal(first.events[0].outcome,'accepted');
  assert.equal(reopened.auditHistory({ actor:3, before:first.nextBefore }).events[0].subjectId,4);
  assert.equal(reopened.auditHistory({ event:'login' }).events[0].id,id);
  assert.ok(!JSON.stringify(reopened.auditHistory()).includes('unreleased'));
  assert.deepEqual(auditRequest('PUT','/api/users/42'), { event:'user_changed', subjectId:42 });
  assert.deepEqual(auditRequest('POST','/api/mail/messages'), null);
  assert.deepEqual(auditRequest('GET','/api/system/restore/snapshots/pre-restore-fake.tar.gz'), { event:'restore_point', subjectId:undefined });
  f.advance(31*day);
  f.store.recordAudit({ event:'logout', outcome:'success', status:200, actorId:3 });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM operations_audit').get().n, 1);
});


const restoreId = '123456789012345678901234567890ab';
const updateId = '12345678-1234-4123-8123-123456789abc';
const oldUpdate = '123456789012345678901234567890cd';

test('audit migrates existing databases and correlates allowlisted HTTP requests with durable outcomes', t => {
  const f = fixture(t);
  f.db.exec(`DROP TABLE operations_audit;
    CREATE TABLE operations_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,at INTEGER NOT NULL,actor INTEGER,subject INTEGER,
      event TEXT NOT NULL,outcome TEXT NOT NULL,status INTEGER NOT NULL,occurrences INTEGER NOT NULL DEFAULT 1,group_key TEXT UNIQUE
    );`);
  f.db.prepare("INSERT INTO operations_audit(id,at,actor,event,outcome,status) VALUES('old-request',?,3,'logout','success',200)").run(f.clock());
  const store = createOperationsStore(f.db, { clock:f.clock });
  assert.equal(store.auditHistory().events[0].operationId, null);
  assert.equal(store.auditHistory().events[0].id, 'old-request');
  f.advance(20);
  store.recordAudit({ event:'update_install', operationId:updateId, outcome:'accepted', status:202, actorId:3 });
  store.recordAudit({ event:'restore', operationId:restoreId, outcome:'failed', status:500, actorId:3 });
  store.recordAudit({ event:'sync_requested', operationId:41, outcome:'accepted', status:200, actorId:7 });
  store.recordAudit({ event:'sync_retried', operationId:'/srv/private/token', outcome:'accepted', status:200 });
  store.recordAudit({ event:'user_changed', operationId:updateId, outcome:'success', status:200, actorId:3 });
  store.recordAudit({ event:'restore_result', operationId:restoreId, outcome:'success', status:200, actorId:3 });
  f.advance(20);
  const at = f.clock();
  store.recordTerminalAudit('update', [
    { operationId:updateId, outcome:'queued', at:at-10 }, { operationId:updateId, outcome:'rolled_back', at:at-5 },
    { operationId:updateId, outcome:'rollback_failed', at:at-2, reason:'/srv/private/credentials' },
    { operationId:updateId, outcome:'rollback_verified', at }, { operationId:'http://user:token@private', outcome:'installed', at },
    { operationId:oldUpdate, outcome:'installed', at:at-10*day }, { operationId:oldUpdate, outcome:'installed', at:at+1 },
  ]);
  store.recordTerminalAudit('restore', [
    { operationId:restoreId, outcome:'rolled_back', at }, { operationId:'g'.repeat(32), outcome:'committed', at },
  ]);
  const reopened = createOperationsStore(f.db, { clock:f.clock });
  reopened.recordTerminalAudit('update', [{ operationId:updateId, outcome:'rollback_verified', at }]);
  const events = reopened.auditHistory({ operationId:updateId }).events;
  assert.deepEqual(events.map(({ event,outcome,status,actorId }) => [event,outcome,status,actorId]), [
    ['update_result','rolled_back',null,null], ['update_result','recovery_required',null,null], ['update_install','accepted',202,3],
  ]);
  assert.ok(events.every(row => row.occurrences === 1));
  assert.deepEqual(reopened.auditHistory({ operationId:restoreId }).events.map(e => e.outcome), ['rolled_back','failed']);
  assert.equal(reopened.auditHistory({ operationId:'41' }).events[0].actorId,7);
  assert.deepEqual(reopened.auditHistory({ operationId:['41', updateId] }).events,[]);
  assert.deepEqual(reopened.auditHistory({ operationId:'9007199254740992' }).events,[]);
  assert.deepEqual(reopened.auditHistory({ operationId:' 41' }).events,[]);
  assert.equal(reopened.auditHistory({ limit:1 }).events[0].event,'restore_result');
  const serialized = JSON.stringify(reopened.auditHistory());
  assert.ok(!serialized.includes('/srv/private') && !serialized.includes('user:token'));
  const first = reopened.auditHistory({ operationId:updateId, limit:1 });
  assert.equal(reopened.auditHistory({ operationId:updateId, before:first.nextBefore,limit:1 }).events[0].outcome,'recovery_required');
  assert.equal(reopened.auditHistory().events.at(-1).operationId, oldUpdate, 'backfill uses source time, not ingestion order');
});

test('poller captures persisted CLI restore and updater history without entering maintenance or replaying receipts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'mailagg-operations-audit-'));
  const db = new DatabaseSync(':memory:');
  const dirs = { root, db:root };
  db.exec('CREATE TABLE sync_jobs(id INTEGER,status TEXT,result_code TEXT)');
  db.exec(`CREATE TABLE restore_state(singleton INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, outcome TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
  const undoId = 'abcdef0123456789abcdef0123456789';
  recordRestoreResult(db, restoreId, 'committed'); // An older CLI wrote the marker before the source migration.
  initializeRestoreState(db);
  const journal = path.join(root,'.restore-journal.json');
  fs.writeFileSync(journal,'{}');
  let now = Date.now() + 1000, operations, calls = 0, writable = false, updateRows;
  const readUpdates = async () => { calls++; return updateRows; };
  const start = () => createOperations({ dirs,db,clock:()=>now,readUpdates,canWrite:()=>writable,healthSnapshot:async()=>({}) });
  t.after(() => {
    operations?.close(); db.close();
    for (const leaf of ['.restore-journal.json','operations.db','operations.db-shm','operations.db-wal']) {
      fs.rmSync(path.join(root,leaf),{ force:true });
    }
    fs.rmdirSync(root);
  });
  operations = start();
  operations.start();
  await operations.refreshAudit();
  assert.equal(calls,0);
  assert.ok(!fs.existsSync(path.join(root,'operations.db')));
  writable = true;
  await operations.refreshAudit();
  assert.deepEqual(operations.auditHistory({ operationId:restoreId }).events,[]);
  fs.unlinkSync(journal);
  recordRestoreResult(db, undoId, 'rolled_back');
  updateRows = [{ operationId:updateId, outcome:'installed', at:now-1 }, { operationId:oldUpdate, outcome:'deferred', at:now-2 }];
  await operations.refreshAudit();
  assert.equal(operations.auditHistory({ operationId:updateId }).events[0].outcome,'success');
  assert.equal(operations.auditHistory({ operationId:undoId }).events[0].outcome,'rolled_back');
  assert.equal(operations.auditHistory({ operationId:restoreId }).events[0].outcome,'success');
  assert.deepEqual(operations.auditHistory({ operationId:oldUpdate }).events,[]);

  let resolveLookup;
  updateRows = new Promise(resolve => { resolveLookup = resolve; });
  const active = operations.refreshAudit();
  await Promise.resolve();
  operations.stop();
  resolveLookup([{ operationId:oldUpdate, outcome:'installed', at:now-2 }]);
  await active;
  assert.deepEqual(operations.auditHistory({ operationId:oldUpdate }).events,[]);
  operations.close();

  // The independent ops DB survives source rereads, and older app generations
  // do not produce a second audit row for the same verified operation.
  updateRows = [{ operationId:updateId, outcome:'installed', at:now-1 }];
  operations = start();
  operations.start();
  await operations.refreshAudit();
  const all = operations.auditHistory().events;
  assert.equal(all.length,3);
  assert.ok(all.every(row => row.occurrences === 1 && row.status === null));

  const response = new EventEmitter();
  Object.assign(response, { statusCode:202, locals:{ auditOperationId:updateId } });
  operations.audit({ method:'POST',path:'/api/system/app-update/install',user:{ id:3 },body:{ operationId:oldUpdate } },response,()=>{});
  response.emit('finish');
  assert.deepEqual(operations.auditHistory({operationId:updateId}).events.map(e=>e.outcome),['accepted','success']);
  assert.deepEqual(operations.auditHistory({operationId:oldUpdate}).events,[]);
});

test('only the current accepted update operation and exact owned route shapes can be correlated', () => {
  const history=[{ operationId:oldUpdate, source:'automatic', outcome:'queued', to:'1.1.1' },
    { operationId:updateId, source:'manual', outcome:'queued', to:'1.1.1' }];
  assert.equal(acceptedUpdateOperationId({ pending:'v1.1.1',history },'v1.1.1'),updateId);
  assert.equal(acceptedUpdateOperationId({ pending:'v1.1.2',history },'v1.1.1'),null);
  assert.equal(acceptedUpdateOperationId({ pending:'v1.1.1',history:[] },'v1.1.1'),null);
  assert.equal(auditRequest('POST','/api/accounts/14/jobs/75/cancel').event,'sync_cancelled');
  assert.equal(auditRequest('POST','/api/accounts/14/sync').event,'sync_requested');
  assert.equal(auditRequest('POST','/api/jobs/75/retry').event,'sync_retried');
  assert.equal(auditRequest('POST','/api/accounts/private/sync'),null);
});
