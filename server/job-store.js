const RETRYABLE_STATUSES = Object.freeze([
  'failed',
  'timed_out',
  'interrupted',
  'cancelled',
]);

function isUniqueActiveJobError(error) {
  return String(error && error.message).includes('UNIQUE constraint failed');
}

function hasActiveJob(db, accountId) {
  return !!db
    .prepare(
      `SELECT id FROM sync_jobs
       WHERE account_id = ? AND status IN ('queued','running') LIMIT 1`
    )
    .get(accountId);
}

function enqueueJob(db, accountId) {
  if (hasActiveJob(db, accountId)) {
    return { ok: false, reason: 'already_running' };
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO sync_jobs (account_id, started_at, status)
         VALUES (?, datetime('now'), 'queued')`
      )
      .run(accountId);
    return { ok: true, jobId: info.lastInsertRowid };
  } catch (error) {
    if (isUniqueActiveJobError(error)) {
      return { ok: false, reason: 'already_running' };
    }
    throw error;
  }
}

function findNextQueuedJob(db) {
  return db
    .prepare(
      `SELECT * FROM sync_jobs
       WHERE status = 'queued'
         AND account_id NOT IN (
           SELECT account_id FROM sync_jobs WHERE status = 'running'
         )
       ORDER BY started_at ASC, id ASC LIMIT 1`
    )
    .get();
}

function getJobForAccount(db, jobId, accountId) {
  return db
    .prepare('SELECT * FROM sync_jobs WHERE id = ? AND account_id = ?')
    .get(jobId, accountId);
}

function cancelQueuedJob(db, jobId, accountId) {
  const job = getJobForAccount(db, jobId, accountId);
  if (!job) return { ok: false, reason: 'not_found' };
  if (job.status !== 'queued') return { ok: false, reason: 'not_cancellable' };

  db.prepare(
    `UPDATE sync_jobs SET status='cancelled', finished_at=datetime('now')
     WHERE id=? AND status='queued'`
  ).run(jobId);
  return { ok: true, status: 'cancelled' };
}

function retryJob(db, jobId) {
  const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  if (!RETRYABLE_STATUSES.includes(job.status)) {
    return { ok: false, reason: 'not_retryable' };
  }
  return enqueueJob(db, job.account_id);
}

function cancelAllQueued(db) {
  const info = db
    .prepare(
      `UPDATE sync_jobs SET status='cancelled', finished_at=datetime('now')
       WHERE status='queued'`
    )
    .run();
  return { cancelled: info.changes };
}

function reconcileRunningJobs(db) {
  const jobs = db.prepare("SELECT * FROM sync_jobs WHERE status='running' ORDER BY id").all();
  if (jobs.length) {
    db.prepare(
      `UPDATE sync_jobs SET status='interrupted', finished_at=datetime('now'), pid=NULL
       WHERE status='running'`
    ).run();
  }
  return jobs;
}

module.exports = {
  RETRYABLE_STATUSES,
  hasActiveJob,
  enqueueJob,
  findNextQueuedJob,
  getJobForAccount,
  cancelQueuedJob,
  retryJob,
  cancelAllQueued,
  reconcileRunningJobs,
};
