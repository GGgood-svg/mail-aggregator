'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { currentStateLockId, lockPath } = require('./state-lock');
const { migrateRestoreNotificationSource } = require('./notification-restore-source');

const JOURNAL_NAME = '.restore-journal.json';
const ID = /^[a-f0-9]{32}$/;
const INODE = /^\d+:\d+$/;
const journalPath = root => path.join(root, JOURNAL_NAME);

function statIfPresent(filename) {
  try { return fs.lstatSync(filename, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function identity(filename) {
  const stat = statIfPresent(filename);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.ino === 0n) throw new Error('恢复目录的文件类型或身份无法验证');
  return `${stat.dev}:${stat.ino}`;
}

function flush(filename) {
  const fd = fs.openSync(filename, process.platform === 'win32' ? 'r+' : 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function flushDirectory(directory) {
  // Node cannot open Windows directories for fsync. Linux is the release target.
  if (process.platform !== 'win32') flush(directory);
}

function flushTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) flushTree(target);
    else if (entry.isFile()) flush(target);
  }
  flushDirectory(directory);
}

function journalPresent(root) {
  return Boolean(statIfPresent(journalPath(root)));
}

function readRestoreJournal(root, live) {
  const stat = statIfPresent(journalPath(root));
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 4096n) throw new Error('恢复日志格式异常');
  const item = JSON.parse(fs.readFileSync(journalPath(root), 'utf8'));
  if (item?.version !== 1 || !ID.test(item.id) || !ID.test(item.lockId) ||
      item.live !== path.basename(live) || path.dirname(path.resolve(live)) !== path.resolve(root) ||
      ![item.stageIdentity, item.oldIdentity, item.newIdentity].every(value => typeof value === 'string' && INODE.test(value)) ||
      new Set([item.stageIdentity, item.oldIdentity, item.newIdentity]).size !== 3 ||
      ![item.oldIdentity, item.newIdentity].every(value => value.split(':')[0] === item.stageIdentity.split(':')[0])) {
    throw new Error('恢复日志内容或目录归属无法验证');
  }
  return item;
}

function stagePath(root, id) { return path.join(root, `.restore-secrets-${id}`); }

function prepareRestoreJournal(root, live, prepare) {
  const lockId = currentStateLockId(root);
  if (!lockId || journalPresent(root)) throw new Error('已有恢复待核对，请停止服务并运行离线诊断');
  const id = crypto.randomBytes(16).toString('hex');
  const stage = stagePath(root, id);
  const next = path.join(stage, 'next');
  const temporary = path.join(root, `.restore-journal-${id}.tmp`);
  fs.mkdirSync(stage, { mode: 0o700 });
  let published = false;
  try {
    const details = prepare(next);
    const item = { version: 1, id, lockId, live: path.basename(live), stageIdentity: identity(stage),
      oldIdentity: identity(live), newIdentity: identity(next) };
    if (!item.oldIdentity || !item.newIdentity ||
        ![item.oldIdentity, item.newIdentity].every(value => value.split(':')[0] === item.stageIdentity.split(':')[0])) {
      throw new Error('凭据目录必须与应用数据目录使用同一文件系统');
    }
    flushTree(live);
    flushTree(next);
    flushDirectory(stage);
    flush(lockPath(root));
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(item)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, journalPath(root));
    published = true;
    flushDirectory(root);
    return { item, details };
  } catch (error) {
    if (!published) {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(temporary, { force: true });
    }
    throw error;
  }
}

function moveCredentials(root, live, item) {
  const stage = stagePath(root, item.id);
  fs.renameSync(live, path.join(stage, 'old'));
  flushDirectory(stage);
  flushDirectory(root);
  fs.renameSync(path.join(stage, 'next'), live);
  flushDirectory(stage);
  flushDirectory(root);
}

function initializeRestoreState(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS restore_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    operation_id TEXT NOT NULL, outcome TEXT NOT NULL, recorded_at TEXT NOT NULL
  )`);
  // CLI restores can run consecutively before Web first starts. Preserve each
  // operation in the same durable source used by audit and notifications.
  migrateRestoreNotificationSource(db);
}

function recordRestoreResult(db, id, outcome) {
  db.prepare(`INSERT INTO restore_state(singleton,operation_id,outcome,recorded_at) VALUES(1,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET operation_id=excluded.operation_id,
      outcome=excluded.outcome, recorded_at=excluded.recorded_at`).run(id, outcome, new Date().toISOString());
}

function lastRestoreResult(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_state'").get()) return null;
  return db.prepare('SELECT operation_id, outcome, recorded_at FROM restore_state WHERE singleton=1').get() || null;
}

function checkStateLock(root, item) {
  const filename = lockPath(root);
  const stat = statIfPresent(filename);
  if (!stat) return false;
  if (!stat.isFile() || stat.size > 1024n || !item) throw new Error('发现无法确认归属的配置锁');
  const lock = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (lock?.id !== item.lockId) throw new Error('配置锁与恢复日志不匹配');
  return true;
}

function clearRestoredCache(root) {
  const directory = path.join(root, 'cache');
  const stat = statIfPresent(directory);
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error('同步缓存路径不是目录');
  // Preserve the directory itself, which may be a separate mount.
  for (const name of fs.readdirSync(directory)) fs.rmSync(path.join(directory, name), { recursive: true });
  flushDirectory(directory);
}

function reconcileCredentials(db, root, live, item, { startup = false } = {}) {
  const checkedLock = checkStateLock(root, item);
  const stage = stagePath(root, item.id);
  const stageIdentity = identity(stage);
  if (stageIdentity && stageIdentity !== item.stageIdentity) throw new Error('恢复暂存目录已变化');
  const old = path.join(stage, 'old');
  const next = path.join(stage, 'next');
  const oldIdentity = identity(old);
  const nextIdentity = identity(next);
  const liveIdentity = identity(live);
  if ((oldIdentity && oldIdentity !== item.oldIdentity) || (nextIdentity && nextIdentity !== item.newIdentity) ||
      (liveIdentity && ![item.oldIdentity, item.newIdentity].includes(liveIdentity))) {
    throw new Error('现有凭据的归属与恢复日志不匹配');
  }
  const result = lastRestoreResult(db);
  const committed = result?.operation_id === item.id && ['committed', 'recovered_committed'].includes(result.outcome);
  if (committed) {
    if (liveIdentity !== item.newIdentity || nextIdentity) throw new Error('数据库已提交，但恢复凭据无法验证');
    clearRestoredCache(root);
  } else if (liveIdentity !== item.oldIdentity) {
    if (oldIdentity !== item.oldIdentity) throw new Error('无法找到恢复前的凭据');
    if (liveIdentity === item.newIdentity) {
      if (nextIdentity) throw new Error('恢复凭据位置异常');
      fs.renameSync(live, next);
      flushDirectory(stage);
      flushDirectory(root);
    }
    fs.renameSync(old, live);
    flushDirectory(stage);
    flushDirectory(root);
  } else if (oldIdentity) {
    throw new Error('恢复前的凭据出现重复目录');
  }

  if (startup || !committed) {
    initializeRestoreState(db);
    recordRestoreResult(db, item.id, committed ? 'recovered_committed' : 'rolled_back');
  }
  if (stageIdentity) fs.rmSync(stage, { recursive: true });
  if (startup && checkedLock) fs.unlinkSync(lockPath(root));
  flushDirectory(root);
}

function finishRestoreJournal(root, item) {
  const lock = statIfPresent(lockPath(root));
  // A new, unrelated configuration writer can enter once the short lock ends.
  // The restore's own lock must be gone before its ownership record is retired.
  if (lock && lock.isFile() && lock.size <= 1024n) {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(lockPath(root), 'utf8')); }
    catch (error) { if (!['ENOENT', undefined].includes(error.code)) throw error; }
    if (owner?.id === item.lockId) throw new Error('恢复配置锁尚未释放');
  }
  fs.unlinkSync(journalPath(root));
  flushDirectory(root);
}

function hasLegacyRecovery(tmp) {
  if (!statIfPresent(tmp)) return false;
  return fs.readdirSync(tmp, { withFileTypes: true }).some(entry => entry.isDirectory() &&
    /^(web|cli)-restore-/.test(entry.name) && statIfPresent(path.join(tmp, entry.name, 'old-secrets')));
}

function reconcileStartup(dirs, openDatabase) {
  try {
    if (hasLegacyRecovery(dirs.tmp)) throw new Error('发现旧版本的恢复现场，需要人工确认凭据版本');
    const item = readRestoreJournal(dirs.root, dirs.secrets);
    checkStateLock(dirs.root, item);
    if (!item) return;
    const db = openDatabase(path.join(dirs.db, 'mail-aggregator.db'));
    try { reconcileCredentials(db, dirs.root, dirs.secrets, item, { startup: true }); }
    finally { db.close(); }
    finishRestoreJournal(dirs.root, item);
  } catch (error) {
    throw new Error(`恢复状态需要检查，服务未启动。请运行 scripts/doctor.sh --json 并参阅 TESTING.md。${error.message}`, { cause: error });
  }
}

module.exports = { journalPresent, readRestoreJournal, prepareRestoreJournal, moveCredentials, initializeRestoreState,
  recordRestoreResult, lastRestoreResult, reconcileCredentials, finishRestoreJournal, reconcileStartup, hasLegacyRecovery };
