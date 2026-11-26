const { stateRoute, asyncRoute, withStateLock } = require('./state-lock');
const express = require('express');
const crypto = require('crypto');
const { passwordHasher } = require('./password-hasher');
const { validNewPassword, passwordHelp } = require('./password-policy');
const { createAdminSetup } = require('./admin-setup');
const { db, DIRS } = require('./db');
const { LoginRateLimiter, normalizedClientIp } = require('./login-rate-limit');
const { createTotpSecurity, fault } = require('./totp-security');
const { isDirectLoopback, operationTransport } = require('./http-security');

const router = express.Router();

// Run the same bcrypt cost for an unknown username so response timing does not
// become a reliable account-enumeration signal.
const DUMMY_PASSWORD_HASH = '$2a$12$gZSyu4KDMYsuziMP/Fyqu.o3b82jWsYs7hZjMD3f8O1KXckvzqjji';
const loginLimiter = new LoginRateLimiter(db);
const totp = createTotpSecurity(DIRS.root);
const locked = (work, options) => withStateLock(DIRS.root, work, options);
const adminSetup = createAdminSetup({ db, root: DIRS.root, hasher: passwordHasher });

function sameUser(before, after) {
  return Boolean(after && after.enabled && Number(before.id) === Number(after.id)
    && Number(before.session_version || 0) === Number(after.session_version || 0)
    && (before.username === undefined || before.username === after.username)
    && (before.role === undefined || before.role === after.role)
    && (before.mail_access_all === undefined || Number(before.mail_access_all) === Number(after.mail_access_all))
    && (before.password_hash === undefined || before.password_hash === after.password_hash));
}

function assertCurrentUser(req, snapshot = null, role = null) {
  const user = sessionUser(req);
  if (user && req.sessionID) {
    const row = db.prepare('SELECT sess,expires FROM sessions WHERE sid=?').get(req.sessionID);
    let stored = null;
    try { stored = row && row.expires > Date.now() ? JSON.parse(row.sess) : null; } catch (_) {}
    const sameOwner = stored && (typeof stored.userId === 'number' ? stored.userId === Number(user.id) : stored.userId === user.username);
    if (!sameOwner || Number(stored.sessionVersion || 0) !== Number(user.session_version || 0)) {
      // Logout/session regeneration in a different request may have removed this
      // session while work was pending. Do not let response-time touch revive it.
      req.session = null;
      throw Object.assign(new Error('登录会话已失效，请重新登录'), { statusCode: 401 });
    }
  }
  if (!user || (snapshot && !sameUser(snapshot, db.prepare('SELECT * FROM admin_users WHERE id=?').get(user.id)))) {
    throw Object.assign(new Error('登录状态或密码已变更，请重新登录'), { statusCode: 401 });
  }
  if ((role === 'admin' && user.role !== 'admin')
      || (role === 'primary' && !(user.role === 'admin' && user.mail_access_all))) {
    throw Object.assign(new Error('当前账号无权执行此操作'), { statusCode: 403 });
  }
  req.user = user;
  return user;
}

function rateLimitResult(lockedUntil, label = '登录') {
  const seconds = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
  return { ok: false, status: 429, error: `${label}失败次数过多或验证正在进行，请在 ${seconds} 秒后重试` };
}

function issueSession(req, user, callback, validate = () => {}, verifiedTotp = undefined) {
  // Rotate the session identifier after authentication so an identifier that
  // existed before login cannot be fixed and reused by another party.
  req.session.regenerate((error) => {
    if (error) return callback(error);
    let factor;
    try {
      const current = db.prepare('SELECT * FROM admin_users WHERE id=?').get(user.id);
      if (!sameUser(user, current)) throw Object.assign(new Error('登录状态已变更，请重试'), { statusCode: 401 });
      factor = totp.status(current);
      if ((factor.enabled || verifiedTotp !== undefined) && factor.generation !== verifiedTotp) throw fault('totp_login_expired', 401);
      validate();
    } catch (failure) { return callback(failure); }
    req.session.userId = Number(user.id);
    req.session.sessionVersion = Number(user.session_version || 0);
    const agent = String(req.get?.('user-agent') || '').slice(0, 512);
    if (factor.generation) req.session.totpGeneration = factor.generation;
    req.session.deviceFamily = /Edg(?:e|A|iOS)?[/]/i.test(agent) ? 'Edge' : /(?:Firefox|FxiOS)[/]/i.test(agent) ? 'Firefox'
      : /(?:Chrome|CriOS)[/]/i.test(agent) ? 'Chrome' : /Safari[/]/i.test(agent) ? 'Safari' : 'Other';
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    callback(null, req.session.csrfToken);
  });
}

// 首次启动:创建管理员账号
router.post('/setup', asyncRoute(async (req, res) => {
  const info = await adminSetup.create({
    username: String(req.body?.username || ''),
    password: String(req.body?.password || ''),
  });
  issueSession(req, { id: info.lastInsertRowid, session_version: 0 }, (error, csrfToken) => {
    if (error) return res.status(500).json({ error: '创建登录会话失败，请重试' });
    res.json({ ok: true, csrfToken });
  });
}));

router.get('/setup-status', (req, res) => {
  res.json({ needsSetup: !adminSetup.hasAdmin() });
});

router.post('/login', asyncRoute(async (req, res) => {
  const username = String(req.body?.username || '').normalize('NFKC').trim();
  const ip = normalizedClientIp(req);
  if (!ip) {
    return res.status(503).json({ error: '请通过配置好的 HTTPS 反向代理访问，代理须传递客户端地址（X-Forwarded-For）。' });
  }

  const reservation = locked(() => loginLimiter.reserve(ip, username));
  if (reservation.lockedUntil) return res.status(429).json({ error: rateLimitResult(reservation.lockedUntil).error });
  try {
    const password = String(req.body?.password || '');
    const user = db.prepare('SELECT * FROM admin_users WHERE username = ? AND enabled = 1').get(username);
    const passwordMatches = password.length <= 256
      ? await passwordHasher.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH)
      : false;
    const verification = locked(() => {
      const lockedUntil = loginLimiter.check(ip, username);
      if (lockedUntil) return rateLimitResult(lockedUntil);
      const current = user && db.prepare('SELECT * FROM admin_users WHERE id=?').get(user.id);
      if (!passwordMatches || !user || !sameUser(user, current)) {
        loginLimiter.failure(ip, username);
        return { ok: false, status: 401, error: '用户名或密码错误' };
      }
      loginLimiter.success(ip, username);
      return { ok: true };
    });
    if (!verification.ok) return res.status(verification.status).json({ error: verification.error, code: verification.code });
    let factor;
    try { factor = totp.status(user); } catch (error) { return sendTotpError(res, error); }
    if (factor.enabled) {
      const transport = operationTransport(req);
      if (transport === 'blocked') return res.status(403).json({ error: 'totp_secure_transport', code: 'totp_secure_transport' });
      return await new Promise((resolve, reject) => req.session.regenerate(error => {
        if (error) return reject(error);
        try {
          locked(() => {
            const current = db.prepare('SELECT * FROM admin_users WHERE id=?').get(user.id);
            if (!sameUser(user, current)) throw fault('totp_login_expired', 401);
            totp.beginLogin(current, req.sessionID, ip);
          });
          // This CSRF token binds step two to the same anonymous browser session.
          req.session.csrfToken = crypto.randomBytes(24).toString('hex');
          res.set('Cache-Control', 'no-store').status(202).json({ requiresTotp: true, authenticatorOnly: transport === 'lan', csrfToken: req.session.csrfToken });
          resolve();
        } catch (failure) { reject(failure); }
      })).catch(error => sendTotpError(res, error));
    }
    issueSession(req, user, (error, csrfToken) => {
      if (error) return res.status(error.statusCode || 500).json({ error: '创建登录会话失败，请重试' });
      res.json({ ok: true, csrfToken });
    }, () => {
      const until = loginLimiter.check(ip, username);
      if (until) throw Object.assign(new Error('登录已被限速，请稍后重试'), { statusCode: 429 });
    });
  } finally { reservation.release(); }
}));

function protectedTotpTransport(req) {
  return req.secure || isDirectLoopback(req);
}
function requireTotpTransport(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!protectedTotpTransport(req)) return res.status(403).json({ error: 'totp_secure_transport', code: 'totp_secure_transport' });
  next();
}
function sendTotpError(res, error) {
  if (!/^totp_[a-z_]+$/.test(error?.code || '')) throw error;
  res.status(error.statusCode || 409).json({ error: error.code, code: error.code });
}

router.post('/login/totp', requireCsrf, asyncRoute(async (req, res) => {
  const transport = operationTransport(req);
  res.set('Cache-Control', 'no-store');
  if (transport === 'blocked') return sendTotpError(res, fault('totp_secure_transport', 403));
  try {
    const ip = normalizedClientIp(req);
    const { user, generation } = locked(() => {
      const candidate = ip && totp.pending(req.sessionID, ip);
      const user = candidate && db.prepare('SELECT * FROM admin_users WHERE id=? AND enabled=1').get(candidate.id);
      if (!user) throw fault('totp_login_expired', 401);
      const generation = totp.finishLogin(user, req.sessionID, ip, req.body?.code, transport !== 'lan');
      return { user, generation };
    });
    issueSession(req, user, (error, csrfToken) => {
      if (error) return res.status(error.statusCode || 500).json({ error: 'totp_login_expired', code: 'totp_login_expired' });
      res.json({ ok: true, csrfToken });
    }, undefined, generation);
  } catch (error) { return sendTotpError(res, error); }
}));

router.get('/totp', requireOwnSecurity, requirePrimaryAdmin, asyncRoute(async (req, res) => {
  try {
    const { enabled, remainingCodes } = totp.status(assertCurrentUser(req, null, 'primary'));
    res.set('Cache-Control', 'no-store').json({ enabled, remainingCodes, secure: protectedTotpTransport(req) });
  } catch (error) { return sendTotpError(res, error); }
}));
for (const operation of ['begin', 'enable', 'recovery-codes', 'disable']) {
  router.post(`/totp/${operation}`, requireOwnSecurity, requirePrimaryAdmin, requireTotpTransport, requireCsrf, asyncRoute(async (req, res) => {
    try {
      const verification = await verifyCurrentPassword(req, req.body?.currentPassword);
      if (!verification.ok) return res.status(verification.status).json({ error: verification.error, code: verification.code });
      const result = locked(() => {
        const user = assertCurrentUser(req, verification.user, 'primary');
        if (operation === 'begin') return totp.begin(user, req.sessionID);
        const changed = operation === 'enable'
          ? totp.enable(user, req.sessionID, req.body?.code)
          : totp.change(user, req.body?.code, operation === 'disable');
        return { user, ...changed };
      });
      if (operation === 'begin') {
        const { totpQr } = require('./totp-qr');
        return res.json({ ...result, qr: totpQr(result.uri) });
      }
      // Clear old device entries before the new generation can log in.
      // Generation checks still invalidate them if this cleanup fails.
      try { req.sessionStore?.revokeOtherDevices?.(result.user.id, result.user.session_version, req.sessionID, result.user.username); }
      catch (_) { /* Invalid generations cannot authenticate. */ }
      issueSession(req, result.user, (error, csrfToken) => {
        res.json({ ok: true, codes: result.codes, csrfToken: csrfToken || null, loginRequired: Boolean(error) });
      }, undefined, result.generation);
    } catch (error) { return sendTotpError(res, error); }
  }));
}

// Session revocation has its own SQLite transaction and must remain available
// even during a configuration snapshot or maintenance operation.
router.post('/logout', requireOwnSecurity, requireCsrf, (req, res) => {
  const { secure, httpOnly, sameSite, path } = req.session.cookie;
  req.session.destroy((error) => {
    if (error) return res.status(503).json({ error: '未能撤销当前会话，请稍后重试退出。' });
    res.clearCookie('connect.sid', { secure: secure === true || (secure === 'auto' && req.secure), httpOnly, sameSite, path });
    return res.json({ ok: true });
  });
});

router.get('/devices', requireOwnSecurity, (req, res) => {
  const user = assertCurrentUser(req);
  res.set('Cache-Control', 'no-store').json({ devices: req.sessionStore.listDevices(user.id, user.session_version, req.sessionID) });
});

router.post('/devices/revoke-others', requireOwnSecurity, requireCsrf, (req, res) => {
  const user = assertCurrentUser(req);
  res.json({ ok: true, revoked: req.sessionStore.revokeOtherDevices(user.id, user.session_version, req.sessionID, user.username) });
});

router.delete('/devices/:id', requireOwnSecurity, requireCsrf, (req, res) => {
  const user = assertCurrentUser(req);
  const id = req.params.id;
  if (!/^[a-f0-9-]{36}$/.test(id)) return res.status(404).json({ error: '未找到该登录设备' });
  const outcome = req.sessionStore.revokeDevice(user.id, user.session_version, req.sessionID, id);
  if (outcome === 'not_found') return res.status(404).json({ error: '未找到该登录设备' });
  if (outcome === 'current') return res.status(400).json({ error: '请使用退出登录结束当前会话' });
  res.json({ ok: true });
});

router.post('/change-password', requireOwnSecurity, requireCsrf, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (!validNewPassword(newPassword)) return res.status(400).json({ error: passwordHelp });
  const verification = await verifyCurrentPassword(req, currentPassword, { allowDuringRestore: true });
  if (!verification.ok) return res.status(verification.status).json({ error: verification.error, code: verification.code });
  const hash = await passwordHasher.hash(newPassword);
  const verifiedTotp = req.session.totpGeneration;
  const updated = locked(() => {
    assertCurrentUser(req, verification.user);
    db.prepare('UPDATE admin_users SET password_hash=?,session_version=session_version+1 WHERE id=?')
      .run(hash, verification.user.id);
    return db.prepare('SELECT * FROM admin_users WHERE id=?').get(verification.user.id);
  }, { allowDuringRestore: true });
  issueSession(req, updated, (error, csrfToken) => {
    if (error) return res.status(500).json({ error: '密码已修改，但创建新会话失败，请重新登录' });
    res.json({ ok: true, csrfToken });
  }, undefined, verifiedTotp);
}));

router.get('/me', (req, res) => {
  const user = sessionUser(req);
  if (user) {
    // 兼容老session里可能还没有csrfToken的情况(比如升级后遗留的session)
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    }
    const primaryAdmin = Boolean(user.role === 'admin' && user.mail_access_all);
    const transport = primaryAdmin ? operationTransport(req) : null;
    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      primaryAdmin,
      maintenance: primaryAdmin ? {
        profile: req.app.get('security profile') || 'strict',
        transport,
        totpRequired: transport === 'lan' && totp.status(user).enabled,
      } : undefined,
      csrfToken: req.session.csrfToken,
      secureTransport: Boolean(req.secure),
    });
  } else {
    res.status(401).json({ error: '未登录' });
  }
});

function acceptSession(req, res, next, allowed) {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  if (!allowed(user)) return res.status(403).json({ error: '当前账号无权执行此操作' });
  req.user = user;
  return next();
}

// Mail/account/work routes opt out of operator access by default. The only
// exceptions are self-service security and explicit redacted operations routes.
function requireAuth(req, res, next) {
  return acceptSession(req, res, next, user => user.role === 'user' || user.role === 'admin');
}
function requireOwnSecurity(req, res, next) {
  return acceptSession(req, res, next, user => ['user', 'admin', 'operator'].includes(user.role));
}
function requireOperations(req, res, next) {
  return acceptSession(req, res, next, user => user.role === 'operator' || user.role === 'admin' && user.mail_access_all);
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
  const factor = totp.status(user);
  if (factor.generation !== (req.session.totpGeneration ?? null)) return null;
  req.session.userId = Number(user.id);
  req.session.sessionVersion = Number(user.session_version || 0);
  return user;
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: '仅管理员可以执行此操作' });
}

function requirePrimaryAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin' && req.user.mail_access_all) return next();
  res.status(403).json({ error: '仅主管理员可以执行此操作' });
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

async function verifyCurrentPassword(req, password, lockOptions) {
  const user = sessionUser(req);
  if (!user) return { ok: false, status: 401, error: '未登录' };
  const ip = normalizedClientIp(req);
  if (!ip) {
    return { ok: false, status: 503, error: '请通过配置好的 HTTPS 反向代理访问，代理须传递客户端地址（X-Forwarded-For）。' };
  }
  const reservation = locked(() => loginLimiter.reserve(ip, user.username), lockOptions);
  if (reservation.lockedUntil) return rateLimitResult(reservation.lockedUntil, '密码验证');
  try {
    const full = db.prepare('SELECT * FROM admin_users WHERE id=? AND enabled=1').get(user.id);
    const ok = Boolean(full && String(password || '').length <= 256
      && await passwordHasher.compare(String(password || ''), full.password_hash));
    return locked(() => {
      // The account may have been disabled, demoted or changed while awaiting bcrypt.
      assertCurrentUser(req, full);
      const lockedUntil = loginLimiter.check(ip, user.username);
      if (lockedUntil) return rateLimitResult(lockedUntil, '密码验证');
      if (!ok) {
        loginLimiter.failure(ip, user.username);
        return { ok: false, status: 401, code: 'current_password_invalid', error: '当前密码错误' };
      }
      loginLimiter.success(ip, user.username);
      return { ok: true, status: 200, user: full };
    }, lockOptions);
  } finally { reservation.release(); }
}

function currentPasswordGuard(role = null, { confirmLanFactor = false } = {}) {
  return asyncRoute(async (req, res, next) => {
    const verification = await verifyCurrentPassword(req, req.body?.currentPassword);
    if (!verification.ok) return res.status(verification.status).json({ error: verification.error, code: verification.code });
    if (confirmLanFactor && res.locals.operationTransport === 'lan') {
      try {
        locked(() => totp.confirmOperation(assertCurrentUser(req, verification.user, role), req.body?.totpCode));
      } catch (error) {
        const messages = {
          totp_operation_code_required: '请输入验证器的六位验证码。',
          totp_invalid_code: '验证码无效或已用过，请等下一组后再试。',
          totp_rate_limited: '验证码错误次数过多，请稍后重试。',
        };
        if (!Object.hasOwn(messages, error.code)) throw error;
        return res.status(error.code === 'totp_rate_limited' ? 429 : 403).json({ error: messages[error.code], code: error.code });
      }
    } else assertCurrentUser(req, verification.user, role);
    // next() enters the short state-lock section synchronously. Password work
    // is already complete, and no request can interleave before lock acquisition.
    return next();
  });
}

module.exports = {
  router,
  requireAuth,
  requireOperations,
  requireAdmin,
  requirePrimaryAdmin,
  requireCsrf,
  hasAdmin: adminSetup.hasAdmin,
  verifyCurrentPassword,
  issueSession,
  sessionUser,
  assertCurrentUser,
  currentPasswordGuard,
};
