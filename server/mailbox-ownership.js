'use strict';

function normalizeMailboxFolder(value) {
  return String(value || '').trim();
}

function registerMailboxOwnership(database, {
  localUser,
  mailboxFolder,
  ownerUserId,
  accountId = null,
}) {
  const user = String(localUser || '').trim();
  const folder = normalizeMailboxFolder(mailboxFolder);
  const owner = Number(ownerUserId);
  if (!user || !folder || !Number.isInteger(owner) || owner <= 0) {
    throw new Error('邮箱目录归属信息不完整');
  }

  const existing = database.prepare(`SELECT owner_user_id FROM mailbox_ownership
    WHERE local_user=? AND mailbox_folder=? COLLATE NOCASE`).get(user, folder);
  if (existing && Number(existing.owner_user_id) !== owner) {
    throw new Error(`邮箱目录 ${folder} 已归属于其他用户`);
  }

  database.prepare(`INSERT INTO mailbox_ownership
      (local_user, mailbox_folder, owner_user_id, former_account_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(local_user, mailbox_folder) DO UPDATE SET
      former_account_id=COALESCE(excluded.former_account_id, mailbox_ownership.former_account_id)`)
    .run(user, folder, owner, accountId === null ? null : Number(accountId));
}

module.exports = { registerMailboxOwnership };
