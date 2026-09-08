const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { db, DIRS } = require('./db');
const { router: authRouter, requireAuth, requireAdmin, requireCsrf, verifyAdminPassword, sessionUser } = require('./auth');
const accountsRouter = require('./accounts');
const usersRouter = require('./users');
const oauthRouter = require('./oauth-router');
const scheduler = require('./scheduler');
const { getSystemStatus, getAccountStats, getExtendedSystemInfo, getUpdateStatus } = require('./system');
const { get: getConfig, getPort, localDovecot } = require('./config');
const { getHealthReport } = require('./health');
const notifications = require('./notifications');
const { cleanupExpired, cleanupKeepLatest } = require('./log-retention');
const { sendJobLog } = require('./log-reader');
const { JOB_STATUSES, listJobs } = require('./job-query');
const { createBackupBundle, cleanupStaleBackupWorkdirs } = require('./backup');
const { createRestoreRouter } = require('./restore-router');
const { createMailRouter } = require('./mail-reader');
const { cleanupOldRestorePoints, cleanupStaleRestoreWorkdirs } = require('./restore');
const maintenanceLock = require('./maintenance-lock');
const { createShutdownController } = require('./shutdown-controller');
const { version: APP_VERSION } = require('../package.json');

const UNINSTALL_HELPER_PATH = process.env.MAIL_AGG_UNINSTALL_HELPER_PATH || '/usr/local/sbin/mail-aggregator-uninstall-helper';
const { saveGlobalLocalSecret, hasGlobalLocalSecret } = require('./credentials');
const { reconcileAfterRestart, shutdownGracefully, retryJob, triggerAllEnabled, cancelAllQueued, currentRunningCount, currentConnectionTestCount } = require('./sync');
const dovecot = require('./dovecot');
const SqliteSessionStore = require('./sessionStore');
const {
  parseIntegerInRange,
  normalizeHost,
  isValidHost,
  normalizeSystemUsername,
  isValidSystemUsername,
} = require('./validation');
const {
  parseTrustProxy,
  parseCookieSecure,
  isLoopbackAddress,
  resolveBindHost,
  securityHeaders,
} = require('./http-security');

// v0.1.2: 端口优先级 环境变量PORT > 持久化设置(settings.web_port) > 默认8080
function resolvePort() {
  if (process.env.PORT) {
    const p = parseIntegerInRange(process.env.PORT, 1, 65535);
    if (p !== null) return p;
    console.warn(`环境变量 PORT=${process.env.PORT} 不是合法端口,忽略`);
  }
  return getPort('web_port');
}
const PORT = resolvePort();
const REQUESTED_BIND_HOST = String(process.env.MAIL_AGG_BIND_HOST || '').trim();
const BIND_HOST = REQUESTED_BIND_HOST
  ? resolveBindHost(REQUESTED_BIND_HOST, '127.0.0.1')
  : '0.0.0.0';
if (REQUESTED_BIND_HOST && BIND_HOST !== REQUESTED_BIND_HOST) {
  console.warn(`MAIL_AGG_BIND_HOST=${REQUESTED_BIND_HOST} 不合法，安全回退到 ${BIND_HOST}`);
}
const TRUST_PROXY = parseTrustProxy(process.env.MAIL_AGG_TRUST_PROXY);
const COOKIE_SECURE = parseCookieSecure(process.env.MAIL_AGG_COOKIE_SECURE);

// session密钥持久化到数据目录,避免每次重启服务都把所有人踢下线
function loadOrCreateSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretPath = path.join(DIRS.db, 'session.secret');
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}
const SESSION_SECRET = loadOrCreateSessionSecret();

// v0.1.1: 服务启动时,先把上一次因为重启/崩溃而遗留的"running"任务
// 处理掉(标记为interrupted,并尝试终止可能残留的imapsync进程),
// 这一步必须在scheduler启动之前完成,避免刚起来就把这些账号当成"正在跑"锁死。
reconcileAfterRestart();
cleanupStaleBackupWorkdirs(DIRS.tmp);
cleanupStaleRestoreWorkdirs(DIRS.tmp);
cleanupOldRestorePoints(DIRS.restorePoints);

const app = express();
if (TRUST_PROXY !== false) app.set('trust proxy', TRUST_PROXY);
app.use(securityHeaders);
app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    store: new SqliteSessionStore(),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7天
      sameSite: 'lax',
      // auto: HTTPS(含受信反代传来的X-Forwarded-Proto)使用Secure，
      // 直接HTTP访问保持兼容。生产环境也可显式设为true强制HTTPS。
      secure: COOKIE_SECURE,
    },
  })
);

// 认证相关路由(登录/初始化不需要鉴权,也不需要CSRF token,因为此时session还没建立)
app.use('/api/auth', authRouter);

// branding是纯展示文本,登录页(还没登录)也需要读取,所以不挂requireAuth。
// 不属于敏感信息,公开读取没有安全问题。
const BRANDING_KEYS = [
  'app_name',
  'app_subtitle',
  'browser_title',
  'sidebar_title',
  'login_title',
  'footer_text',
  'web_language',
];
app.get('/api/branding', (req, res) => {
  const rows = db
    .prepare(
      `SELECT key, value FROM settings WHERE key IN (${BRANDING_KEYS.map(() => '?').join(',')})`
    )
    .all(...BRANDING_KEYS);
  const branding = {};
  for (const r of rows) branding[r.key] = r.value;
  res.json(branding);
});

// 以下所有API都需要登录 + CSRF token(对GET不做CSRF校验)
app.use('/api/accounts', requireAuth, requireCsrf, accountsRouter);
app.use('/api/oauth', requireAuth, requireCsrf, oauthRouter);
app.use('/api/mail', requireAuth, requireCsrf, createMailRouter());
app.use('/api/users', requireAuth, requireAdmin, requireCsrf, usersRouter);
app.use('/api/system/restore', requireAuth, requireAdmin, requireCsrf, createRestoreRouter({
  db,
  dirs: DIRS,
  version: APP_VERSION,
  scheduler,
  hasRunningSyncs: () => currentRunningCount() > 0 || currentConnectionTestCount() > 0,
  verifyPassword: verifyAdminPassword,
  isSecureRequest: (req) => req.secure || isLoopbackAddress(req.ip),
}));

app.get('/api/settings', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  settings.hasLocalSecret = hasGlobalLocalSecret();
  settings.dovecot_user = getConfig('dovecot_user');
  settings.dovecot_host = getConfig('dovecot_host');
  settings.dovecot_port = String(getPort('dovecot_port'));
  settings.actualPort = PORT; // 当前进程实际监听的端口,可能和settings里存的web_port不一致(改了还没重启)
  res.json(settings);
});

app.get('/api/health', requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await getHealthReport()); }
  catch (error) { res.status(500).json({ error: '健康检查失败' }); }
});

app.get('/api/notifications/settings', requireAuth, requireAdmin, (req, res) => {
  res.json(notifications.publicConfig());
});

app.put('/api/notifications/settings', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  try { res.json({ ok: true, ...notifications.saveConfig(req.body || {}) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/settings', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const errors = [];

  // branding字段做长度限制,防止极端内容把页面布局撑坏;内容本身允许任意文本,
  // 前端渲染时统一走escapeHtml(),不需要在这里做HTML层面的净化
  const brandingLimits = {
    app_name: 60,
    app_subtitle: 120,
    browser_title: 80,
    sidebar_title: 60,
    login_title: 60,
    footer_text: 200,
  };
  for (const [key, maxLen] of Object.entries(brandingLimits)) {
    if (req.body[key] !== undefined && String(req.body[key]).length > maxLen) {
      errors.push(`${key} 长度不能超过 ${maxLen} 个字符`);
    }
  }

  if (req.body.dovecot_user !== undefined) {
    if (!isValidSystemUsername(req.body.dovecot_user)) {
      errors.push('Dovecot 用户名格式不合法，或属于受保护的系统账号');
    }
  }
  for (const key of ['dovecot_port', 'web_port']) {
    if (req.body[key] !== undefined && parseIntegerInRange(req.body[key], 1, 65535) === null) {
      errors.push(`${key === 'dovecot_port' ? 'Dovecot' : 'Web'}端口必须是 1-65535 之间的整数`);
    }
  }
  if (req.body.dovecot_host !== undefined && !isValidHost(req.body.dovecot_host)) {
    errors.push('Dovecot主机地址格式不合法');
  }
  if (req.body.web_language !== undefined && ![
    'zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR', 'de-DE',
  ].includes(req.body.web_language)) {
    errors.push('不支持该界面语言');
  }
  if (req.body.max_concurrent_syncs !== undefined) {
    if (parseIntegerInRange(req.body.max_concurrent_syncs, 1, 4) === null) {
      errors.push('最大同时同步任务数必须是 1-4 之间的整数');
    }
  }
  if (req.body.sync_timeout_minutes !== undefined) {
    if (parseIntegerInRange(req.body.sync_timeout_minutes, 5, 1440) === null) {
      errors.push('同步超时必须是 5-1440 分钟之间的整数');
    }
  }
  if (req.body.log_retention_days !== undefined) {
    if (parseIntegerInRange(req.body.log_retention_days, 1, 3650) === null) {
      errors.push('日志保留天数必须是 1-3650 之间的整数');
    }
  }
  if (req.body.default_sync_interval !== undefined) {
    if (parseIntegerInRange(req.body.default_sync_interval, 60, 604800) === null) {
      errors.push('默认同步间隔必须是60-604800秒之间的整数');
    }
  }

  if (errors.length) {
    return res.status(400).json({ error: errors.join('; ') });
  }

  const allowed = [
    'max_concurrent_syncs',
    'sync_timeout_minutes',
    'log_retention_days',
    'dovecot_host',
    'dovecot_port',
    'web_port',
    'default_sync_interval',
    'dovecot_user',
    ...BRANDING_KEYS,
  ];
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  );
  const portChanged = req.body.web_port !== undefined;
  const normalizedInput = { ...req.body };
  for (const key of ['dovecot_port', 'web_port', 'max_concurrent_syncs', 'sync_timeout_minutes', 'log_retention_days', 'default_sync_interval']) {
    if (normalizedInput[key] !== undefined) normalizedInput[key] = String(Number(normalizedInput[key]));
  }
  if (normalizedInput.dovecot_host !== undefined) normalizedInput.dovecot_host = normalizeHost(normalizedInput.dovecot_host);
  if (normalizedInput.dovecot_user !== undefined) normalizedInput.dovecot_user = normalizeSystemUsername(normalizedInput.dovecot_user);
  for (const key of allowed) {
    if (normalizedInput[key] !== undefined) {
      upsert.run(key, String(normalizedInput[key]));
    }
  }
  res.json({
    ok: true,
    needsRestart: portChanged, // 端口修改后当前监听不会自动变,前端据此提示用户重启服务
  });
});

app.get('/api/jobs', requireAuth, (req, res) => {
  const accountId = req.query.account === undefined
    ? null
    : parseIntegerInRange(req.query.account, 1, Number.MAX_SAFE_INTEGER);
  const page = req.query.page === undefined ? 1 : parseIntegerInRange(req.query.page, 1, 1000000);
  const pageSize = req.query.pageSize === undefined
    ? 25
    : parseIntegerInRange(req.query.pageSize, 10, 100);
  const status = req.query.status === undefined || req.query.status === '' ? null : req.query.status;
  if (accountId === null && req.query.account !== undefined) {
    return res.status(400).json({ error: '账号筛选值不合法' });
  }
  if (page === null || pageSize === null) {
    return res.status(400).json({ error: '分页参数不合法' });
  }
  if (status !== null && !JOB_STATUSES.includes(status)) {
    return res.status(400).json({ error: '任务状态筛选值不合法' });
  }
  res.json(listJobs(db, { accountId, ownerUserId: req.user.id, status, page, pageSize }));
});

app.post('/api/sync/all', requireAuth, requireCsrf, (req, res) => {
  try {
    res.json({ ok: true, ...triggerAllEnabled(req.user.id) });
  } catch (error) {
    res.status(500).json({ error: `批量同步失败: ${error.message}` });
  }
});

app.post('/api/jobs/cancel-queued', requireAuth, requireCsrf, (req, res) => {
  res.json({ ok: true, ...cancelAllQueued(req.user.id) });
});

app.post('/api/jobs/:jobId/retry', requireAuth, requireCsrf, (req, res) => {
  try {
    const result = retryJob(req.params.jobId, req.user.id);
    if (!result.ok) {
      const messages = {
        not_found: '任务不存在',
        not_retryable: '只有失败、超时、中断或已取消的任务可以重试',
        already_running: '该账号已有任务在同步或排队中',
        missing_credentials: '账号尚未完成凭据配置或OAuth2授权',
        maintenance: '系统正在恢复，请稍后再重试任务',
      };
      return res.status(result.reason === 'not_found' ? 404 : 409)
        .json({ error: messages[result.reason] || '任务无法重试' });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: `重试失败: ${error.message}` });
  }
});

app.delete('/api/jobs/old', requireAuth, requireCsrf, (req, res) => {
  const keep = req.query.keep === undefined ? 30 : parseIntegerInRange(req.query.keep, 1, 1000);
  if (keep === null) return res.status(400).json({ error: '保留条数必须是 1-1000 之间的整数' });
  const result = cleanupKeepLatest(db, DIRS.logs, keep, req.user.id);
  res.json({ ok: true, ...result });
});

app.get('/api/jobs/:jobId/log', requireAuth, (req, res) => {
  const job = db.prepare(`SELECT j.* FROM sync_jobs j JOIN accounts a ON a.id=j.account_id
    WHERE j.id=? AND a.owner_user_id=?`).get(req.params.jobId, req.user.id);
  if (!job || !sendJobLog(res, DIRS.logs, job)) {
    return res.status(404).json({ error: '日志不存在' });
  }
});

app.get('/api/system-info', requireAuth, requireAdmin, async (req, res) => {
  const local = localDovecot();
  const info = await getExtendedSystemInfo(local.host, local.port);
  info.webPort = PORT;
  res.json(info);
});

app.get('/api/system-updates', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await getUpdateStatus());
  } catch (e) {
    res.status(500).json({ error: '无法检查系统更新状态' });
  }
});

app.post('/api/system/backup', requireAuth, requireAdmin, requireCsrf, async (req, res) => {
  if (!req.secure && !isLoopbackAddress(req.ip)) {
    return res.status(400).json({ error: '远程备份下载必须使用 HTTPS；HTTP 仅允许服务器本机访问' });
  }
  if (!verifyAdminPassword(req.session.userId, req.body && req.body.currentPassword)) {
    return res.status(401).json({ error: '管理员密码验证失败' });
  }
  if (!maintenanceLock.acquire('backup')) {
    return res.status(409).json({ error: '系统正在执行备份或恢复，请稍后再试' });
  }
  let bundle = null;
  try {
    bundle = await createBackupBundle({ db, dirs: DIRS, version: APP_VERSION });
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      bundle.cleanup();
      maintenanceLock.release('backup');
    };
    res.set('X-Backup-SHA256', bundle.sha256);
    res.on('close', finalize);
    res.download(bundle.archivePath, bundle.filename, (error) => {
      finalize();
      if (error && !res.headersSent) {
        res.status(500).json({ error: '备份下载失败' });
      }
    });
  } catch (error) {
    if (bundle) bundle.cleanup();
    maintenanceLock.release('backup');
    console.error(`[backup] 生成失败: ${error.message}`);
    res.status(500).json({ error: '备份生成失败，请确认系统已安装 tar 并检查服务日志' });
  }
});

// 重启服务:命令是完全写死的,不接受任何用户输入拼接进去,
// 只允许重启"mail-aggregator"这一个固定的service,不能是别的名字。
// mailadmin本身不是root,这里靠一条最小化的sudoers规则完成提权
// (只允许免密执行这一条固定命令,不是 ALL=(ALL) NOPASSWD:ALL)。
// 如果没有配置这条sudo规则,这个操作会失败,用户需要手动执行
// `rc-service mail-aggregator restart`。
app.post('/api/system/restart', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  res.json({ ok: true, message: '重启已触发,请稍等几秒后刷新页面' });
  setTimeout(() => {
    const restartArgs = process.env.MAIL_AGG_SERVICE_MANAGER === 'systemd'
      ? ['-n', 'systemctl', 'restart', 'mail-aggregator']
      : ['-n', '/etc/init.d/mail-aggregator', 'restart'];
    const child = spawn('sudo', restartArgs, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      console.error('重启失败,可能是sudo未配置:', err.message);
    });
    child.unref();
  }, 300);
});

app.post('/api/system/uninstall', requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const { currentPassword, mode, confirmation } = req.body || {};
  if (!verifyAdminPassword(req.session.userId, currentPassword)) {
    return res.status(401).json({ error: '管理员密码验证失败' });
  }
  if (!['remove-app', 'purge'].includes(mode)) {
    return res.status(400).json({ error: '卸载模式无效' });
  }
  if (!fs.existsSync(UNINSTALL_HELPER_PATH)) {
    return res.status(503).json({ error: '卸载 helper 未安装，请先重新运行 install.sh --full' });
  }
  const expectedConfirmation = mode === 'purge' ? 'PURGE' : 'REMOVE';
  if (confirmation !== expectedConfirmation) {
    return res.status(400).json({ error: `当前卸载模式必须输入 ${expectedConfirmation}` });
  }
  res.json({ ok: true, mode, message: '卸载已开始，当前页面即将失效。' });
  setTimeout(() => {
    const child = spawn('sudo', ['-n', UNINSTALL_HELPER_PATH, mode], {
      env: { PATH: process.env.PATH }, detached: true, stdio: 'ignore',
    });
    child.unref();
  }, 500);
});

// v0.1.3: Dovecot密码管理
app.get('/api/dovecot/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = await dovecot.getDovecotStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: `获取Dovecot状态失败: ${e.message}` });
  }
});

app.post('/api/dovecot/change-password', requireAuth, requireAdmin, requireCsrf, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: '当前密码、新密码、确认密码均为必填' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: '两次输入的新密码不一致' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: '新密码至少需要8位' });
  }
  // IMAP LOGIN走的是quoted-string,协议层面不允许密码里出现CR/LF,
  // 在这里直接拒绝比让底层探测报一个费解的协议错误更清楚
  if (/[\r\n]/.test(newPassword) || /[\r\n]/.test(currentPassword)) {
    return res.status(400).json({ error: '密码不能包含换行符' });
  }

  try {
    const result = await dovecot.changeDovecotPassword(currentPassword, newPassword);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ ok: true });
  } catch (e) {
    // 兜底:任何未预期的异常都不能把密码内容带进错误信息里
    res.status(500).json({ error: '修改密码过程中发生未预期的错误,请查看服务端日志' });
  }
});

app.get('/api/dashboard', requireAuth, async (req, res) => {
  let system = null;
  let dovecotStatus = null;
  if (req.user.role === 'admin') {
    const local = localDovecot();
    system = await getSystemStatus(local.host, local.port, scheduler.getStatus());
    dovecotStatus = await dovecot.getDovecotStatus().catch((e) => ({ error: e.message }));
  }
  const accountStats = getAccountStats(req.user.id);
  const recentAccounts = db
    .prepare(
      `SELECT id, name, provider, enabled, last_sync_at, last_sync_status,
              last_sync_message, last_host2_messages, last_host2_folders,
              last_transferred, last_skipped, last_errors
       FROM accounts WHERE owner_user_id=? ORDER BY last_sync_at DESC LIMIT 20`
    )
    .all(req.user.id);
  res.json({ system, accountStats, recentAccounts, dovecotStatus });
});

// HTML页面在服务端先检查会话，避免未登录用户直接看到管理界面骨架。
// CSS/JS仍可公开读取，它们不包含密码或运行数据。
app.use((req, res, next) => {
  const protectedPage = req.path === '/' || req.path.endsWith('.html');
  if (req.method !== 'GET' || !protectedPage || req.path === '/login.html') return next();
  const user = sessionUser(req);
  if (user && ['/users.html', '/settings.html', '/system-info.html'].includes(req.path) && user.role !== 'admin') {
    return res.redirect('/index.html');
  }
  if (user) return next();
  return res.redirect('/login.html');
});

// 静态前端文件
app.use(express.static(path.join(__dirname, '..', 'web')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
});

let logCleanupTimer = null;
function runLogCleanup() {
  const row = db.prepare("SELECT value FROM settings WHERE key='log_retention_days'").get();
  const days = parseIntegerInRange(row && row.value, 1, 3650) || 90;
  try {
    const result = cleanupExpired(db, DIRS.logs, days);
    if (result.deletedJobs || result.deletedFiles || result.deletedOrphanFiles) {
      console.log(`[logs] 清理完成: ${result.deletedJobs} 条任务, ${result.deletedFiles} 个日志, ${result.deletedOrphanFiles} 个孤立日志`);
    }
    for (const error of result.errors) console.error('[logs] 清理失败:', error);
  } catch (error) {
    console.error(`[logs] 自动清理失败: ${error.message}`);
  }
}

const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`mail-aggregator listening on http://${BIND_HOST}:${PORT}`);
  scheduler.start();
  runLogCleanup();
  logCleanupTimer = setInterval(runLogCleanup, 24 * 60 * 60 * 1000);
  logCleanupTimer.unref();
});

const shutdown = createShutdownController({
  server,
  stopScheduler: () => scheduler.stop(),
  stopMaintenance: () => {
    if (logCleanupTimer) clearInterval(logCleanupTimer);
  },
  // shutdownGracefully 会停止队列继续启动任务，并在现有 imapsync 完成
  // SIGTERM -> 10秒后SIGKILL 的终止链路、日志关闭和任务状态提交后 resolve。
  terminateChildren: shutdownGracefully,
  forceExitDelayMs: 15000,
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
