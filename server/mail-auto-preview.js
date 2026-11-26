'use strict';

const { labelAccount } = require('./mail-labels');
const { mailError } = require('./mail-tools');

const MAX_PENDING = 128;
const MAX_AGE = 24 * 60 * 60 * 1000;
const RETRY_MS = 15_000;
const POLL_MS = 5_000;
const revoked = text => Object.assign(mailError(text, 409), { code: 'AUTO_PREVIEW_REVOKED' });
const within = (folder, root) => folder === root || folder.startsWith(`${root}.`) || folder.startsWith(`${root}/`);

function supportsAutomaticPreviews(db) {
  const has = (table, columns) => {
    const fields = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
    return columns.every(column => fields.has(column));
  };
  return has('accounts', ['id','owner_user_id','local_user','mailbox_folder','destination_mode','enabled','last_finished_job_id','last_sync_status'])
    && has('admin_users', ['id','enabled']) && has('mailbox_ownership', ['local_user','mailbox_folder','owner_user_id','former_account_id'])
    && has('sync_jobs', ['id','account_id','status','result_known','transfer_started_at']);
}

function initializeAutomaticPreviews(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_auto_preview_pending (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    owner_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL, after_rule_id INTEGER NOT NULL DEFAULT 0,
    received_at INTEGER NOT NULL, ready_at INTEGER NOT NULL DEFAULT 0
  );`);
  if (!supportsAutomaticPreviews(db)) return false;
  db.exec(`CREATE TRIGGER IF NOT EXISTS mail_auto_preview_sync_success AFTER UPDATE OF last_finished_job_id ON accounts
  WHEN NEW.last_finished_job_id > COALESCE(OLD.last_finished_job_id,0)
    AND NEW.last_sync_status='success' AND NEW.enabled=1 AND NEW.destination_mode='subfolder'
    AND EXISTS(SELECT 1 FROM admin_users WHERE id=NEW.owner_user_id AND enabled=1)
    AND EXISTS(SELECT 1 FROM mailbox_ownership WHERE owner_user_id=NEW.owner_user_id AND local_user=NEW.local_user
      AND mailbox_folder=NEW.mailbox_folder COLLATE NOCASE AND former_account_id=NEW.id)
    AND EXISTS(SELECT 1 FROM sync_jobs WHERE id=NEW.last_finished_job_id AND account_id=NEW.id
      AND status='success' AND result_known=1 AND transfer_started_at IS NOT NULL)
    AND EXISTS(SELECT 1 FROM mail_rules WHERE owner_user_id=NEW.owner_user_id AND auto_after_job_id < NEW.last_finished_job_id
      AND (scope='all' OR folder=NEW.mailbox_folder OR substr(folder,1,length(NEW.mailbox_folder)+1) IN (NEW.mailbox_folder||'.',NEW.mailbox_folder||'/')))
  BEGIN
    DELETE FROM mail_auto_preview_pending WHERE received_at <= CAST(unixepoch('subsec')*1000 AS INTEGER) - ${MAX_AGE};
    INSERT INTO mail_auto_preview_pending(account_id,owner_user_id,job_id,received_at)
    SELECT NEW.id,NEW.owner_user_id,NEW.last_finished_job_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
    WHERE EXISTS(SELECT 1 FROM mail_auto_preview_pending WHERE account_id=NEW.id)
      OR (SELECT COUNT(*) FROM mail_auto_preview_pending)<${MAX_PENDING}
    ON CONFLICT(account_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,job_id=excluded.job_id,
      received_at=excluded.received_at,after_rule_id=0,ready_at=0 WHERE excluded.job_id>mail_auto_preview_pending.job_id;
  END;`);
  return true;
}

function autoPreviewFloor(db, enabled) {
  if (!enabled) return null;
  if (!supportsAutomaticPreviews(db)) throw mailError('同步后自动预览暂时不可用', 409);
  return db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM sync_jobs').get().id;
}

function currentAccount(db, owner, accountId, localUser, folder) {
  const account = db.prepare(`SELECT a.id,a.local_user,a.mailbox_folder AS root FROM accounts a JOIN admin_users u ON u.id=a.owner_user_id
    WHERE a.id=? AND a.owner_user_id=? AND u.enabled=1 AND a.enabled=1 AND a.destination_mode='subfolder' AND a.local_user=?`)
    .get(accountId, owner, localUser);
  if (!account?.root || labelAccount(db, owner, localUser, account.root)?.id !== account.id
    || (folder && (!within(folder, account.root) || labelAccount(db, owner, localUser, folder)?.id !== account.id))) {
    throw revoked('自动预览的账号已不可用');
  }
  return account;
}

function automaticScope(db, source, localUser, folder) {
  const account = currentAccount(db, source.owner, source.accountId, localUser, folder);
  if (account.root !== source.root) throw revoked('自动预览的账号已不可用');
  const rule = db.prepare('SELECT * FROM mail_rules WHERE id=? AND owner_user_id=? AND revision=? AND auto_after_job_id<?')
    .get(source.ruleId, source.owner, source.revision, source.jobId);
  if (!rule || (rule.scope === 'folder' && (!within(rule.folder, account.root) || (folder && folder !== rule.folder)))) {
    throw revoked('已关闭自动预览或规则已修改');
  }
  return rule.scope === 'folder' ? rule.folder : account.root;
}

function takeNext(db, now, localUser, create) {
  const pending = db.prepare('SELECT * FROM mail_auto_preview_pending WHERE ready_at<=? ORDER BY received_at,account_id LIMIT 1').get(now);
  if (!pending) return;
  const remove = () => db.prepare('DELETE FROM mail_auto_preview_pending WHERE account_id=? AND job_id=?').run(pending.account_id, pending.job_id);
  if (now - pending.received_at >= MAX_AGE) return remove();
  let account;
  try { account = currentAccount(db, pending.owner_user_id, pending.account_id, localUser); }
  catch (error) { if (error.statusCode === 409) return remove(); throw error; }
  const rule = db.prepare(`SELECT * FROM mail_rules WHERE owner_user_id=? AND id>? AND auto_after_job_id<?
    AND (scope='all' OR folder=? OR substr(folder,1,length(?)+1) IN (?||'.',?||'/')) ORDER BY id LIMIT 1`)
    .get(pending.owner_user_id, pending.after_rule_id, pending.job_id, account.root, account.root, account.root, account.root);
  if (!rule) return remove();
  const source = { accountId: account.id, owner: pending.owner_user_id, jobId: pending.job_id, root: account.root, ruleId: rule.id, revision: rule.revision };
  try { create(rule, source); }
  catch (error) {
    if ([429,503].includes(error.statusCode)) {
      db.prepare('UPDATE mail_auto_preview_pending SET ready_at=? WHERE account_id=? AND job_id=?').run(now + RETRY_MS, account.id, source.jobId);
      return;
    }
    if (![401,403,404,409].includes(error.statusCode)) throw error;
  }
  db.prepare('UPDATE mail_auto_preview_pending SET after_rule_id=? WHERE account_id=? AND job_id=?').run(rule.id, account.id, source.jobId);
}

module.exports = { initializeAutomaticPreviews, supportsAutomaticPreviews, autoPreviewFloor, automaticScope, currentAccount, takeNext, POLL_MS, MAX_PENDING };
