'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./fixtures/sync-test-db.cjs');
const { settleSyncJob, markSyncTransferStarted } = require('../server/sync-settlement');
const { blockedOutcome, describeAvailability, deferQueuedSync } = require('../server/sync-availability');
const { createScheduler } = require('../server/scheduler-core');
const { providerGroup, recordProviderCooldown, readProviderCooldown } = require('../server/sync-provider-policy');
const { enqueueJob, findNextQueuedJob, cancelQueuedJob, reconcileRunningJobs } = require('../server/job-store');
const { serializeJob } = require('../server/job-query');

const loadAccount = db => db.prepare('SELECT * FROM accounts WHERE id=1').get();
const job = (db, id) => db.prepare('SELECT * FROM sync_jobs WHERE id=?').get(id);
const markPreparing = (db, id) => db.prepare("UPDATE sync_jobs SET status='running',stage='preparing' WHERE id=?").run(id);
const time = '2026-11-25T12:00:01.126Z';
const fixtures = t => {
  const db = createDatabase(); t.after(() => db.close());
  db.exec(`INSERT INTO accounts(name,last_sync_status,sync_failure_count,last_host2_messages) VALUES('A','failed',3,13);
      INSERT INTO accounts(name) VALUES('B');`);
  return db;
};
const record = (store, intent) => store.prepare('INSERT INTO fixture_events(job,kind) VALUES(?,?)').run(intent.jobId, intent.kind);

test('SQL abort between history and account writes rolls back job and notice; retry settles exactly once', t => {
  const db = fixtures(t);
  const { jobId } = enqueueJob(db, 1);
  markPreparing(db, jobId);
  assert.ok(markSyncTransferStarted(db, jobId, 1, { pid: 1234, pidIdentity: 'identity', logFile: 'job.log', now: time }));
  db.exec(`CREATE TRIGGER abort_settlement BEFORE UPDATE OF last_sync_status ON accounts BEGIN SELECT RAISE(ABORT,'fixture'); END;`);
  const result = { status: 'success', finishedAt: time, summary: { messagesTransferred: 2 } };
  assert.throws(() => settleSyncJob(db, jobId, 1, result, record), /fixture/);
  assert.equal(job(db, jobId).status, 'running');
  assert.equal(loadAccount(db).sync_failure_count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_events').get().n, 0);
  db.exec('DROP TRIGGER abort_settlement');
  assert.ok(settleSyncJob(db, jobId, 1, result, record).applied);
  assert.equal(settleSyncJob(db, jobId, 1, { status: 'failed' }, record).applied, false);
  assert.equal(job(db, jobId).status, 'success');
  assert.equal(job(db, jobId).pid_identity, null);
  assert.equal(loadAccount(db).last_finished_job_id, jobId);
  assert.equal(loadAccount(db).last_sync_attempt_at, time);
  assert.equal(loadAccount(db).last_sync_success_at, time);
  assert.equal(loadAccount(db).last_host2_messages, 13);
  assert.equal(loadAccount(db).sync_failure_count, 0);
  assert.equal(db.prepare('SELECT kind FROM fixture_events').get().kind, 'recovery');
});

test('failure, cancellations and restarted transfers preserve distinct clocks and retry metrics', t => {
  const db = fixtures(t);
  const queued = enqueueJob(db, 1).jobId;
  assert.equal(cancelQueuedJob(db, queued, 1).status, 'cancelled');
  assert.equal(loadAccount(db).last_sync_attempt_at, null);
  const prepare = enqueueJob(db, 1).jobId;
  markPreparing(db, prepare);
  settleSyncJob(db, prepare, 1, { status: 'failed', category: 'spawn_failed', finishedAt: time });
  assert.equal(loadAccount(db).sync_failure_count, 3);
  const failed = enqueueJob(db, 1).jobId;
  markPreparing(db, failed);
  markSyncTransferStarted(db, failed, 1, { pid: 2345, pidIdentity: 'known', logFile: 'task.log', now: time });
  settleSyncJob(db, failed, 1, { status: 'failed', category: 'auth_failed', finishedAt: time }, record);
  assert.equal(loadAccount(db).sync_failure_count, 4);
  const orphan = enqueueJob(db, 1).jobId;
  markPreparing(db, orphan);
  markSyncTransferStarted(db, orphan, 1, { pid: 3456, pidIdentity: 'known', logFile: 'task.log', now: time });
  assert.equal(reconcileRunningJobs(db, () => false).length, 0);
  assert.equal(job(db, orphan).status, 'running');
  assert.equal(reconcileRunningJobs(db, () => true).length, 1);
  assert.equal(loadAccount(db).last_sync_status, 'interrupted');
  assert.equal(loadAccount(db).sync_result_unknown, 1);
  assert.equal(loadAccount(db).sync_failure_count, 4);
  assert.equal(loadAccount(db).last_sync_success_at, null);
  assert.equal(serializeJob(job(db, orphan)).resultKnown, false);
  assert.equal(Object.hasOwn(serializeJob(job(db, orphan)), 'pid_identity'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_events').get().n, 1);
});

test('storage-blocked queued work yields to a different account and exposes a separate retry time', t => {
  const db = fixtures(t);
  const blocked = enqueueJob(db, 1).jobId;
  markPreparing(db, blocked);
  const later = enqueueJob(db, 2).jobId;
  const outcome = blockedOutcome('low_inodes', Date.parse(time));
  assert.equal(deferQueuedSync(db, blocked, 1, outcome), true);
  assert.equal(findNextQueuedJob(db, time).id, later);
  assert.equal(findNextQueuedJob(db, outcome.nextRetryAt).id, blocked);
  const show = describeAvailability(loadAccount(db), { hasSecret: true, queued: true, now: Date.parse(time) });
  assert.equal(show.state, 'blocked');
  assert.equal(show.block.code, 'low_inodes');
  assert.equal(show.nextRetryAt, outcome.nextRetryAt);
  assert.equal(show.lastAttemptAt, null);
  assert.equal(show.lastSuccessAt, null);
  assert.equal(loadAccount(db).sync_failure_count, 3);
});

test('scheduler exposes scan heartbeat without recording blocked cycle as success', async () => {
  const s = createScheduler({ now: () => Date.parse(time), drainQueue() {},
    loadAccounts: () => [{ id: 1, enabled: 1 }, { id: 2, enabled: 1, sync_paused_until: '2026-11-26T00:00:00.000Z' }],
    hasActiveJob: () => false, triggerSync: () => blockedOutcome('low_disk', Date.parse(time)) });
  const stats = await s.tick();
  assert.deepEqual(stats.blockedByReason, { low_space: 1 });
  assert.equal(stats.paused, 1); assert.equal(stats.triggered, 0); assert.equal(stats.errors, 0);
  assert.equal(s.getStatus().lastScanCompletedAt, time);
  assert.equal(s.getStatus().lastSuccessAt, null);
});

test('provider throttle persists by normalized scope and leaves a separate provider unblocked', t => {
  const db = fixtures(t);
  const a = providerGroup({ provider: 'custom', host: 'EXAMPLE.com.', port: 993, ssl: true });
  assert.equal(a, providerGroup({ provider: 'custom', host: 'example.com', port: 993, ssl: true }));
  const other = providerGroup({ provider: 'gmail' });
  const until = recordProviderCooldown(db, a, time);
  assert.equal(readProviderCooldown(db, a, time), until);
  assert.equal(readProviderCooldown(db, a, until), null);
  assert.equal(readProviderCooldown(db, other, time), null);
});


test('a preparation failure after acknowledging a mirror leaves the previous unknown result in place', t => {
  const db = fixtures(t);
  const orphan = enqueueJob(db, 1).jobId;
  markPreparing(db, orphan);
  markSyncTransferStarted(db, orphan, 1, { pid: 2345, pidIdentity: 'mirror', logFile: 'mirror.log', mirror: true });
  reconcileRunningJobs(db);
  assert.equal(loadAccount(db).sync_result_unknown, 1);
  const attempted = enqueueJob(db, 1).jobId;
  markPreparing(db, attempted);
  settleSyncJob(db, attempted, 1, { status: 'failed', category: 'spawn_failed' });
  assert.equal(loadAccount(db).sync_result_unknown, 1);
  const confirmed = enqueueJob(db, 1).jobId;
  markPreparing(db, confirmed);
  markSyncTransferStarted(db, confirmed, 1, { pid: 99, pidIdentity: 'pending', logFile: 'task.log' });
  settleSyncJob(db, confirmed, 1, { status: 'success' });
  assert.equal(loadAccount(db).sync_result_unknown, 0);
});

test('a released mirror cancellation remains on the account for review and records target folder count', t => {
  const db = fixtures(t);
  const job = enqueueJob(db, 1, 'scheduled').jobId;
  markPreparing(db, job);
  markSyncTransferStarted(db, job, 1, { pid: 1234, pidIdentity: 'mirror', logFile: 'task.log', mirror: true });
  const result = settleSyncJob(db, job, 1, { status: 'cancelled', summary: { host2Folders: 0 } });
  assert.equal(result.intent, null);
  const history = db.prepare('SELECT * FROM sync_jobs WHERE id=?').get(job), account = loadAccount(db);
  assert.equal(history.transport_state, 'released');
  assert.equal(history.trigger_source, 'scheduled');
  assert.equal(history.result_known, 0);
  assert.equal(history.result_code, 'confirm_unknown_result');
  assert.equal(history.host2_folders, 0);
  assert.equal(account.last_sync_status, 'cancelled');
  assert.equal(account.last_host2_folders, 0);
  assert.equal(account.sync_review_required, 1);
  assert.equal(account.last_sync_success_at, null);
  assert.equal(require('../server/sync-availability').needsSyncReview({ ...account, deletion_mode: 'archive' }), true);
});
