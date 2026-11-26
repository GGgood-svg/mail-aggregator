const { stateRoute, asyncRoute } = require('./state-lock');
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createUninstallHost } = require('./uninstall-host');

require('./data-process').startDataProcess();
const { db, DIRS } = require('./db');
const { router: authRouter, requireAuth, requireOperations, requireAdmin, requirePrimaryAdmin, requireCsrf, currentPasswordGuard, sessionUser, assertCurrentUser } = require('./auth');
const { passwordHasher } = require('./password-hasher');
const accountsRouter = require('./accounts');
const usersRouter = require('./users');
const oauthRouter = require('./oauth-router');
const scheduler = require('./scheduler');
const { getSystemStatus, getAccountStats, getExtendedSystemInfo, getUpdateStatus } = require('./system');
const { get: getConfig, getPort, localDovecot } = require('./config');
const { getHealthOverview, getDovecotSnapshot, getDiagnosticSnapshot, getHealthSnapshot, invalidateHealth } = require('./health');
const { getDiagnosticReport } = require('./diagnostics');
const { mailParser } = require('./mail-parser-pool');
const notifications = require('./notifications');
const { createOperations, acceptedUpdateOperationId } = require('./operations');
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
const { appUpdate } = require('./app-update');
const { createUpdateGate } = require('./update-gate');
const { UpdateError } = require('../scripts/updater/release');
const { withHostLock } = require('../scripts/updater/lock');

const uninstallHost = createUninstallHost();
const { saveGlobalLocalSecret, hasGlobalLocalSecret } = require('./credentials');
const { reconcileAfterRestart, shutdownGracefully, retryJob, triggerAllEnabled, cancelAllQueued, currentRunningCount, currentConnectionTestCount } = require('./sync');
const { OVERRIDES_SETTING, providerLimitOptions, validateProviderLimitOverrides, decodeProviderLimitOverrides } = require('./sync-provider-policy');
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
  parseBoolean,
  operationTransportGuard,
  resolveBindHost,
  validateHttpSecurityConfig,
  requireHttpsMiddleware,
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
  : '127.0.0.1';
if (REQUESTED_BIND_HOST && BIND_HOST !== REQUESTED_BIND_HOST) {
  console.warn(`MAIL_AGG_BIND_HOST=${REQUESTED_BIND_HOST} 不合法，安全回退到 ${BIND_HOST}`);
}
const TRUST_PROXY = parseTrustProxy(process.env.MAIL_AGG_TRUST_PROXY);
const COOKIE_SECURE = parseCookieSecure(process.env.MAIL_AGG_COOKIE_SECURE);
const REQUIRE_HTTPS = parseBoolean(process.env.MAIL_AGG_REQUIRE_HTTPS, false);
const SECURITY_PROFILE = process.env.MAIL_AGG_SECURITY_PROFILE ?? 'strict';
const maintenanceTransport = operationTransportGuard();
const maintenancePassword = currentPasswordGuard('primary', { confirmLanFactor: true });
const HTTP_SECURITY_ERRORS = validateHttpSecurityConfig({
  bindHost: BIND_HOST,
  trustProxy: TRUST_PROXY,
  cookieSecure: COOKIE_SECURE,
  requireHttps: REQUIRE_HTTPS,
  securityProfile: SECURITY_PROFILE,
});
if (HTTP_SECURITY_ERRORS.length) {
  throw new Error(`Web 安全配置无效：${HTTP_SECURITY_ERRORS.join('；')}`);
}

// session密钥持久化到数据目录,避免每次重启服务都把所有人踢下线
function loadOrCreateSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretPath = path.join(DIRS.db, 'session.secret');
  if (fs.existsSync(secretPath)) {
    fs.chmodSync(secretPath, 0o600);
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
const updateJournal = process.env.MAIL_AGG_UPDATE_JOURNAL;
const manualUpdateJournal = process.env.MAIL_AGG_MANUAL_UPDATE_JOURNAL;
function updatePending() { return [updateJournal, manualUpdateJournal].some(p => p && fs.existsSync(p)); }
let needsRestartReconciliation = updatePending();
let cleanedAfterStartup = false;
if (!needsRestartReconciliation) reconcileAfterRestart();

const app = express();
app.disable('x-powered-by');
app.set('security profile', SECURITY_PROFILE);
if (TRUST_PROXY !== false) app.set('trust proxy', TRUST_PROXY);
const updates = appUpdate({ version: APP_VERSION, root: DIRS.root, socket: process.env.MAIL_AGG_UPDATE_SOCKET });
const operations = createOperations({ dirs: DIRS, db, canWrite: () => !updatePending(),
  readUpdates: process.env.MAIL_AGG_UPDATE_SOCKET ? () => updates.request('audit-history') : null,
  async healthSnapshot() {
  const [overview, diagnostic] = await Promise.allSettled([getHealthOverview(), getDiagnosticSnapshot()]);
  const installed = overview.value?.installed || diagnostic.value?.installed;
  const checks = [];
  if (installed) checks.push({ id: 'node', ok: !!installed.node }, { id: 'imapsync', ok: !!installed.imapsync },
    { id: 'dovecot-command', ok: !!installed.dovecot });
  if (overview.value) checks.push({ id: 'imap-listener', ok: overview.value.reachable });
  try { db.prepare('SELECT 1').get(); checks.push({ id: 'database', ok: true }); }
  catch (_) { checks.push({ id: 'database', ok: false }); }
  if (diagnostic.value) checks.push({ id: 'disk', ok: diagnostic.value.capacity.ok });
  return { health: { checks }, capacity: diagnostic.value?.capacity };
} });
const updateGate = createUpdateGate({
  journal: updateJournal || manualUpdateJournal, pending: updatePending, control: process.env.MAIL_AGG_UPDATE_CONTROL, version: APP_VERSION,
  database: () => db.prepare('SELECT EXISTS(SELECT 1 FROM settings) AS readable').get() !== undefined,
  busy: () => maintenanceLock.current() !== null || fs.existsSync(path.join(DIRS.root, '.state-write.lock'))
    || currentRunningCount() > 0 || currentConnectionTestCount() > 0 || mailRouter.legacyMailWritesBusy()
    || notifications.notificationDeliveryBusy()
    || Boolean(db.prepare("SELECT 1 FROM sync_jobs WHERE status IN ('queued','running') LIMIT 1").get())
    || Boolean(db.prepare("SELECT 1 FROM mail_tasks WHERE status IN ('queued','running','cancelling') LIMIT 1").get()),
  pause: () => { scheduler.stop(); updates.stop(); notifications.stopDeliveries(); operations.stop(); if (logCleanupTimer) clearInterval(logCleanupTimer); logCleanupTimer = null; },
  resume: () => {
    if (needsRestartReconciliation) { reconcileAfterRestart(); needsRestartReconciliation = false; }
    if (!cleanedAfterStartup) {
      cleanupStaleBackupWorkdirs(DIRS.tmp);
      cleanupStaleRestoreWorkdirs(DIRS.tmp);
      cleanupOldRestorePoints(DIRS.restorePoints);
      cleanedAfterStartup = true;
    }
    scheduler.start(); updates.start(); notifications.startDeliveries(); operations.start();
    if (!logCleanupTimer) { runLogCleanup(); logCleanupTimer = setInterval(runLogCleanup, 86400000); logCleanupTimer.unref(); }
  },
});
app.use(securityHeaders);
app.use(updateGate.middleware);
app.use(requireHttpsMiddleware(REQUIRE_HTTPS));
app.use(express.json({ inflate: false }));
app.use(cookieParser());
app.use(
  session({
    store: new SqliteSessionStore(db, { canPrune: () => !updatePending() }),
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
app.use(operations.audit);
app.use('/api/auth', authRouter);

app.get('/api/operations/overview', requireOperations, (req, res) => {
  res.set('Cache-Control', 'no-store').json(operations.overview());
});
app.get('/api/operations/capacity', requireOperations, (req, res) => {
  res.set('Cache-Control', 'no-store').json(operations.capacity(req.query.period === '7d' ? '7d' : '24h'));
});
app.get('/api/operations/audit', requireAuth, requirePrimaryAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store').json(operations.auditHistory(req.query));
});

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
const mailRouter = createMailRouter({ automaticPreviewBlocked: updatePending });
const mailTasks = mailRouter.mailTasks;
app.use('/api/mail', requireAuth, requireCsrf, mailRouter);
app.use('/api/users', requireAuth, requireAdmin, requireCsrf, usersRouter);
app.use('/api/system/restore', requireAuth, requirePrimaryAdmin, requireCsrf, maintenanceTransport, createRestoreRouter({
  db,
  dirs: DIRS,
  version: APP_VERSION,
  scheduler,
  hasRunningSyncs: () => currentRunningCount() > 0 || currentConnectionTestCount() > 0,
  passwordGuard: maintenancePassword,
  stopMailTasks: () => mailTasks.interruptAll(),
  withMaintenance: async work => {
    const lock = process.env.MAIL_AGG_HOST_MAINTENANCE_LOCK;
    if (!lock) return work();
    try { return await withHostLock(lock, work); }
    catch (e) {
      if (!(e instanceof UpdateError)) throw e;
      throw Object.assign(new Error('系统正在维护，请稍后恢复'), { statusCode: 409 });
    }
  },
  onRestored: invalidateHealth,
  onRecoveryRequired: () => setImmediate(() => shutdown('restore recovery')),
}));

app.get('/api/settings', requireAuth, requirePrimaryAdmin, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  settings[OVERRIDES_SETTING] = decodeProviderLimitOverrides(settings[OVERRIDES_SETTING]);
  settings.provider_concurrency_options = providerLimitOptions();
  settings.hasLocalSecret = hasGlobalLocalSecret();
  settings.dovecot_user = getConfig('dovecot_user');
  settings.dovecot_host = getConfig('dovecot_host');
  settings.dovecot_port = String(getPort('dovecot_port'));
  settings.actualPort = PORT; // 当前进程实际监听的端口,可能和settings里存的web_port不一致(改了还没重启)
  res.json(settings);
});

function diagnostics(snapshot) {
  return getDiagnosticReport({ dirs: DIRS, db, installed: snapshot.installed, capacity: snapshot.capacity,
    queues: { mailTasks: mailTasks.status(), mailParser: mailParser.status(), password: passwordHasher.status(),
      sync: { running: currentRunningCount(), queued: db.prepare("SELECT COUNT(*) AS n FROM sync_jobs WHERE status='queued'").get().n } } });
}

app.get('/api/health', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const runtimeOnly = req.query.view === 'runtime';
  const snapshot = await (runtimeOnly ? getDiagnosticSnapshot() : getHealthSnapshot());
  assertCurrentUser(req, null, 'admin');
  res.json({ ...(runtimeOnly ? {} : snapshot.health), runtime: diagnostics(snapshot) });
}));

app.get('/api/system/diagnostics', requireAuth, requirePrimaryAdmin, asyncRoute(async (req, res) => {
  const snapshot = await getDiagnosticSnapshot();
  assertCurrentUser(req, null, 'primary');
  res.set('Cache-Control', 'no-store').attachment('mail-aggregator-diagnostics.json').json(diagnostics(snapshot));
}));

app.get('/api/notifications/settings', requireAuth, requirePrimaryAdmin, (req, res) => {
  res.json(notifications.publicConfig());
});

// A config restore can bring in a different job with the same numeric ID. Only
// link notification events from the current generation, owned by this user.
function notificationJobLookup() {
  return db.prepare(`SELECT j.*, a.name AS account_name FROM notification_outbox n
    JOIN notification_runtime r ON r.singleton=1 AND r.generation=n.generation
    JOIN sync_jobs j ON j.id=n.job_id AND j.account_id=n.account_id
    JOIN accounts a ON a.id=j.account_id
    WHERE n.event_id=? AND n.kind IN ('failure', 'recovery') AND j.id=? AND a.owner_user_id=?`);
}

app.get('/api/notifications/history', requireAuth, requirePrimaryAdmin, (req, res) => {
  const page = notifications.deliveryHistory({ before: req.query.before, limit: req.query.limit });
  const visibleJob = notificationJobLookup();
  for (const event of page.events) {
    if (event.event === 'sync.failed' || event.event === 'sync.recovered') {
      event.jobLinkAvailable = Number.isSafeInteger(event.jobId) && event.jobId > 0
        && Boolean(visibleJob.get(event.eventId, event.jobId, req.user.id));
    }
  }
  res.set('Cache-Control', 'no-store').json(page);
});

app.put('/api/notifications/settings', requireAuth, requirePrimaryAdmin, requireCsrf, stateRoute((req, res) => {
  try { res.json({ ok: true, ...notifications.saveConfig(req.body || {}) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
}));

app.put('/api/settings', requireAuth, requirePrimaryAdmin, requireCsrf, stateRoute((req, res) => {
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
  if (req.body.max_concurrent_per_provider !== undefined && parseIntegerInRange(req.body.max_concurrent_per_provider, 1, 4) === null) {
    errors.push('每个邮箱服务商的并发限制必须是 1-4 之间的整数');
  }
  const providerOverrides = req.body[OVERRIDES_SETTING] === undefined
    ? undefined : validateProviderLimitOverrides(req.body[OVERRIDES_SETTING]);
  if (providerOverrides === null) errors.push('内置邮箱服务商的并发上限必须为 1–4 或留空');
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
  if (req.body.max_job_log_mb !== undefined) {
    if (parseIntegerInRange(req.body.max_job_log_mb, 1, 256) === null) {
      errors.push('单个任务日志上限必须是 1-256 MB 之间的整数');
    }
  }
  if (req.body.max_accounts_per_user !== undefined) {
    if (parseIntegerInRange(req.body.max_accounts_per_user, 1, 1000) === null) {
      errors.push('每位用户账号上限必须是 1-1000 之间的整数');
    }
  }
  if (req.body.min_free_disk_mb !== undefined) {
    if (parseIntegerInRange(req.body.min_free_disk_mb, 64, 1048576) === null) {
      errors.push('磁盘安全余量必须是 64-1048576 MB 之间的整数');
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
    'max_concurrent_per_provider',
    OVERRIDES_SETTING,
    'sync_timeout_minutes',
    'log_retention_days',
    'max_job_log_mb',
    'max_accounts_per_user',
    'min_free_disk_mb',
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
  if (portChanged && process.env.PORT) {
    return res.status(409).json({ error: 'Web 端口由部署环境 PORT 管理，请修改部署配置后重启服务' });
  }
  const normalizedInput = { ...req.body };
  if (providerOverrides !== undefined) normalizedInput[OVERRIDES_SETTING] = JSON.stringify(providerOverrides);
  for (const key of ['dovecot_port', 'web_port', 'max_concurrent_syncs', 'sync_timeout_minutes', 'log_retention_days', 'max_job_log_mb', 'max_accounts_per_user', 'min_free_disk_mb', 'default_sync_interval']) {
    if (normalizedInput[key] !== undefined) normalizedInput[key] = String(Number(normalizedInput[key]));
  }
  if (normalizedInput.dovecot_host !== undefined) normalizedInput.dovecot_host = normalizeHost(normalizedInput.dovecot_host);
  if (normalizedInput.dovecot_user !== undefined) normalizedInput.dovecot_user = normalizeSystemUsername(normalizedInput.dovecot_user);
  for (const key of allowed) {
    if (normalizedInput[key] !== undefined) {
      upsert.run(key, String(normalizedInput[key]));
    }
  }
  invalidateHealth();
  res.json({
    ok: true,
    needsRestart: portChanged, // 端口修改后当前监听不会自动变,前端据此提示用户重启服务
  });
}));

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

app.post('/api/sync/all', requireAuth, requireCsrf, asyncRoute(async (req, res) => {
  try {
    const actor = req.user;
    res.json({ ok: true, ...await triggerAllEnabled(actor.id, { authorize: () => assertCurrentUser(req, actor) }) });
  } catch (error) {
    if (error.statusCode) throw error;
    res.status(500).json({ error: `批量同步失败: ${error.message}` });
  }
}));

app.post('/api/jobs/cancel-queued', requireAuth, requireCsrf, stateRoute((req, res) => {
  res.json({ ok: true, ...cancelAllQueued(req.user.id) });
}));

app.post('/api/jobs/:jobId/retry', requireAuth, requireCsrf, asyncRoute(async (req, res) => {
  try {
    const actor = req.user;
    const result = await retryJob(req.params.jobId, actor.id, { confirmUnknown: req.body?.confirmUnknown === true, authorize: () => assertCurrentUser(req, actor) });
    if (!result.ok) {
      const messages = {
        not_found: '任务不存在',
        not_retryable: '只有失败、超时、中断或已取消的任务可以重试',
        already_running: '该账号已有任务在同步或排队中',
        missing_credentials: '账号尚未完成凭据配置或OAuth2授权',
        authorization_required: '账号尚未完成凭据配置或OAuth2授权',
        queue_degraded: '同步队列待核对，暂不能接收任务',
        provider_cooldown: '邮箱服务商暂时限流，请在冷却后重试',
        confirm_unknown_result: '上次同步结果未确认，请核对后明确确认再次同步',
        low_inodes: '存储卷可用文件节点不足，已停止启动新同步任务',
        maintenance: '系统正在恢复，请稍后再重试任务',
        low_disk: '服务器可用磁盘空间不足，已停止启动新同步任务',
        disk_check_failed: '无法确认服务器剩余磁盘空间，已安全停止启动同步',
        disk_check_busy: '容量检查繁忙，请稍后重试',
        configuration_changed: '账号或存储配置已变更，请刷新后重试',
      };
      return res.status(result.reason === 'not_found' ? 404 : result.reason === 'disk_check_busy' ? 503 : 409)
        .json({ ...result, error: messages[result.reason] || '任务无法重试' });
    }
    res.locals.auditOperationId = result.jobId;
    res.json(result);
  } catch (error) {
    if (error.statusCode) throw error;
    res.status(500).json({ error: `重试失败: ${error.message}` });
  }
}));

app.delete('/api/jobs/old', requireAuth, requireCsrf, stateRoute((req, res) => {
  const keep = req.query.keep === undefined ? 30 : parseIntegerInRange(req.query.keep, 1, 1000);
  if (keep === null) return res.status(400).json({ error: '保留条数必须是 1-1000 之间的整数' });
  const result = cleanupKeepLatest(db, DIRS.logs, keep, req.user.id);
  res.json({ ok: true, ...result });
}));

function jobForNotification(req) {
  const jobId = parseIntegerInRange(req.params.jobId, 1, Number.MAX_SAFE_INTEGER);
  const eventId = req.query.event;
  if (jobId === null || typeof eventId !== 'string' || !/^[a-f0-9-]{36}$/.test(eventId)) return null;
  return notificationJobLookup().get(eventId, jobId, req.user.id);
}

app.get('/api/jobs/:jobId/notification-task', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const job = jobForNotification(req);
  if (!job) return res.status(404).json({ error: '相关同步任务已不可用或当前账号无权查看。' });
  res.json({ id: job.id, startedAt: job.started_at, status: job.status, accountName: job.account_name });
});

app.get('/api/jobs/:jobId/log', requireAuth, (req, res) => {
  if (req.query.event !== undefined) res.set('Cache-Control', 'no-store');
  const job = req.query.event !== undefined ? jobForNotification(req)
    : db.prepare(`SELECT j.* FROM sync_jobs j JOIN accounts a ON a.id=j.account_id
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

const updateRoute = op => asyncRoute(async (req, res) => {
  try {
    const { mode, channel, start, end, timezone, skipTag, holdUntil } = req.body || {};
    const body = op === 'settings' ? { settings: { mode, channel, start, end, timezone, skipTag, holdUntil } } : op === 'install' ? { tag: req.body?.tag } : op === 'history' ? { page: String(req.query.page || '').slice(0, 6), pageSize: String(req.query.pageSize || '').slice(0, 6) } : {};
    const result = await updates.request(op, body);
    assertCurrentUser(req, null, 'primary');
    if (op === 'install') res.locals.auditOperationId = acceptedUpdateOperationId(result, body.tag);
    // Older root components may still send history in status; expose it only
    // via the bounded history endpoint even during an app-only transition.
    const { history: legacyHistory, ...summary } = result;
    res.status(op === 'install' ? 202 : 200).set('Cache-Control', 'no-store').json(summary);
  } catch (e) {
    if (!(e instanceof UpdateError)) throw e;
    const status = e.code === 'updater_unavailable' ? 503 : ['invalid_settings', 'invalid_timezone', 'invalid_version', 'invalid_skip_version', 'invalid_hold_time'].includes(e.code) ? 400 : 409;
    res.status(status).json({ error: '应用更新操作暂不可用', code: e.code });
  }
});
const updateAuth = [requireAuth, requirePrimaryAdmin];
const updateWrite = [...updateAuth, requireCsrf];
const updateTransport = operationTransportGuard(403);
app.get('/api/system/app-update', ...updateAuth, updateRoute('status'));
app.get('/api/system/app-update/history', ...updateAuth, updateRoute('history'));
app.post('/api/system/app-update/check', ...updateWrite, updateRoute('check'));
app.put('/api/system/app-update/settings', ...updateWrite, (req, res, next) => {
  if (req.body?.mode !== 'auto' && !Object.hasOwn(req.body || {}, 'skipTag') && !Object.hasOwn(req.body || {}, 'holdUntil')) return next();
  return updateTransport(req, res, () => maintenancePassword(req, res, next));
}, updateRoute('settings'));
app.post('/api/system/app-update/install', ...updateWrite, updateTransport, maintenancePassword, updateRoute('install'));

app.get('/api/system-updates', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await getUpdateStatus());
  } catch (e) {
    res.status(500).json({ error: '无法检查系统更新状态' });
  }
});

app.post('/api/system/backup', requireAuth, requirePrimaryAdmin, requireCsrf, maintenanceTransport, maintenancePassword, asyncRoute(async (req, res) => {
  if (!maintenanceLock.acquire('backup')) {
    return res.status(409).json({ error: '系统正在执行备份或恢复，请稍后再试' });
  }
  let bundle = null;
  const controller = new AbortController();
  const cancelled = () => { if (!res.writableFinished) controller.abort(); };
  res.once('close', cancelled);
  try {
    bundle = await createBackupBundle({ db, dirs: DIRS, version: APP_VERSION, signal: controller.signal });
    assertCurrentUser(req, null, 'primary');
    if (controller.signal.aborted) throw new Error('Operation cancelled');
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      bundle.cleanup();
      res.removeListener('close', cancelled);
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
    res.removeListener('close', cancelled);
    console.error(`[backup] 生成失败: ${error.message}`);
    if (!res.destroyed) res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '备份生成失败，请确认系统已安装 tar 并检查服务日志' });
  }
}));

// 重启服务:命令是完全写死的,不接受任何用户输入拼接进去,
// 只允许重启"mail-aggregator"这一个固定的service,不能是别的名字。
// mailadmin本身不是root,这里靠一条最小化的sudoers规则完成提权
// (只允许免密执行这一条固定命令,不是 ALL=(ALL) NOPASSWD:ALL)。
// 如果没有配置这条sudo规则,这个操作会失败,用户需要手动执行
// `rc-service mail-aggregator restart`。
app.post('/api/system/restart', requireAuth, requirePrimaryAdmin, requireCsrf, stateRoute((req, res) => {
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
}));

app.get('/api/system/uninstall', requireAuth, requirePrimaryAdmin, (req, res) => {
  res.json({ available: uninstallHost.available() });
});
app.get('/api/system/uninstall/:id', requireAuth, requirePrimaryAdmin, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await uninstallHost.status(req.params.id));
}));
app.post('/api/system/uninstall', requireAuth, requirePrimaryAdmin, requireCsrf, currentPasswordGuard('primary'), asyncRoute(async (req, res) => {
  const { mode, confirmation } = req.body || {};
  if (!['remove-app', 'purge'].includes(mode)) return res.status(400).json({ error: '卸载模式无效' });
  const expected = mode === 'purge' ? 'PURGE' : 'REMOVE';
  if (confirmation !== expected) return res.status(400).json({ error: `当前卸载模式必须输入 ${expected}` });
  if (maintenanceLock.current() || require('./state-lock').stateWritesBlocked(DIRS.root)) {
    return res.status(409).json({ error: '另一项维护正在进行，请稍后重试' });
  }
  const receipt = await uninstallHost.queue(mode);
  res.locals.auditOperationId = receipt.id;
  // The independent worker is holding the maintenance lock but may not stop
  // this process until the acceptance has been handed to the HTTP socket.
  res.once('finish', () => {
    uninstallHost.commit(receipt.id).catch(() => console.error('[uninstall] 未能交接操作回执:', receipt.id));
  });
  res.status(202).set('Cache-Control', 'no-store').json({ ...receipt, message: '宿主已受理，服务停止后请在主机查看最终回执。' });
}));

// v0.1.3: Dovecot密码管理
app.get('/api/dovecot/status', requireAuth, requirePrimaryAdmin, asyncRoute(async (req, res) => {
  const dovecotStatus = await getDovecotSnapshot();
  assertCurrentUser(req, null, 'primary');
  res.json(dovecotStatus);
}));

app.post('/api/dovecot/change-password', requireAuth, requirePrimaryAdmin, requireCsrf, stateRoute(async (req, res) => {
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
    invalidateHealth();
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ ok: true });
  } catch (e) {
    // 兜底:任何未预期的异常都不能把密码内容带进错误信息里
    res.status(500).json({ error: '修改密码过程中发生未预期的错误,请查看服务端日志' });
  }
}));

app.get('/api/dashboard', requireAuth, asyncRoute(async (req, res) => {
  const view = req.query.view;
  if (view !== undefined && !['accounts', 'system', 'dovecot'].includes(view)) return res.status(400).json({ error: '无效的首页区域' });
  let system = null;
  let dovecotStatus = null;
  if (view !== 'accounts' && req.user.role === 'admin') {
    [system, dovecotStatus] = await Promise.all([
      view !== 'dovecot' ? dashboardSystem() : null,
      view !== 'system' ? getDovecotSnapshot() : null,
    ]);
    assertCurrentUser(req, null, 'admin');
  }
  if (view === 'system') return res.json({ system });
  if (view === 'dovecot') return res.json({ dovecotStatus });
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
}));

async function dashboardSystem() {
  const { local, reachable, installed } = await getHealthOverview();
  return getSystemStatus(local.host, local.port, scheduler.getStatus(), { reachable, imapsync: installed.imapsync });
}

// HTML页面在服务端先检查会话，避免未登录用户直接看到管理界面骨架。
// CSS/JS仍可公开读取，它们不包含密码或运行数据。
app.use((req, res, next) => {
  const pathname = req.path.toLowerCase();
  const protectedPage = pathname === '/' || pathname.endsWith('.html');
  if (!['GET', 'HEAD'].includes(req.method) || !protectedPage || pathname === '/login.html') return next();
  const user = sessionUser(req);
  if (user?.role === 'operator' && !['/operations.html', '/profile.html'].includes(pathname)) return res.redirect('/operations.html');
  if (user && pathname === '/operations.html' && user.role !== 'operator' && !(user.role === 'admin' && user.mail_access_all)) {
    return res.redirect('/index.html');
  }
  if (user && ['/users.html', '/system-info.html'].includes(pathname) && user.role !== 'admin') {
    return res.redirect('/index.html');
  }
  if (user && pathname === '/settings.html' && !(user.role === 'admin' && user.mail_access_all)) {
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

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.statusCode || error.status || 500);
  if (status >= 500) console.error('[http]', error.message);
  res.status(status >= 400 && status <= 599 ? status : 500).json({
    error: [401, 403, 409].includes(status) || String(error.code || '').startsWith('PASSWORD_') ? error.message
      : status < 500 ? '请求格式不合法或不受支持' : '操作失败，请检查服务日志',
  });
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
  updateGate.start(server).catch(error => {
    console.error('[updater] 无法启动本机就绪检查:', error.message);
    process.exitCode = 1;
    server.close(() => process.exit(1));
  });
});

const shutdown = createShutdownController({
  server,
  stopScheduler: () => scheduler.stop(),
  stopMaintenance: () => {
    if (logCleanupTimer) clearInterval(logCleanupTimer);
    updates.stop();
    notifications.stopDeliveries();
    operations.close();
    updateGate.close();
  },
  // shutdownGracefully 会停止队列继续启动任务，并在现有 imapsync 完成
  // SIGTERM -> 10秒后SIGKILL 的终止链路、日志关闭和任务状态提交后 resolve。
  terminateChildren: () => Promise.all([shutdownGracefully(), passwordHasher.close(), mailParser.close(), mailTasks.close(), notifications.drainDeliveries()]),
  forceExitDelayMs: 15000,
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
