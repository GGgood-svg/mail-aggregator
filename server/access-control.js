const { db } = require('./db');

function ownerId(req) {
  return Number(req.user && req.user.id);
}

function ownedAccount(req, accountId, fields = '*') {
  const projection = fields === 'id' ? 'id' : '*';
  return db.prepare(`SELECT ${projection} FROM accounts WHERE id=? AND owner_user_id=?`)
    .get(accountId, ownerId(req));
}

function ownedJob(req, jobId) {
  return db.prepare(`SELECT j.* FROM sync_jobs j JOIN accounts a ON a.id=j.account_id
    WHERE j.id=? AND a.owner_user_id=?`).get(jobId, ownerId(req));
}

function requireOwnedAccount(req, res, next) {
  const account = ownedAccount(req, req.params.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });
  req.account = account;
  next();
}

module.exports = { ownerId, ownedAccount, ownedJob, requireOwnedAccount };
