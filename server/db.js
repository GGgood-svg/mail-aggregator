const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT_DIR = process.env.MAIL_AGG_DATA_DIR || path.join(__dirname, '..', 'data');

// v0.1.1: 按spec建议的目录结构拆分,而不是把所有东西堆在同一层
const DIRS = {
  root: ROOT_DIR,
  db: path.join(ROOT_DIR, 'db'),
  secrets: path.join(ROOT_DIR, 'secrets'),
  cache: path.join(ROOT_DIR, 'cache'),
  logs: path.join(ROOT_DIR, 'logs'),
  tmp: path.join(ROOT_DIR, 'tmp'),
  restorePoints: path.join(ROOT_DIR, 'restore-points'),
};

for (const dir of Object.values(DIRS)) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const DB_PATH = path.join(DIRS.db, 'mail-aggregator.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  enabled INTEGER NOT NULL DEFAULT 1,
  session_version INTEGER NOT NULL DEFAULT 0,
  mail_access_all INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  ssl INTEGER NOT NULL DEFAULT 1,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'password',
  enabled INTEGER NOT NULL DEFAULT 1,
  sync_interval INTEGER NOT NULL DEFAULT 600,
  local_user TEXT NOT NULL DEFAULT 'mailuser',
  sync_mode TEXT NOT NULL DEFAULT 'full',
  destination_mode TEXT NOT NULL DEFAULT 'flat',
  destination_folder TEXT,
  mailbox_folder TEXT,
  folder_includes TEXT NOT NULL DEFAULT '',
  folder_excludes TEXT NOT NULL DEFAULT '',
  max_age_days INTEGER,
  max_size_mb INTEGER,
  deletion_mode TEXT NOT NULL DEFAULT 'archive',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_sync_message TEXT,
  -- 下面这些字段代表"最近一次可信的"值:某次同步没能解析出对应字段时,
  -- 保留上一次的值不动,而不是被错误地覆盖成0或者N/A
  last_host2_messages INTEGER,
  last_host2_folders INTEGER,
  last_transferred INTEGER,
  last_skipped INTEGER,
  last_errors INTEGER,
  owner_user_id INTEGER REFERENCES admin_users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'queued', -- queued/running/success/failed/timed_out/interrupted/cancelled
  exit_code INTEGER,
  duration_ms INTEGER,
  pid INTEGER,
  host1_messages INTEGER,
  host2_messages INTEGER,
  host1_folders INTEGER,
  host2_folders INTEGER,
  messages_transferred INTEGER,
  messages_skipped INTEGER,
  errors INTEGER,
  log_file TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);

CREATE TABLE IF NOT EXISTS notification_events (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_notified_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_account ON sync_jobs(account_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_started ON sync_jobs(started_at);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_account_started ON sync_jobs(account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_started ON sync_jobs(status, started_at DESC);
`);

// --- 迁移:给可能是v0.1.0创建的旧库补齐新列 ---
function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function addColumnIfMissing(table, column, ddl) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

addColumnIfMissing('sync_jobs', 'pid', 'pid INTEGER');
addColumnIfMissing('sync_jobs', 'host1_messages', 'host1_messages INTEGER');
addColumnIfMissing('sync_jobs', 'host2_messages', 'host2_messages INTEGER');
addColumnIfMissing('sync_jobs', 'host1_folders', 'host1_folders INTEGER');
addColumnIfMissing('sync_jobs', 'host2_folders', 'host2_folders INTEGER');
addColumnIfMissing('accounts', 'last_host2_messages', 'last_host2_messages INTEGER');
addColumnIfMissing('accounts', 'last_host2_folders', 'last_host2_folders INTEGER');
addColumnIfMissing('accounts', 'last_transferred', 'last_transferred INTEGER');
addColumnIfMissing('accounts', 'last_skipped', 'last_skipped INTEGER');
addColumnIfMissing('accounts', 'last_errors', 'last_errors INTEGER');
addColumnIfMissing('accounts', 'destination_mode', "destination_mode TEXT NOT NULL DEFAULT 'flat'");
addColumnIfMissing('accounts', 'destination_folder', 'destination_folder TEXT');
addColumnIfMissing('accounts', 'mailbox_folder', 'mailbox_folder TEXT');
addColumnIfMissing('accounts', 'folder_includes', "folder_includes TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('accounts', 'folder_excludes', "folder_excludes TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('accounts', 'max_age_days', 'max_age_days INTEGER');
addColumnIfMissing('accounts', 'max_size_mb', 'max_size_mb INTEGER');
addColumnIfMissing('accounts', 'deletion_mode', "deletion_mode TEXT NOT NULL DEFAULT 'archive'");
addColumnIfMissing('admin_users', 'role', "role TEXT NOT NULL DEFAULT 'user'");
addColumnIfMissing('admin_users', 'enabled', 'enabled INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('admin_users', 'session_version', 'session_version INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('admin_users', 'mail_access_all', 'mail_access_all INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('accounts', 'owner_user_id', 'owner_user_id INTEGER REFERENCES admin_users(id) ON DELETE RESTRICT');

// v0.2.0 多用户迁移：旧版本只有一个管理员，现有邮箱全部归给最早创建的账号。
// 该账号还需要读取旧版 flat 模式产生的未归属文件夹，因此保留兼容标记；读取邮件时
// 仍会先排除其他用户的隔离目录。后续创建的用户不会获得该兼容能力。
const firstUser = db.prepare('SELECT id FROM admin_users ORDER BY id LIMIT 1').get();
if (firstUser) {
  db.prepare("UPDATE admin_users SET role='admin', mail_access_all=1 WHERE id=?").run(firstUser.id);
  db.prepare('UPDATE accounts SET owner_user_id=? WHERE owner_user_id IS NULL').run(firstUser.id);
  // 已有隔离账号必须继续使用原目录，不能在升级时移动数千封邮件。
  db.prepare(`UPDATE accounts SET mailbox_folder=destination_folder
    WHERE mailbox_folder IS NULL AND destination_mode='subfolder'`).run();
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_accounts_owner_updated ON accounts(owner_user_id, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_account_mailbox_folder
  ON accounts(local_user, mailbox_folder COLLATE NOCASE)
  WHERE mailbox_folder IS NOT NULL;
`);

// 显示名称只需在同一Web用户内唯一；实际落盘目录由mailbox_folder唯一约束。
// 删除旧版按local_user做全局唯一的索引，允许不同用户都把自己的账号命名为“Gmail”。
db.exec(`
  DROP INDEX IF EXISTS idx_unique_account_destination_folder;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_owner_destination_folder
  ON accounts(owner_user_id, destination_folder COLLATE NOCASE)
  WHERE destination_mode = 'subfolder'
`);

// --- 防止同一账号同时存在多个 queued/running 任务 ---
// 用部分唯一索引在数据库层面兜底,而不是只依赖内存Map(内存Map在重启场景下不可靠)。
// 如果旧库里已经有脏数据(同一账号多条active记录),先清理掉多余的,只保留最新一条,
// 否则创建唯一索引这一步会直接失败。
function dedupeActiveJobsBeforeIndex() {
  const dupeAccounts = db
    .prepare(
      `SELECT account_id, COUNT(*) c FROM sync_jobs
       WHERE status IN ('queued','running')
       GROUP BY account_id HAVING c > 1`
    )
    .all();
  for (const row of dupeAccounts) {
    const jobs = db
      .prepare(
        `SELECT id FROM sync_jobs WHERE account_id = ? AND status IN ('queued','running')
         ORDER BY started_at DESC`
      )
      .all(row.account_id);
    // 保留最新的一条,其余标记为cancelled
    for (let i = 1; i < jobs.length; i++) {
      db.prepare(
        `UPDATE sync_jobs SET status='cancelled', finished_at=datetime('now') WHERE id=?`
      ).run(jobs[i].id);
    }
  }
}
dedupeActiveJobsBeforeIndex();

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_job_per_account
ON sync_jobs(account_id)
WHERE status IN ('queued', 'running');
`);

// 默认设置
const defaultSettings = {
  max_concurrent_syncs: '1',
  sync_timeout_minutes: '120',
  log_retention_days: '90',
  // v0.1.4: these are the sole persisted source for all local Dovecot clients.
  dovecot_user: 'mailuser',
  dovecot_host: '127.0.0.1',
  dovecot_port: '143',
  default_sync_interval: '600',
  // v0.1.2: Web端口(优先级 环境变量PORT > 这里持久化的值 > 8080)
  web_port: '8080',
  web_language: 'zh-CN',
  // v0.1.2: branding,只做品牌相关文本可配置,不是把所有UI文案都塞数据库
  app_name: 'Mail Aggregator',
  app_subtitle: '轻量邮件汇聚面板',
  browser_title: 'Mail Aggregator',
  sidebar_title: 'Mail Aggregator',
  login_title: '登录',
  footer_text: 'Powered by Dovecot + imapsync',
  // v0.1.3: Dovecot密码管理相关
  // Kept as a migration alias for older databases. New code uses dovecot_user.
  dovecot_target_user: 'mailuser',
  dovecot_using_default_password: 'false',
  dovecot_last_known_hash: '',
};
const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
for (const [k, v] of Object.entries(defaultSettings)) {
  insertSetting.run(k, v);
}

// One-time migration from the v0.1.3 setting names. Do not overwrite explicit v0.1.4 values.
const migrateSetting = db.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?');
const oldHost = db.prepare("SELECT value FROM settings WHERE key='local_imap_host'").get();
const oldPort = db.prepare("SELECT value FROM settings WHERE key='local_imap_port'").get();
const oldUser = db.prepare("SELECT value FROM settings WHERE key='dovecot_target_user'").get();
if (oldHost) migrateSetting.run(oldHost.value, 'dovecot_host', defaultSettings.dovecot_host);
if (oldPort) migrateSetting.run(oldPort.value, 'dovecot_port', defaultSettings.dovecot_port);
if (oldUser) migrateSetting.run(oldUser.value, 'dovecot_user', defaultSettings.dovecot_user);

module.exports = { db, DATA_DIR: ROOT_DIR, DIRS, DB_PATH };

if (require.main === module) {
  console.log('数据库已初始化:', DB_PATH);
}
