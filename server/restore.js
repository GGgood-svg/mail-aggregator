const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { copySecrets } = require('./backup');

const REQUIRED_SOURCE_TABLES = ['accounts', 'settings'];
const PRESERVED_SETTING_KEYS = new Set([
  'dovecot_user',
  'dovecot_target_user',
  'dovecot_host',
  'dovecot_port',
  'dovecot_using_default_password',
  'dovecot_last_known_hash',
  'web_port',
  'oauth_public_base_url',
]);
const MAX_WEB_RESTORE_UPLOAD = 512 * 1024 * 1024;
const MAX_WEB_RESTORE_EXPANDED = 1024 * 1024 * 1024;

function receiveArchive(req, destination, maxBytes = MAX_WEB_RESTORE_UPLOAD) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(Object.assign(new Error('备份压缩包超过512 MiB上传上限'), { statusCode: 413 }));
      return;
    }
    const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    let bytes = 0;
    let failed = false;

    function fail(error) {
      if (failed) return;
      failed = true;
      output.destroy();
      fs.rmSync(destination, { force: true });
      reject(error);
    }
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(Object.assign(new Error('备份压缩包超过512 MiB上传上限'), { statusCode: 413 }));
        return;
      }
      if (!failed && !output.write(chunk)) req.pause(), output.once('drain', () => req.resume());
    });
    req.once('aborted', () => fail(new Error('备份上传中断')));
    req.once('error', fail);
    output.once('error', fail);
    req.once('end', () => {
      if (failed) return;
      output.end(() => {
        if (bytes === 0) fail(new Error('没有收到备份文件'));
        else resolve(bytes);
      });
    });
  });
}

function extractVerifiedArchive(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn('tar', [
      '-xzf', archivePath,
      '-C', destination,
      '--no-same-owner',
      '--no-same-permissions',
    ], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`备份解压失败${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

function tableExists(database, table) {
  return !!database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table);
}

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function inspectRestoreDatabase(Database, databasePath) {
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const quick = source.prepare('PRAGMA quick_check').get();
    if (!quick || String(Object.values(quick)[0]).toLowerCase() !== 'ok') {
      throw new Error('备份中的SQLite数据库完整性检查失败');
    }
    for (const table of REQUIRED_SOURCE_TABLES) {
      if (!tableExists(source, table)) throw new Error(`备份数据库缺少必要表: ${table}`);
    }
    return {
      accountCount: source.prepare('SELECT COUNT(*) AS count FROM accounts').get().count,
      jobCount: tableExists(source, 'sync_jobs')
        ? source.prepare('SELECT COUNT(*) AS count FROM sync_jobs').get().count
        : 0,
      settingCount: source.prepare('SELECT COUNT(*) AS count FROM settings').get().count,
    };
  } finally {
    source.close();
  }
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('数据库字段名称不安全');
  return `"${value}"`;
}

function copyTableRows(current, source, table, { transform } = {}) {
  if (!tableExists(source, table) || !tableExists(current, table)) return 0;
  const currentColumns = new Set(tableColumns(current, table));
  const columns = tableColumns(source, table).filter((column) => currentColumns.has(column));
  if (!columns.length) return 0;
  const names = columns.map(quoteIdentifier).join(', ');
  const placeholders = columns.map((column) => `@${column}`).join(', ');
  const insert = current.prepare(`INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${placeholders})`);
  let count = 0;
  for (const original of source.prepare(`SELECT ${names} FROM ${quoteIdentifier(table)}`).iterate()) {
    const row = transform ? transform({ ...original }) : original;
    const values = {};
    for (const column of columns) values[column] = row[column];
    insert.run(values);
    count++;
  }
  return count;
}

function mergeSettings(current, source) {
  const upsert = current.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  let count = 0;
  for (const row of source.prepare('SELECT key, value FROM settings').iterate()) {
    if (PRESERVED_SETTING_KEYS.has(row.key)) continue;
    upsert.run(row.key, row.value);
    count++;
  }
  return count;
}

function removeTargetPasswordOverrides(directory) {
  if (!fs.existsSync(directory)) return 0;
  let removed = 0;
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name === 'target.pass') {
        fs.rmSync(absolute, { force: true });
        removed++;
      }
    }
  }
  visit(directory);
  return removed;
}

function prepareRestoredSecrets(backupSecretsDir, currentSecretsDir, preparedDir) {
  fs.rmSync(preparedDir, { recursive: true, force: true });
  copySecrets(backupSecretsDir, preparedDir);
  const skippedTargetOverrides = removeTargetPasswordOverrides(preparedDir);
  const restoredGlobal = path.join(preparedDir, 'local-target.pass');
  fs.rmSync(restoredGlobal, { force: true });
  const currentGlobal = path.join(currentSecretsDir, 'local-target.pass');
  if (fs.existsSync(currentGlobal) && fs.lstatSync(currentGlobal).isFile()) {
    fs.copyFileSync(currentGlobal, restoredGlobal);
    fs.chmodSync(restoredGlobal, 0o600);
  }
  return { skippedTargetOverrides };
}

function restoreApplicationState({ Database, currentDb, backupDbPath, currentSecretsDir, backupSecretsDir, workDir }) {
  const { registerMailboxOwnership } = require('./mailbox-ownership');
  const source = new Database(backupDbPath, { readonly: true, fileMustExist: true });
  const preparedSecrets = path.join(workDir, 'prepared-secrets');
  const oldSecrets = path.join(workDir, 'old-secrets');
  let secretsSwapped = false;
  let currentSecretsMoved = false;
  let transactionCommitted = false;
  try {
    const secretResult = prepareRestoredSecrets(backupSecretsDir, currentSecretsDir, preparedSecrets);
    const localUserRow = currentDb.prepare("SELECT value FROM settings WHERE key='dovecot_user'").get();
    const currentLocalUser = localUserRow ? localUserRow.value : 'mailuser';
    const currentAdminColumns = new Set(tableColumns(currentDb, 'admin_users'));
    const fallbackOwner = currentAdminColumns.has('mail_access_all')
      ? currentDb.prepare('SELECT id FROM admin_users ORDER BY mail_access_all DESC, id LIMIT 1').get()
      : currentDb.prepare('SELECT id FROM admin_users ORDER BY id LIMIT 1').get();
    // A backup may come from another installation where numeric user IDs refer
    // to entirely different people. Map owners only through stable usernames;
    // unmatched/legacy owners fall back to the current primary administrator.
    const currentUsersByName = new Map(currentDb.prepare('SELECT id,username FROM admin_users').all()
      .map((row) => [String(row.username), Number(row.id)]));
    const restoredOwnerIds = new Map();
    if (tableExists(source, 'admin_users')
        && tableColumns(source, 'admin_users').includes('username')) {
      for (const row of source.prepare('SELECT id,username FROM admin_users').iterate()) {
        const currentId = currentUsersByName.get(String(row.username));
        if (currentId !== undefined) restoredOwnerIds.set(Number(row.id), currentId);
      }
    }
    const restore = currentDb.transaction(() => {
      currentDb.prepare('DELETE FROM notification_events').run();
      currentDb.prepare('DELETE FROM sync_jobs').run();
      currentDb.prepare('DELETE FROM accounts').run();

      const accounts = copyTableRows(currentDb, source, 'accounts', {
        transform(row) {
          if (Object.prototype.hasOwnProperty.call(row, 'local_user')) row.local_user = currentLocalUser;
          if (Object.prototype.hasOwnProperty.call(row, 'owner_user_id')) {
            row.owner_user_id = restoredOwnerIds.get(Number(row.owner_user_id))
              || (fallbackOwner ? fallbackOwner.id : null);
          }
          return row;
        },
      });
      if (fallbackOwner && tableColumns(currentDb, 'accounts').includes('owner_user_id')) {
        currentDb.prepare('UPDATE accounts SET owner_user_id=? WHERE owner_user_id IS NULL').run(fallbackOwner.id);
      }
      if (tableColumns(currentDb, 'accounts').includes('mailbox_folder')) {
        currentDb.prepare(`UPDATE accounts SET mailbox_folder=destination_folder
          WHERE mailbox_folder IS NULL AND destination_mode='subfolder'`).run();
      }
      const accountColumns = new Set(tableColumns(currentDb, 'accounts'));
      if (tableExists(currentDb, 'mailbox_ownership')
          && ['local_user', 'mailbox_folder', 'owner_user_id'].every((name) => accountColumns.has(name))) {
        for (const account of currentDb.prepare(`SELECT id, local_user, mailbox_folder, owner_user_id
          FROM accounts WHERE destination_mode='subfolder' AND mailbox_folder IS NOT NULL
            AND owner_user_id IS NOT NULL`).iterate()) {
          registerMailboxOwnership(currentDb, {
            localUser: account.local_user,
            mailboxFolder: account.mailbox_folder,
            ownerUserId: account.owner_user_id,
            accountId: account.id,
          });
        }
      }
      const now = new Date().toISOString();
      const jobs = copyTableRows(currentDb, source, 'sync_jobs', {
        transform(row) {
          if (row.status === 'queued' || row.status === 'running') {
            row.status = 'interrupted';
            row.finished_at = now;
            row.pid = null;
          }
          return row;
        },
      });
      const notifications = copyTableRows(currentDb, source, 'notification_events');
      const settings = mergeSettings(currentDb, source);

      fs.renameSync(currentSecretsDir, oldSecrets);
      currentSecretsMoved = true;
      fs.renameSync(preparedSecrets, currentSecretsDir);
      secretsSwapped = true;
      return { accounts, jobs, notifications, settings, ...secretResult };
    });
    const result = restore();
    transactionCommitted = true;
    try { fs.rmSync(oldSecrets, { recursive: true, force: true }); } catch (_) {}
    return result;
  } catch (error) {
    if (currentSecretsMoved && !transactionCommitted) {
      try {
        if (secretsSwapped) fs.rmSync(currentSecretsDir, { recursive: true, force: true });
        fs.renameSync(oldSecrets, currentSecretsDir);
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    source.close();
  }
}

function cleanupOldRestorePoints(directory, nowMs = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  if (!fs.existsSync(directory)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^pre-restore-.*\.(?:tar\.gz|sha256)$/.test(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (nowMs - fs.statSync(target).mtimeMs < maxAgeMs) continue;
    fs.rmSync(target, { force: true });
    removed++;
  }
  return removed;
}

function cleanupStaleRestoreWorkdirs(tmpDir, nowMs = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!fs.existsSync(tmpDir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('web-restore-')) continue;
    const target = path.join(tmpDir, entry.name);
    try {
      if (nowMs - fs.statSync(target).mtimeMs < maxAgeMs) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed++;
    } catch (_) {}
  }
  return removed;
}

module.exports = {
  MAX_WEB_RESTORE_UPLOAD,
  MAX_WEB_RESTORE_EXPANDED,
  receiveArchive,
  extractVerifiedArchive,
  inspectRestoreDatabase,
  prepareRestoredSecrets,
  restoreApplicationState,
  cleanupOldRestorePoints,
  cleanupStaleRestoreWorkdirs,
};
