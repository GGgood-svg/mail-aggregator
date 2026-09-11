const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, DIRS } = require('./db');
const { ownerId, ownedAccount } = require('./access-control');
const { sendJobLog } = require('./log-reader');
const { getProvider, loadProviders } = require('./providers');
const { validateAccountPayload } = require('./account-validation');
const { registerMailboxOwnership } = require('./mailbox-ownership');
const { accountLimit } = require('./resource-limits');
const {
  saveSourceSecret,
  deleteSourceSecret,
  saveTargetSecret,
  hasSourceSecret,
  hasOAuthTokens,
  deleteOAuthTokens,
  deleteAccountSecrets,
  snapshotAccountSecrets,
  restoreAccountSecrets,
} = require('./credentials');
const {
  triggerSync,
  cancelJob,
  testConnection,
  isAccountLocked,
  hasActiveJob,
} = require('./sync');

const router = express.Router();

const PUBLIC_FIELDS = `
  id, name, provider, host, port, ssl, username, auth_type, enabled,
  sync_interval, local_user, sync_mode, destination_mode, destination_folder, mailbox_folder,
  folder_includes, folder_excludes, max_age_days, max_size_mb, deletion_mode,
  created_at, updated_at,
  last_sync_at, last_sync_status, last_sync_message,
  last_host2_messages, last_host2_folders, last_transferred, last_skipped, last_errors
`;

// null统一用N/A表示"没有可信数据",不能显示成0(0是一个真实的、有意义的值)
function naSafe(v) {
  return v === null || v === undefined ? 'N/A' : v;
}

function serializeAccount(row) {
  if (!row) return null;
  return {
    ...row,
    ssl: !!row.ssl,
    enabled: !!row.enabled,
    syncing: isAccountLocked(row.id),
    queued: !isAccountLocked(row.id) && hasActiveJob(row.id),
    hasSecret: row.auth_type === 'oauth2' ? hasOAuthTokens(row.id) : hasSourceSecret(row.id),
    oauthAuthorized: row.auth_type === 'oauth2' && hasOAuthTokens(row.id),
    // 前端展示用的N/A安全字段
    display: {
      totalMessages: naSafe(row.last_host2_messages),
      totalFolders: naSafe(row.last_host2_folders),
      lastTransferred: naSafe(row.last_transferred),
      lastSkipped: naSafe(row.last_skipped),
      lastErrors: naSafe(row.last_errors),
    },
  };
}

router.get('/providers', (req, res) => {
  res.json(loadProviders());
});

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM accounts WHERE owner_user_id=? ORDER BY id DESC`).all(ownerId(req));
  res.json(rows.map(serializeAccount));
});

router.get('/:id', (req, res) => {
  const row = db
    .prepare(`SELECT ${PUBLIC_FIELDS} FROM accounts WHERE id = ? AND owner_user_id=?`)
    .get(req.params.id, ownerId(req));
  if (!row) return res.status(404).json({ error: '账号不存在' });
  res.json(serializeAccount(row));
});

function validatePayload(body, {
  requireSecret,
  defaultLocalUser,
  defaultDestinationMode,
  defaultDestinationFolder,
  defaultSyncPolicy,
}) {
  return validateAccountPayload(body, {
    requireSecret,
    getProvider,
    defaultLocalUser: defaultLocalUser || require('./config').localDovecot().user,
    defaultDestinationMode,
    defaultDestinationFolder,
    defaultSyncPolicy,
  });
}

function destinationFolderInUse(account, accountOwnerId, excludeId = null) {
  if (account.destination_mode !== 'subfolder') return false;
  const params = [accountOwnerId, account.destination_folder];
  let sql = `SELECT 1 FROM accounts
    WHERE owner_user_id = ? AND destination_mode = 'subfolder'
      AND destination_folder = ? COLLATE NOCASE`;
  if (excludeId !== null) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  return !!db.prepare(sql).get(...params);
}

function restoreAccountConfiguration(account) {
  db.prepare(`UPDATE accounts SET
      name=@name, provider=@provider, host=@host, port=@port, ssl=@ssl,
      username=@username, auth_type=@auth_type, enabled=@enabled,
      sync_interval=@sync_interval, local_user=@local_user, sync_mode=@sync_mode,
      destination_mode=@destination_mode, destination_folder=@destination_folder,
      mailbox_folder=@mailbox_folder, folder_includes=@folder_includes,
      folder_excludes=@folder_excludes, max_age_days=@max_age_days,
      max_size_mb=@max_size_mb, deletion_mode=@deletion_mode, updated_at=@updated_at
    WHERE id=@id`).run(account);
}

router.post('/', (req, res) => {
  const { errors, normalized } = validatePayload(req.body || {}, { requireSecret: true });
  // 多用户共享同一个本地Dovecot时，flat会把不同用户的邮件混进公共根目录。
  // 新账号一律要求独立目标文件夹，旧版迁移账号仍可继续读取但不能新建flat。
  if (normalized.destination_mode !== 'subfolder') errors.push('多用户模式下新账号必须使用按账号文件夹隔离');
  const configuredLocalUser = require('./config').localDovecot().user;
  if (req.user.role !== 'admin' && normalized.local_user !== configuredLocalUser) {
    errors.push('普通用户不能修改本地Dovecot目标用户');
  }
  if (req.user.role !== 'admin' && req.body?.local_secret) errors.push('普通用户不能覆盖本地Dovecot密码');
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  if (destinationFolderInUse(normalized, ownerId(req))) {
    return res.status(409).json({ error: '你已有账号使用同名隔离文件夹，请换一个名称' });
  }
  const quota = accountLimit(db, ownerId(req));
  if (quota.count >= quota.maximum) {
    return res.status(409).json({ error: `每位用户最多可添加 ${quota.maximum} 个邮箱账号` });
  }

  const createAccount = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO accounts
        (name, provider, host, port, ssl, username, auth_type, enabled, sync_interval,
         local_user, sync_mode, destination_mode, destination_folder,
         folder_includes, folder_excludes, max_age_days, max_size_mb, deletion_mode, owner_user_id)
       VALUES (@name, @provider, @host, @port, @ssl, @username, @auth_type, @enabled,
         @sync_interval, @local_user, @sync_mode, @destination_mode, @destination_folder,
         @folder_includes, @folder_excludes, @max_age_days, @max_size_mb, @deletion_mode, @owner_user_id)`
    ).run({ ...normalized, owner_user_id: ownerId(req) });
    const accountId = Number(info.lastInsertRowid);
    // 实际Dovecot根目录不可由用户控制，避免用户把目录名伪造成INBOX或别人的根目录。
    const mailboxFolder = `U${ownerId(req)}-A${accountId}`;
    db.prepare('UPDATE accounts SET mailbox_folder=? WHERE id=?').run(mailboxFolder, accountId);
    registerMailboxOwnership(db, {
      localUser: normalized.local_user,
      mailboxFolder,
      ownerUserId: ownerId(req),
      accountId,
    });
    return accountId;
  });
  let accountId = null;
  try {
    accountId = createAccount();
    if (normalized.auth_type === 'password') saveSourceSecret(accountId, req.body.secret);
    if (req.body.local_secret) saveTargetSecret(accountId, req.body.local_secret);
  } catch (error) {
    if (accountId !== null) {
      try { deleteAccountSecrets(accountId); } catch (_) {}
      try {
        db.transaction(() => {
          db.prepare('DELETE FROM mailbox_ownership WHERE former_account_id=?').run(accountId);
          db.prepare('DELETE FROM accounts WHERE id=?').run(accountId);
        })();
      } catch (rollbackError) {
        console.error(`[accounts] 创建账号回滚失败: ${rollbackError.message}`);
      }
    }
    console.error(`[accounts] 创建账号失败: ${error.message}`);
    return res.status(500).json({ error: '保存账号或凭据失败，未创建账号，请检查磁盘和目录权限' });
  }

  res.status(201).json(
    serializeAccount(
      db.prepare(`SELECT ${PUBLIC_FIELDS} FROM accounts WHERE id = ? AND owner_user_id=?`).get(accountId, ownerId(req))
    )
  );
});

router.put('/:id', (req, res) => {
  const existing = ownedAccount(req, req.params.id);
  if (!existing) return res.status(404).json({ error: '账号不存在' });

  const { errors, normalized } = validatePayload(req.body || {}, {
    requireSecret: !hasSourceSecret(req.params.id),
    // 编辑页目前不展示local_user；请求未显式提交时必须保留账号原值，
    // 不能因为全局默认目标后来变化就悄悄覆盖已有账号。
    defaultLocalUser: existing.local_user,
    defaultDestinationMode: existing.destination_mode,
    defaultDestinationFolder: existing.destination_folder,
    defaultSyncPolicy: existing,
  });
  if (req.user.role !== 'admin' && normalized.local_user !== existing.local_user) {
    errors.push('普通用户不能修改本地Dovecot目标用户');
  }
  if (req.user.role !== 'admin' && req.body?.local_secret) errors.push('普通用户不能覆盖本地Dovecot密码');
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  if (destinationFolderInUse(normalized, ownerId(req), existing.id)) {
    return res.status(409).json({ error: '你已有账号使用同名隔离文件夹，请换一个名称' });
  }

  const destinationChanged = existing.destination_mode !== normalized.destination_mode
    || existing.destination_folder !== normalized.destination_folder;
  if (destinationChanged && (isAccountLocked(existing.id) || hasActiveJob(existing.id))) {
    return res.status(409).json({ error: '账号正在同步或排队中，结束任务后才能修改目标文件夹策略' });
  }
  const oauthIdentityChanged = existing.auth_type !== normalized.auth_type
    || existing.provider !== normalized.provider
    || existing.username !== normalized.username;
  if (oauthIdentityChanged && (isAccountLocked(existing.id) || hasActiveJob(existing.id))) {
    return res.status(409).json({ error: '账号正在同步或排队中，结束任务后才能修改认证身份' });
  }
  const syncPolicyChanged = existing.folder_includes !== normalized.folder_includes
    || existing.folder_excludes !== normalized.folder_excludes
    || existing.max_age_days !== normalized.max_age_days
    || existing.max_size_mb !== normalized.max_size_mb
    || existing.deletion_mode !== normalized.deletion_mode;
  if (syncPolicyChanged && (isAccountLocked(existing.id) || hasActiveJob(existing.id))) {
    return res.status(409).json({ error: '账号正在同步或排队中，结束任务后才能修改高级同步规则' });
  }

  let credentialSnapshot;
  try {
    credentialSnapshot = snapshotAccountSecrets(existing.id);
  } catch (error) {
    console.error(`[accounts] 无法读取账号 ${existing.id} 的凭据快照: ${error.message}`);
    return res.status(500).json({ error: '无法安全准备账号更新，请检查凭据目录权限' });
  }
  let ownershipCreated = false;

  try {
    db.prepare(
      `UPDATE accounts SET
        name=@name, provider=@provider, host=@host, port=@port, ssl=@ssl,
        username=@username, auth_type=@auth_type, enabled=@enabled,
        sync_interval=@sync_interval, local_user=@local_user, sync_mode=@sync_mode,
        destination_mode=@destination_mode, destination_folder=@destination_folder,
        folder_includes=@folder_includes, folder_excludes=@folder_excludes,
        max_age_days=@max_age_days, max_size_mb=@max_size_mb, deletion_mode=@deletion_mode,
        updated_at = datetime('now')
       WHERE id=@id`
    ).run({ ...normalized, id: req.params.id });
    if (normalized.destination_mode === 'subfolder' && !existing.mailbox_folder) {
      const mailboxFolder = `U${ownerId(req)}-A${existing.id}`;
      const assignMailbox = db.transaction(() => {
        db.prepare('UPDATE accounts SET mailbox_folder=? WHERE id=?')
          .run(mailboxFolder, existing.id);
        registerMailboxOwnership(db, {
          localUser: normalized.local_user,
          mailboxFolder,
          ownerUserId: ownerId(req),
          accountId: existing.id,
        });
      });
      assignMailbox();
      ownershipCreated = true;
    }

    if (destinationChanged) {
      // --useuid缓存与目标文件夹映射相关；切换落盘策略后必须重新建立映射。
      // 这里只删除可重建的cache，不碰已经同步到Maildir中的邮件。
      fs.rmSync(path.join(DIRS.cache, String(existing.id)), { recursive: true, force: true });
    }

    if (normalized.auth_type === 'password' && req.body.secret) saveSourceSecret(req.params.id, req.body.secret);
    if (normalized.auth_type === 'oauth2') {
      deleteSourceSecret(req.params.id);
      if (oauthIdentityChanged) deleteOAuthTokens(req.params.id);
    } else {
      deleteOAuthTokens(req.params.id);
    }
    if (req.body.local_secret) saveTargetSecret(req.params.id, req.body.local_secret);
  } catch (error) {
    try {
      db.transaction(() => {
        if (ownershipCreated) db.prepare('DELETE FROM mailbox_ownership WHERE former_account_id=?').run(existing.id);
        restoreAccountConfiguration(existing);
      })();
      restoreAccountSecrets(existing.id, credentialSnapshot);
    } catch (rollbackError) {
      console.error(`[accounts] 更新账号 ${existing.id} 回滚失败: ${rollbackError.message}`);
      return res.status(500).json({ error: '账号更新失败且自动回滚未完整完成，请立即检查系统日志' });
    }
    console.error(`[accounts] 更新账号 ${existing.id} 失败并已回滚: ${error.message}`);
    return res.status(500).json({ error: '保存账号或凭据失败，原配置已恢复' });
  }

  res.json(
    serializeAccount(
      db.prepare(`SELECT ${PUBLIC_FIELDS} FROM accounts WHERE id = ? AND owner_user_id=?`).get(req.params.id, ownerId(req))
    )
  );
});

router.delete('/:id', (req, res) => {
  const existing = ownedAccount(req, req.params.id);
  if (!existing) return res.status(404).json({ error: '账号不存在' });
  if (isAccountLocked(existing.id) || hasActiveJob(existing.id)) {
    return res.status(409).json({ error: '账号正在同步或排队中,请稍后再删除' });
  }

  const deleteCache = req.query.deleteCache === 'true';
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM sync_jobs WHERE account_id = ?').run(req.params.id);
  deleteAccountSecrets(req.params.id);

  if (deleteCache) {
    const cacheDir = path.join(DIRS.cache, String(req.params.id));
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  // 注意:默认不删除本地已同步的邮件，也不删除 mailbox_ownership。
  // 永久保留目录归属，避免账号配置删除后遗留邮件被管理员兼容权限接管。

  res.json({ ok: true });
});

router.post('/:id/test', async (req, res) => {
  const existing = ownedAccount(req, req.params.id);
  if (!existing) return res.status(404).json({ error: '账号不存在' });
  const result = await testConnection(req.params.id);
  res.json(result);
});

router.post('/:id/sync', (req, res) => {
  const existing = ownedAccount(req, req.params.id);
  if (!existing) return res.status(404).json({ error: '账号不存在' });
  const result = triggerSync(parseInt(req.params.id, 10));
  if (!result.ok && result.reason === 'already_running') {
    return res.status(409).json({ error: '当前账号正在同步或已在排队,请勿重复启动' });
  }
  if (!result.ok && result.reason === 'missing_credentials') {
    return res.status(409).json({ error: '账号尚未完成凭据配置或OAuth2授权' });
  }
  if (!result.ok && result.reason === 'maintenance') {
    return res.status(409).json({ error: '系统正在恢复，请稍后再启动同步' });
  }
  if (!result.ok && result.reason === 'low_disk') {
    return res.status(507).json({ error: '服务器可用磁盘空间不足，已停止启动新同步任务' });
  }
  if (!result.ok && result.reason === 'disk_check_failed') {
    return res.status(503).json({ error: '无法确认服务器剩余磁盘空间，已安全停止启动同步' });
  }
  res.json(result);
});

router.get('/:id/jobs', (req, res) => {
  if (!ownedAccount(req, req.params.id, 'id')) return res.status(404).json({ error: '账号不存在' });
  const rows = db
    .prepare(
      `SELECT * FROM sync_jobs WHERE account_id = ? ORDER BY started_at DESC LIMIT 30`
    )
    .all(req.params.id);
  res.json(rows);
});

router.post('/:id/jobs/:jobId/cancel', (req, res) => {
  if (!ownedAccount(req, req.params.id, 'id')) return res.status(404).json({ error: '账号不存在' });
  const result = cancelJob(req.params.jobId, req.params.id);
  if (!result.ok) {
    const messages = {
      not_found: '任务不存在，或不属于当前账号',
      not_owned: '运行任务不属于当前服务进程，无法安全停止；请重启服务完成状态恢复',
      already_stopping: '任务已经在停止中',
      not_cancellable: '该任务已经结束，无法取消',
    };
    return res.status(result.reason === 'not_found' ? 404 : 409)
      .json({ error: messages[result.reason] || '任务无法取消' });
  }
  res.json(result);
});

router.get('/:id/jobs/:jobId/log', (req, res) => {
  const job = db
    .prepare(`SELECT j.* FROM sync_jobs j JOIN accounts a ON a.id=j.account_id
      WHERE j.id=? AND j.account_id=? AND a.owner_user_id=?`)
    .get(req.params.jobId, req.params.id, ownerId(req));
  if (!job || !sendJobLog(res, DIRS.logs, job)) {
    return res.status(404).json({ error: '日志不存在' });
  }
});

module.exports = router;
