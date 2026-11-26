const { settleSyncJob } = require('./sync-settlement');

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

function enqueueJob(db, accountId, triggerSource = 'manual') {
  if (hasActiveJob(db, accountId)) {
    return { ok: false, reason: 'already_running' };
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO sync_jobs (account_id, started_at, status, trigger_source, transport_state)
         VALUES (?, datetime('now'), 'queued', ?, 'unreleased')`
      )
      .run(accountId, triggerSource);
    return { ok: true, jobId: info.lastInsertRowid };
  } catch (error) {
    if (isUniqueActiveJobError(error)) {
      return { ok: false, reason: 'already_running' };
    }
    throw error;
  }
}

function findNextQueuedJob(db, now = new Date().toISOString()) {
  return db
    .prepare(
      `SELECT * FROM sync_jobs
       WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND account_id NOT IN (
           SELECT account_id FROM sync_jobs WHERE status = 'running'
         )
       ORDER BY started_at ASC, id ASC LIMIT 1`
    )
    .get(now);
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

  const result = settleSyncJob(db, jobId, accountId, { status: 'cancelled', expected: 'queued', code: 'cancelled' });
  return result.applied ? { ok: true, status: 'cancelled' } : { ok: false, reason: 'not_cancellable' };
}

function retryJob(db, jobId) {
  const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  if (!RETRYABLE_STATUSES.includes(job.status)) {
    return { ok: false, reason: 'not_retryable' };
  }
  return enqueueJob(db, job.account_id, 'retry');
}

function cancelAllQueued(db, ownerUserId = null) {
  const jobs = ownerUserId === null
    ? db.prepare("SELECT id,account_id FROM sync_jobs WHERE status='queued'").all()
    : db.prepare(`SELECT j.id,j.account_id FROM sync_jobs j JOIN accounts a ON a.id=j.account_id
        WHERE j.status='queued' AND a.owner_user_id=?`).all(ownerUserId);
  let cancelled = 0;
  for (const job of jobs) if (cancelQueuedJob(db, job.id, job.account_id).ok) cancelled++;
  return { cancelled };
}

function reconcileRunningJobs(db, canSettle = () => true) {
  const jobs = db.prepare("SELECT * FROM sync_jobs WHERE status='running' ORDER BY id").all();
  return jobs.filter(job => {
    if (!canSettle(job)) return false;
    if (job.transport_state === 'unreleased') {
      if (job.stage === 'cancelling') return settleSyncJob(db, job.id, job.account_id, { status: 'cancelled',
        code: 'cancelled', message: '同步已取消，邮件传输尚未放行' }).applied;
      return db.prepare(`UPDATE sync_jobs SET status='queued',stage=NULL,pid=NULL,pid_identity=NULL,result_code=NULL,
        next_attempt_at=NULL WHERE id=? AND status='running' AND transport_state='unreleased'`).run(job.id).changes === 1;
    }
    return settleSyncJob(db, job.id, job.account_id, { status: 'interrupted', code: 'restart_unknown',
      message: '服务重启，任务结果未确认，请核对后再重试' }).applied;
  });
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
