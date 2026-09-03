const test = require('node:test');
const assert = require('node:assert/strict');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  // Queue integration tests use Node's built-in SQLite test driver when present.
}

const jobStore = require('../server/job-store');
const integrationTest = DatabaseSync ? test : test.skip;

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE sync_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'queued'
      ,pid INTEGER
    );
    CREATE UNIQUE INDEX idx_unique_active_job_per_account
      ON sync_jobs(account_id)
      WHERE status IN ('queued', 'running');
  `);
  return db;
}

function addAccount(db, name) {
  return db.prepare('INSERT INTO accounts(name) VALUES(?)').run(name).lastInsertRowid;
}

function addFinishedJob(db, accountId, status) {
  return db.prepare(
    `INSERT INTO sync_jobs(account_id,started_at,finished_at,status)
     VALUES(?,datetime('now'),datetime('now'),?)`
  ).run(accountId, status).lastInsertRowid;
}

integrationTest('enqueueJob prevents duplicate active work and keeps accounts independent', () => {
  const db = createDatabase();
  try {
    const firstAccount = addAccount(db, 'first');
    const secondAccount = addAccount(db, 'second');

    const first = jobStore.enqueueJob(db, firstAccount);
    assert.equal(first.ok, true);
    assert.equal(jobStore.hasActiveJob(db, firstAccount), true);
    assert.deepEqual(jobStore.enqueueJob(db, firstAccount), {
      ok: false,
      reason: 'already_running',
    });

    const second = jobStore.enqueueJob(db, secondAccount);
    assert.equal(second.ok, true);
    assert.notEqual(second.jobId, first.jobId);
  } finally {
    db.close();
  }
});

integrationTest('findNextQueuedJob follows stable FIFO ordering', () => {
  const db = createDatabase();
  try {
    const firstAccount = addAccount(db, 'first');
    const secondAccount = addAccount(db, 'second');
    const first = jobStore.enqueueJob(db, firstAccount);
    const second = jobStore.enqueueJob(db, secondAccount);
    db.prepare("UPDATE sync_jobs SET started_at='2026-01-02 00:00:00' WHERE id=?").run(first.jobId);
    db.prepare("UPDATE sync_jobs SET started_at='2026-01-01 00:00:00' WHERE id=?").run(second.jobId);

    assert.equal(jobStore.findNextQueuedJob(db).id, second.jobId);
    db.prepare("UPDATE sync_jobs SET started_at='2026-01-01 00:00:00' WHERE id=?").run(first.jobId);
    assert.equal(jobStore.findNextQueuedJob(db).id, first.jobId);
  } finally {
    db.close();
  }
});

integrationTest('cancelQueuedJob validates account ownership and terminal state', () => {
  const db = createDatabase();
  try {
    const accountId = addAccount(db, 'owner');
    const otherAccountId = addAccount(db, 'other');
    const queued = jobStore.enqueueJob(db, accountId);

    assert.deepEqual(jobStore.cancelQueuedJob(db, queued.jobId, otherAccountId), {
      ok: false,
      reason: 'not_found',
    });
    assert.deepEqual(jobStore.cancelQueuedJob(db, queued.jobId, accountId), {
      ok: true,
      status: 'cancelled',
    });
    const row = db.prepare('SELECT status,finished_at FROM sync_jobs WHERE id=?').get(queued.jobId);
    assert.equal(row.status, 'cancelled');
    assert.ok(row.finished_at);
    assert.deepEqual(jobStore.cancelQueuedJob(db, queued.jobId, accountId), {
      ok: false,
      reason: 'not_cancellable',
    });
  } finally {
    db.close();
  }
});

integrationTest('retryJob preserves history and accepts every retryable terminal status', () => {
  const db = createDatabase();
  try {
    for (const status of jobStore.RETRYABLE_STATUSES) {
      const accountId = addAccount(db, status);
      const originalJobId = addFinishedJob(db, accountId, status);
      const result = jobStore.retryJob(db, originalJobId);
      assert.equal(result.ok, true, status);
      assert.notEqual(result.jobId, originalJobId, status);
      assert.equal(db.prepare('SELECT status FROM sync_jobs WHERE id=?').get(originalJobId).status, status);
      assert.equal(db.prepare('SELECT status FROM sync_jobs WHERE id=?').get(result.jobId).status, 'queued');
      assert.deepEqual(jobStore.retryJob(db, originalJobId), {
        ok: false,
        reason: 'already_running',
      });
    }

    const successAccount = addAccount(db, 'success');
    const successJob = addFinishedJob(db, successAccount, 'success');
    assert.deepEqual(jobStore.retryJob(db, successJob), {
      ok: false,
      reason: 'not_retryable',
    });
    assert.deepEqual(jobStore.retryJob(db, 999999), {
      ok: false,
      reason: 'not_found',
    });
  } finally {
    db.close();
  }
});

integrationTest('cancelAllQueued leaves running and completed jobs unchanged', () => {
  const db = createDatabase();
  try {
    const queuedAccount = addAccount(db, 'queued');
    const runningAccount = addAccount(db, 'running');
    const completedAccount = addAccount(db, 'completed');
    const queued = jobStore.enqueueJob(db, queuedAccount);
    const running = jobStore.enqueueJob(db, runningAccount);
    db.prepare("UPDATE sync_jobs SET status='running' WHERE id=?").run(running.jobId);
    const completed = addFinishedJob(db, completedAccount, 'success');

    assert.deepEqual(jobStore.cancelAllQueued(db), { cancelled: 1 });
    assert.equal(db.prepare('SELECT status FROM sync_jobs WHERE id=?').get(queued.jobId).status, 'cancelled');
    assert.equal(db.prepare('SELECT status FROM sync_jobs WHERE id=?').get(running.jobId).status, 'running');
    assert.equal(db.prepare('SELECT status FROM sync_jobs WHERE id=?').get(completed).status, 'success');
  } finally {
    db.close();
  }
});

integrationTest('restart reconciliation interrupts only running jobs and clears stale pids', () => {
  const db = createDatabase();
  try {
    const queuedAccount = addAccount(db, 'queued-restart');
    const runningAccount = addAccount(db, 'running-restart');
    const successAccount = addAccount(db, 'success-restart');
    const queued = jobStore.enqueueJob(db, queuedAccount);
    const running = jobStore.enqueueJob(db, runningAccount);
    db.prepare("UPDATE sync_jobs SET status='running', pid=4321 WHERE id=?").run(running.jobId);
    const success = addFinishedJob(db, successAccount, 'success');

    const stale = jobStore.reconcileRunningJobs(db);
    assert.deepEqual(stale.map((job) => job.id), [running.jobId]);
    const repaired = db.prepare('SELECT status,finished_at,pid FROM sync_jobs WHERE id=?').get(running.jobId);
    assert.equal(repaired.status, 'interrupted');
    assert.ok(repaired.finished_at);
    assert.equal(repaired.pid, null);
    assert.equal(db.prepare('SELECT status FROM sync_jobs WHERE id=?').get(queued.jobId).status, 'queued');
    assert.equal(db.prepare('SELECT status FROM sync_jobs WHERE id=?').get(success).status, 'success');
  } finally {
    db.close();
  }
});
