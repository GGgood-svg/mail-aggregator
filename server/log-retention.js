const fs = require('fs');
const path = require('path');

const ACTIVE_STATUSES = Object.freeze(['queued', 'running']);

function formatSqliteUtc(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 19).replace('T', ' ');
}

function managedLogPath(logDir, job) {
  if (!job.log_file) return null;
  const expected = path.resolve(logDir, `job-${job.id}.log`);
  return path.resolve(job.log_file) === expected ? expected : null;
}

function removeJobs(db, logDir, jobs) {
  const removeRow = db.prepare('DELETE FROM sync_jobs WHERE id = ?');
  let deletedJobs = 0;
  let deletedFiles = 0;
  const errors = [];

  for (const job of jobs) {
    const logPath = managedLogPath(logDir, job);
    try {
      if (logPath && fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
        deletedFiles++;
      }
      removeRow.run(job.id);
      deletedJobs++;
    } catch (error) {
      errors.push({ jobId: job.id, message: error.message });
    }
  }
  return { deletedJobs, deletedFiles, errors };
}

function removeOrphanLogs(db, logDir, cutoffMs) {
  const referenced = new Set(
    db.prepare('SELECT id FROM sync_jobs').all().map((row) => Number(row.id))
  );
  let deletedOrphanFiles = 0;
  const errors = [];

  for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
    const match = /^job-(\d+)\.log$/.exec(entry.name);
    if (!entry.isFile() || !match || referenced.has(Number(match[1]))) continue;
    const filePath = path.join(logDir, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs >= cutoffMs) continue;
      fs.unlinkSync(filePath);
      deletedOrphanFiles++;
    } catch (error) {
      errors.push({ file: entry.name, message: error.message });
    }
  }
  return { deletedOrphanFiles, errors };
}

function cleanupExpired(db, logDir, retentionDays, nowMs = Date.now()) {
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = formatSqliteUtc(cutoffMs);
  const jobs = db.prepare(
    `SELECT id, log_file FROM sync_jobs
     WHERE status NOT IN ('queued', 'running')
       AND COALESCE(finished_at, started_at) < ?
     ORDER BY id`
  ).all(cutoff);
  const removed = removeJobs(db, logDir, jobs);
  const orphans = removeOrphanLogs(db, logDir, cutoffMs);
  return {
    ...removed,
    deletedOrphanFiles: orphans.deletedOrphanFiles,
    errors: [...removed.errors, ...orphans.errors],
  };
}

function cleanupKeepLatest(db, logDir, keep) {
  const accounts = db.prepare('SELECT id FROM accounts').all();
  const jobs = [];
  const selectOld = db.prepare(
    `SELECT id, log_file FROM sync_jobs
     WHERE account_id = ? AND status NOT IN ('queued', 'running')
     ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?`
  );
  for (const account of accounts) jobs.push(...selectOld.all(account.id, keep));
  return removeJobs(db, logDir, jobs);
}

module.exports = {
  ACTIVE_STATUSES,
  formatSqliteUtc,
  managedLogPath,
  cleanupExpired,
  cleanupKeepLatest,
};
