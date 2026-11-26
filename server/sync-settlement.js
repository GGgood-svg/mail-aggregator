'use strict';

const TERMINAL = new Set(['success', 'failed', 'timed_out', 'interrupted', 'cancelled']);
const ISO = () => new Date().toISOString();

// SQLite owns terminal result, aggregates and notification intent. The caller
// may perform network delivery only after this transaction has committed.
function settleSyncJob(db, jobId, accountId, result, recordIntent = null) {
  const { status, exitCode = null, durationMs = null, message = null, logFile = null, summary = {} } = result;
  if (!TERMINAL.has(status)) throw new Error('Invalid terminal sync status');
  const category = result.category || (status === 'timed_out' ? 'timeout' : status === 'failed' ? 'unknown' : null);
  const now = result.finishedAt || ISO();
  const legacyTime = now.replace('T', ' ').slice(0, 19);
  const expected = result.expected || 'running';
  if (!['queued', 'running'].includes(expected)) throw new Error('Invalid expected sync status');
  return db.transaction(() => {
    const job = db.prepare('SELECT * FROM sync_jobs WHERE id=? AND account_id=?').get(jobId, accountId);
    if (!job || job.status !== expected) return { applied: false, status: job?.status || null };
    const actualAttempt = Boolean(job.transfer_started_at);
    const mayHaveTransferred = job.transport_state !== 'unreleased';
    const mirror = job.mirror_at_release === 1;
    const known = !mayHaveTransferred || (result.resultKnown ?? (status !== 'interrupted' && !(status === 'cancelled' && mirror)));
    const stage = result.stage || (actualAttempt ? 'transfer' : expected === 'queued' ? 'queued' : 'preparing');
    const code = !known && status === 'cancelled' ? 'confirm_unknown_result' : result.code || category || status;
    const outcomeMessage = !known && status === 'cancelled' ? '镜像任务已停止，结果待核对；确认前不会重试' : message;
    const stats = [summary.host2Messages ?? null, summary.host2Folders ?? null,
      summary.messagesTransferred ?? null, summary.messagesSkipped ?? null, summary.errors ?? null];
    const done = db.prepare(`UPDATE sync_jobs SET status=?, finished_at=?, exit_code=?, duration_ms=?, pid=NULL,
      pid_identity=NULL, stage=?, result_code=?, result_known=?, result_message=?, next_attempt_at=NULL,
      host1_messages=?, host2_messages=?, host1_folders=?, host2_folders=?, messages_transferred=?, messages_skipped=?, errors=?,
      log_file=COALESCE(?,log_file) WHERE id=? AND account_id=? AND status=?`)
      .run(status, legacyTime, exitCode, durationMs, stage, code, known ? 1 : 0, outcomeMessage,
        summary.host1Messages ?? null, stats[0], summary.host1Folders ?? null, stats[1], ...stats.slice(2), logFile, jobId, accountId, expected);
    // Kept separate from successful/attempted timestamps: a cancelled row in
    // history must never claim that the mail was checked or synchronized.
    if (done.changes !== 1) return { applied: false, status: job.status };
    if (status === 'cancelled' && known) return { applied: true, status };
    const countFailure = actualAttempt && ['failed', 'timed_out'].includes(status);
    const completed = status === 'success' && known;
    const changed = db.prepare(`UPDATE accounts SET last_sync_at=?, last_sync_status=?, last_sync_message=?, last_sync_category=?,
      last_finished_job_id=?, sync_result_unknown=CASE WHEN ? THEN 1 WHEN ? THEN 0 ELSE sync_result_unknown END,
      sync_review_required=CASE WHEN ? THEN 1 WHEN ? THEN 0 ELSE sync_review_required END,
      last_sync_success_at=CASE WHEN ? THEN ? ELSE last_sync_success_at END,
      sync_failure_count=CASE WHEN ? THEN 0 WHEN ? THEN MIN(COALESCE(sync_failure_count,0)+1,30) ELSE sync_failure_count END,
      last_host2_messages=COALESCE(?,last_host2_messages), last_host2_folders=COALESCE(?,last_host2_folders),
      last_transferred=COALESCE(?,last_transferred), last_skipped=COALESCE(?,last_skipped), last_errors=COALESCE(?,last_errors)
      WHERE id=? AND (last_finished_job_id IS NULL OR last_finished_job_id < ?)`)
      .run(legacyTime, status, outcomeMessage, category, jobId, known ? 0 : 1, completed ? 1 : 0,
        !known && mirror ? 1 : 0, completed ? 1 : 0, completed ? 1 : 0, now, completed ? 1 : 0, countFailure ? 1 : 0, ...stats, accountId, jobId);
    const kind = completed ? 'recovery' : known && ['failed', 'timed_out'].includes(status) ? 'failure' : null;
    const intent = changed.changes === 1 && kind ? { accountId, jobId, kind, category, occurredAt: now } : null;
    if (intent && recordIntent) recordIntent(db, intent);
    return { applied: true, status, intent };
  })();
}

function markSyncTransferStarted(db, jobId, accountId, { pid, pidIdentity, logFile, mirror = false, now = ISO() }) {
  return db.transaction(() => {
    const result = db.prepare(`UPDATE sync_jobs SET pid=?,pid_identity=?,log_file=?,stage='transfer',transfer_started_at=?,transport_state='released',mirror_at_release=?
      WHERE id=? AND account_id=? AND status='running' AND transfer_started_at IS NULL`)
      .run(pid, pidIdentity, logFile, now, mirror ? 1 : 0, jobId, accountId);
    if (result.changes === 1) db.prepare(`UPDATE accounts SET last_sync_attempt_at=?,sync_block_code=NULL,sync_block_since=NULL,sync_block_scope=NULL,
      sync_next_retry_at=NULL WHERE id=?`).run(now, accountId);
    return result.changes === 1;
  })();
}

module.exports = { settleSyncJob, markSyncTransferStarted };
