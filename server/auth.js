const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const router = express.Router();

const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000; // 5分钟
const USERNAME_RE = /^[\p{L}\p{N}_.@-]{2,64}$/u;

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

function issueSession(req, user, callback) {
  // Rotate the session identifier after authentication so an identifier that
  // existed before login cannot be fixed and reused by another party.
  req.session.regenerate((error) => {
    if (error) return callback(error);
    req.session.userId = Number(user.id);
    req.session.sessionVersion = Number(user.session_version || 0);
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    callback(null, req.session.csrfToken);
  });
}

// 首次启动:创建管理员账号
router.post('/setup', (req, res) => {
  if (hasAdmin()) {
    return res.status(400).json({ error: '管理员账号已存在' });
  }
  const username = String(req.body?.username || '').normalize('NFKC').trim();
  const password = String(req.body?.password || '');
  if (!USERNAME_RE.test(username) || password.length < 10 || password.length > 256) {
    return res.status(400).json({ error: '用户名需为2-64位，密码需为10-256位' });
  }
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare("INSERT INTO admin_users (username, password_hash, role, mail_access_all) VALUES (?, ?, 'admin', 1)").run(
    username,
    hash
  );
  issueSession(req, { id: info.lastInsertRowid, session_version: 0 }, (error, csrfToken) => {
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

  const username = String(req.body?.username || '').normalize('NFKC').trim();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ? AND enabled = 1').get(username);
  const ok = password.length <= 256 && user && bcrypt.compareSync(password, user.password_hash);

  if (!ok) {
    registerFailure(ip);
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  clearFailures(ip);
  issueSession(req, user, (error, csrfToken) => {
    if (error) return res.status(500).json({ error: '创建登录会话失败，请重试' });
    res.json({ ok: true, csrfToken });
  });
});

router.post('/logout', requireAuth, requireCsrf, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/change-password', requireAuth, requireCsrf, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 10 || newPassword.length > 256) return res.status(400).json({ error: '新密码需为10-256位' });
  const full = db.prepare('SELECT * FROM admin_users WHERE id=?').get(req.user.id);
  if (!full || !bcrypt.compareSync(currentPassword, full.password_hash)) {
    return res.status(401).json({ error: '当前密码错误' });
  }
  db.prepare('UPDATE admin_users SET password_hash=?,session_version=session_version+1 WHERE id=?')
    .run(bcrypt.hashSync(newPassword, 12), full.id);
  const updated = db.prepare('SELECT * FROM admin_users WHERE id=?').get(full.id);
  issueSession(req, updated, (error, csrfToken) => {
    if (error) return res.status(500).json({ error: '密码已修改，但创建新会话失败，请重新登录' });
    res.json({ ok: true, csrfToken });
  });
});

router.get('/me', (req, res) => {
  const user = sessionUser(req);
  if (user) {
    // 兼容老session里可能还没有csrfToken的情况(比如升级后遗留的session)
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    }
    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      csrfToken: req.session.csrfToken,
      secureTransport: Boolean(req.secure),
    });
  } else {
    res.status(401).json({ error: '未登录' });
  }
});

function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (user) {
    req.user = user;
    return next();
  }
  res.status(401).json({ error: '未登录' });
}

function sessionUser(req) {
  if (!req.session || req.session.userId === undefined || req.session.userId === null) return null;
  // 兼容升级前 session 把 username 存在 userId 的格式。
  const stored = req.session.userId;
  const user = typeof stored === 'number'
    ? db.prepare('SELECT id,username,role,enabled,session_version,mail_access_all FROM admin_users WHERE id=?').get(stored)
    : db.prepare('SELECT id,username,role,enabled,session_version,mail_access_all FROM admin_users WHERE username=?').get(stored);
  if (!user || !user.enabled) return null;
  if (req.session.sessionVersion === undefined && Number(user.session_version || 0) !== 0) return null;
  if (req.session.sessionVersion !== undefined
      && Number(req.session.sessionVersion) !== Number(user.session_version || 0)) return null;
  req.session.userId = Number(user.id);
  req.session.sessionVersion = Number(user.session_version || 0);
  return user;
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: '仅管理员可以执行此操作' });
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
  const user = typeof username === 'number'
    ? db.prepare("SELECT password_hash FROM admin_users WHERE id = ? AND role='admin' AND enabled=1").get(username)
    : db.prepare("SELECT password_hash FROM admin_users WHERE username = ? AND role='admin' AND enabled=1").get(username);
  return !!user && bcrypt.compareSync(String(password || ''), user.password_hash);
}

module.exports = { router, requireAuth, requireAdmin, requireCsrf, hasAdmin, verifyAdminPassword, issueSession, sessionUser };
