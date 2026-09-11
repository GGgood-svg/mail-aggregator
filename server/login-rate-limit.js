'use strict';

const crypto = require('node:crypto');

const WINDOW_MS = 5 * 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;
const USER_IP_MAX_FAILURES = 5;
const IP_MAX_FAILURES = 50;

function normalizedClientIp(req) {
  const trustProxy = req.app && req.app.get && req.app.get('trust proxy');
  const forwarded = req.get && req.get('x-forwarded-for');
  if (trustProxy && !forwarded) return null;
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 256);
}

function usernameDigest(username) {
  return crypto.createHash('sha256').update(String(username || '')).digest('hex');
}

class LoginRateLimiter {
  constructor(database, { now = () => Date.now() } = {}) {
    this.db = database;
    this.now = now;
  }

  keys(ip, username) {
    return {
      userIp: `user-ip:${ip}:${usernameDigest(username)}`,
      ip: `ip:${ip}`,
    };
  }

  lockedUntil(key, nowMs) {
    const row = this.db.prepare('SELECT locked_until FROM login_attempts WHERE ip=?').get(key);
    return row && Number(row.locked_until) > nowMs ? Number(row.locked_until) : 0;
  }

  check(ip, username) {
    const nowMs = this.now();
    const keys = this.keys(ip, username);
    return Math.max(this.lockedUntil(keys.userIp, nowMs), this.lockedUntil(keys.ip, nowMs));
  }

  record(key, maximum, nowMs) {
    const row = this.db.prepare('SELECT fail_count,locked_until,window_started FROM login_attempts WHERE ip=?').get(key);
    const windowStarted = Number(row && row.window_started || 0);
    const inWindow = windowStarted > 0 && nowMs - windowStarted < WINDOW_MS;
    const failCount = inWindow ? Number(row.fail_count || 0) + 1 : 1;
    const lockedUntil = failCount >= maximum ? nowMs + LOCK_MS : 0;
    this.db.prepare(`INSERT INTO login_attempts(ip,fail_count,locked_until,window_started)
      VALUES(?,?,?,?) ON CONFLICT(ip) DO UPDATE SET
      fail_count=excluded.fail_count,locked_until=excluded.locked_until,window_started=excluded.window_started`)
      .run(key, failCount, lockedUntil, inWindow ? windowStarted : nowMs);
  }

  failure(ip, username) {
    const nowMs = this.now();
    const keys = this.keys(ip, username);
    this.record(keys.userIp, USER_IP_MAX_FAILURES, nowMs);
    this.record(keys.ip, IP_MAX_FAILURES, nowMs);
    this.db.prepare(`DELETE FROM login_attempts
      WHERE COALESCE(window_started,0) < ? AND COALESCE(locked_until,0) < ?`)
      .run(nowMs - 24 * 60 * 60 * 1000, nowMs);
    return this.check(ip, username);
  }

  success(ip, username) {
    this.db.prepare('DELETE FROM login_attempts WHERE ip=?').run(this.keys(ip, username).userIp);
  }
}

module.exports = {
  WINDOW_MS,
  LOCK_MS,
  USER_IP_MAX_FAILURES,
  IP_MAX_FAILURES,
  normalizedClientIp,
  usernameDigest,
  LoginRateLimiter,
};
