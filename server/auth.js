const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const router = express.Router();

const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000; // 5分钟

function hasAdmin() {
  const row = db.prepare('SELECT COUNT(*) c FROM admin_users').get();
  return row.c > 0;
}

function clientIp(req) {
  // 只信任直接连接的socket地址,不信任X-Forwarded-For(避免被伪造绕过限速),
  // 如果部署在反向代理后面,请在反代层面做好真实IP透传并自行调整这里
  return req.socket.remoteAddress || 'unknown';
}

function getAttempt(ip) {
  return db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip);
}

function isLocked(ip) {
  const row = getAttempt(ip);
  if (!row || !row.locked_until) return false;
  return row.locked_until > Date.now();
}

function registerFailure(ip) {
  const row = getAttempt(ip);
  const failCount = (row ? row.fail_count : 0) + 1;
  const lockedUntil = failCount >= MAX_FAILS ? Date.now() + LOCK_MS : row ? row.locked_until : null;
  db.prepare(
    `INSERT INTO login_attempts (ip, fail_count, locked_until) VALUES (?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET fail_count=excluded.fail_count, locked_until=excluded.locked_until`
  ).run(ip, failCount, lockedUntil);
}

function clearFailures(ip) {
  db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
}

function issueSession(req, username, callback) {
  // Rotate the session identifier after authentication so an identifier that
  // existed before login cannot be fixed and reused by another party.
  req.session.regenerate((error) => {
    if (error) return callback(error);
    req.session.userId = username;
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    callback(null, req.session.csrfToken);
  });
}

// 首次启动:创建管理员账号
router.post('/setup', (req, res) => {
  if (hasAdmin()) {
    return res.status(400).json({ error: '管理员账号已存在' });
  }
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: '用户名必填,密码至少8位' });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run(
    username,
    hash
  );
  issueSession(req, username, (error, csrfToken) => {
    if (error) return res.status(500).json({ error: '创建登录会话失败，请重试' });
    res.json({ ok: true, csrfToken });
  });
});

router.get('/setup-status', (req, res) => {
  res.json({ needsSetup: !hasAdmin() });
});

router.post('/login', (req, res) => {
  const ip = clientIp(req);

  if (isLocked(ip)) {
    const row = getAttempt(ip);
    const remainingSec = Math.ceil((row.locked_until - Date.now()) / 1000);
    return res.status(429).json({
      error: `登录失败次数过多,请在 ${remainingSec} 秒后重试`,
    });
  }

  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  const ok = user && bcrypt.compareSync(password || '', user.password_hash);

  if (!ok) {
    registerFailure(ip);
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  clearFailures(ip);
  issueSession(req, user.username, (error, csrfToken) => {
    if (error) return res.status(500).json({ error: '创建登录会话失败，请重试' });
    res.json({ ok: true, csrfToken });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    // 兼容老session里可能还没有csrfToken的情况(比如升级后遗留的session)
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    }
    res.json({ username: req.session.userId, csrfToken: req.session.csrfToken });
  } else {
    res.status(401).json({ error: '未登录' });
  }
});

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: '未登录' });
}

// CSRF校验:所有状态变更请求(POST/PUT/DELETE/PATCH)必须带上和session里
// 一致的 X-CSRF-Token,仅依赖SameSite Cookie是不够的(旧浏览器/特殊场景下
// SameSite不一定生效,这里做双重保险)。GET/HEAD/OPTIONS不需要校验。
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = req.session && req.session.csrfToken;
  const provided = req.get('X-CSRF-Token');
  if (!expected || !provided || expected !== provided) {
    return res.status(403).json({ error: 'CSRF token 无效或缺失,请刷新页面重试' });
  }
  next();
}

function verifyAdminPassword(username, password) {
  const user = db.prepare('SELECT password_hash FROM admin_users WHERE username = ?').get(username);
  return !!user && bcrypt.compareSync(String(password || ''), user.password_hash);
}

module.exports = { router, requireAuth, requireCsrf, hasAdmin, verifyAdminPassword };
