'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { dataPaths } = require('./data-paths');
const { reconcileStartup } = require('./restore-journal');

// This connection owns only an OS-backed lock, never the application database.
// A killed process releases the lock without a timeout or PID-based takeover.
function acquireDataProcessLock(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const filename = path.join(fs.realpathSync(root), '.process-lock.db');
  let fd;
  try {
    fd = fs.openSync(filename, 'wx', 0o600);
    if (process.getuid?.() === 0) {
      const owner = fs.statSync(root);
      fs.fchownSync(fd, owner.uid, owner.gid);
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (!fs.lstatSync(filename).isFile()) throw new Error('应用进程锁路径异常，请运行离线诊断');
  const lock = new Database(filename, { timeout: 0, fileMustExist: true });
  try {
    if (lock.pragma('journal_mode', { simple: true }) !== 'delete') throw new Error('应用进程锁格式异常，请运行离线诊断');
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    if (error.code?.startsWith('SQLITE_BUSY')) throw new Error('此数据目录已有 Web 服务或恢复进程，请先停止该进程');
    throw error;
  }
  return () => { if (lock.open) lock.close(); };
}

function startDataProcess(dirs = dataPaths()) {
  const release = acquireDataProcessLock(dirs.root);
  try {
    reconcileStartup(dirs, filename => new Database(filename, { fileMustExist: true, timeout: 0 }));
  } catch (error) {
    release();
    throw error;
  }
  process.once('exit', release);
  return () => { process.removeListener('exit', release); release(); };
}

module.exports = { acquireDataProcessLock, startDataProcess };
