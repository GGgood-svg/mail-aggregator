const JOB_STATUSES = Object.freeze([
  'queued',
  'running',
  'success',
  'failed',
  'timed_out',
  'interrupted',
  'cancelled',
]);

function listJobs(db, { accountId = null, ownerUserId = null, status = null, page = 1, pageSize = 25 } = {}) {
  const clauses = [];
  const params = [];
  if (accountId !== null) {
    clauses.push('j.account_id = ?');
    params.push(accountId);
  }
  if (status !== null) {
    clauses.push('j.status = ?');
    params.push(status);
  }
  if (ownerUserId !== null) {
    clauses.push('a.owner_user_id = ?');
    params.push(ownerUserId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(
    `SELECT COUNT(*) AS total FROM sync_jobs j JOIN accounts a ON a.id=j.account_id ${where}`
  ).get(...params).total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const items = db.prepare(
    `SELECT j.*, a.name AS account_name FROM sync_jobs j
     JOIN accounts a ON a.id = j.account_id
     ${where}
     ORDER BY j.started_at DESC, j.id DESC
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  return {
    items,
    pagination: { page: safePage, pageSize, total, totalPages },
  };
}

module.exports = { JOB_STATUSES, listJobs };
