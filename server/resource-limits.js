'use strict';

const fs = require('node:fs');

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

module.exports = { integerSetting, accountLimit, diskCapacity };
