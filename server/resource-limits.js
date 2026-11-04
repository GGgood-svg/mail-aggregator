'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { isLocalTarget } = require('./target-transport');

function integerSetting(db, key, fallback, min, max) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  const value = Number(row && row.value);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function accountLimit(db, ownerUserId) {
  const maximum = integerSetting(db, 'max_accounts_per_user', 20, 1, 1000);
  const row = db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE owner_user_id=?').get(ownerUserId);
  return { maximum, count: Number(row && row.count || 0) };
}

function diskCapacity(db, rootDir, statfs = fs.statfsSync) {
  const minimumMb = integerSetting(db, 'min_free_disk_mb', 512, 64, 1048576);
  try {
    const stats = statfs(rootDir);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(availableBytes) || availableBytes < 0) throw new Error('invalid statfs result');
    return {
      ok: availableBytes >= minimumMb * 1024 * 1024,
      minimumMb,
      availableMb: Math.floor(availableBytes / 1024 / 1024),
    };
  } catch (error) {
    return { ok: false, minimumMb, availableMb: null, error: error.message };
  }
}

function syncDiskCapacity(db, dirs, local, { run = execFileSync, env = process.env, statfs = fs.statfsSync } = {}) {
  for (const directory of [...new Set([dirs.root, dirs.cache, dirs.tmp].filter(Boolean))]) {
    const capacity = diskCapacity(db, directory, statfs);
    if (!capacity.ok) return { ...capacity, storage: directory };
  }
  if (env.MAIL_AGG_MAIL_STORAGE_PATH) return diskCapacity(db, env.MAIL_AGG_MAIL_STORAGE_PATH, statfs);
  const minimumMb = integerSetting(db, 'min_free_disk_mb', 512, 64, 1048576);
  try {
    if (!isLocalTarget(local.host)) throw new Error('远端邮件存储需要配置 MAIL_AGG_MAIL_STORAGE_PATH 对应的挂载点');
    const output = run('sudo', ['-n', env.MAIL_AGG_DOVECOT_HELPER_PATH || '/usr/local/sbin/mail-aggregator-dovecot-helper', 'storage-status', local.user],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
    const values = output.trim().split(/\s+/);
    if (values.length !== 2 || values.some((value) => !/^\d+$/.test(value))) throw new Error('无法读取邮件存储容量');
    const availableMb = Math.floor(Number(values[0]) / 1024);
    const availableInodes = Number(values[1]);
    return { ok: availableMb >= minimumMb && availableInodes > 0, minimumMb, availableMb, availableInodes, storage: 'Maildir' };
  } catch (error) {
    return { ok: false, minimumMb, availableMb: null, error: '无法检查邮件盘，请更新 Dovecot helper 或配置可检查的邮件存储挂载点' };
  }
}

module.exports = { integerSetting, accountLimit, diskCapacity, syncDiskCapacity };
