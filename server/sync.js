const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db, DIRS } = require('./db');
const {
  resolveTargetPassPath,
  hasSourceSecret,
  hasOAuthTokens,
} = require('./credentials');
const notifications = require('./notifications');
const { settleSyncJob, markSyncTransferStarted } = require('./sync-settlement');
const { blockedOutcome, deferQueuedSync, saveAccountBlock, needsSyncReview } = require('./sync-availability');
const { providerGroup, providerConcurrency, readProviderCooldown, recordProviderCooldown } = require('./sync-provider-policy');
const { parseSqliteUtc } = require('./scheduler-core');
const { createOutputCollector, categorizeSyncFailure } = require('./sync-output');
const { createCappedLog } = require('./capped-log');
const { createProcessTerminator } = require('./process-terminator');
const { applyDestinationStrategy } = require('./folder-strategy');
const { applySourceAuthentication } = require('./imapsync-auth');
const { applySourceTransport } = require('./source-transport');
const { applySyncPolicy } = require('./sync-policy');
const jobStore = require('./job-store');
const maintenanceLock = require('./maintenance-lock');
const { assertPublicImapHost, assertSecureAccountEndpoint } = require('./network-policy');
const { getProvider } = require('./providers');
const { syncDiskCapacity, integerSetting } = require('./resource-limits');
const { childEnvironment } = require('./child-environment');
const { applyTargetTransport } = require('./target-transport');
const { runAccountImapProbe, probeUnavailable, probeError } = require('./account-imap-probe');
const { stateWritesBlocked, withStateLock } = require('./state-lock');

// account_id -> true,表示该账号当前正在同步中(内存锁,和DB的status='running'保持一致,
// 用于同一进程内的快速判断;真正防重复排队的兜底保证来自DB的部分唯一索引)
const runningLocks = new Map();
// account_id -> { jobId, child, requestTermination }，只保存当前Node进程实际
// 启动并持有的子进程。取消任务时不根据数据库里的PID盲目终止系统进程。
const runningChildren = new Map();
const connectionTests = new Map();
const preparingJobs = new Set();
const preparingControls = new Map();
let queueFault = null;
const pendingResults = new Map();
const RECHECK_QUEUE_MS = 15000;

function degradeQueue(error, message, now = Date.now()) {
  const prior = queueFault;
  const delay = prior ? Math.min((prior.delay || RECHECK_QUEUE_MS) * 2, 60000) : RECHECK_QUEUE_MS;
  queueFault = { since: prior?.since || new Date(now).toISOString(), nextProbeAt: new Date(now + delay).toISOString(), delay };
  console.error(`[sync] ${message}:`, error.message);
}

function syncQueueHealth() {
  return queueFault ? { degraded: true, since: queueFault.since, nextProbeAt: queueFault.nextProbeAt,
    pendingResults: pendingResults.size } : { degraded: false, since: null, nextProbeAt: null, pendingResults: 0 };
}

function probeQueue() {
  if (!queueFault || Date.now() < Date.parse(queueFault.nextProbeAt)) return !queueFault;
  if (shuttingDown || maintenanceLock.current() === 'restore' || stateWritesBlocked(DIRS.root)) return false;
  try {
    db.prepare(`INSERT INTO settings(key,value) VALUES('sync_queue_last_probe_at',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(new Date().toISOString());
    for (const [id, entry] of pendingResults) {
      commitJob(id, entry.accountId, entry.result);
      pendingResults.delete(id);
    }
    if (!reconcileStaleJobs()) throw new Error('上次运行的同步进程仍未退出');
    queueFault = null;
    return true;
  } catch (error) {
    degradeQueue(error, '队列仍需核对');
    return false;
  }
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function accountCacheDir(accountId) {
  const dir = path.join(DIRS.cache, String(accountId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAccount(accountId) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
}

// 构建imapsync参数数组。密码使用passfile，OAuth访问令牌也只传权限600的
// 文件路径，任何凭据都不会出现在进程命令行。
function buildArgs(account, { sourceAddress } = {}) {
  if (account.destination_mode === 'flat') {
    const owner = db.prepare('SELECT mail_access_all FROM admin_users WHERE id=?').get(account.owner_user_id);
    if (account.mailbox_folder || !owner || !owner.mail_access_all) throw new Error('公共目录仅允许旧版主管理员账号使用');
  }
  if (!sourceAddress) throw new Error('缺少已校验的 IMAP 地址');
  const { localDovecot } = require('./config');
  const local = localDovecot();
  const localHost = local.host;
  const localPort = local.port;

  const args = [
    '--host1', sourceAddress,
    '--port1', String(account.port),
    '--user1', account.username,

    '--host2', localHost,
    '--port2', String(localPort),
    '--user2', account.local_user,
    '--passfile2', resolveTargetPassPath(account.id),

    '--useuid',
    // Keep local read/unread edits on messages that have already been copied.
    '--noresyncflags',
    '--tmpdir', accountCacheDir(account.id),
    '--nofoldersizes',
    '--addheader',
    '--nolog',
  ];

  applySourceAuthentication(args, account);

  applySourceTransport(args, account);

  applyDestinationStrategy(args, account);
  applySyncPolicy(args, account);

  return applyTargetTransport(args, local);
}

function maxConcurrent() {
  const value = parseInt(getSetting('max_concurrent_syncs', '1'), 10);
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 1;
}

function syncTimeoutMinutes() {
  const value = parseInt(getSetting('sync_timeout_minutes', '120'), 10);
  return Number.isInteger(value) && value >= 5 && value <= 1440 ? value : 120;
}

function maxJobLogBytes() {
  const value = parseInt(getSetting('max_job_log_mb', '16'), 10);
  const megabytes = Number.isInteger(value) && value >= 1 && value <= 256 ? value : 16;
  return megabytes * 1024 * 1024;
}

function currentRunningCount() {
  return runningLocks.size;
}

let shuttingDown = false;

function isAccountLocked(accountId) {
  return runningLocks.has(Number(accountId)) || connectionTests.has(Number(accountId));
}

function hasActiveJob(accountId) {
  return jobStore.hasActiveJob(db, accountId);
}

function accountHasCredential(account) {
  return account.auth_type === 'oauth2'
    ? hasOAuthTokens(account.id)
    : hasSourceSecret(account.id);
}

function storageTarget(account = null) {
  const local = require('./config').localDovecot();
  if (account) local.user = account.local_user;
  return local;
}

function storageCapacity(account = null, priority = 1, fresh = false) {
  return syncDiskCapacity(db, DIRS, storageTarget(account), { priority, fresh });
}

function capacityReason(capacity) {
  // The reserve can change after an asynchronous probe has completed.
  if (capacity.status === 'busy') return 'disk_check_busy';
  if (Number(capacity.availableInodes) === 0 && capacity.availableInodes != null) return 'low_inodes';
  const minimum = integerSetting(db, 'min_free_disk_mb', 512, 64, 1048576);
  if (capacity.availableMb !== undefined && capacity.availableMb !== null && capacity.availableMb < minimum) return 'low_disk';
  if (capacity.ok) return null;
  return capacity.availableMb === null ? 'disk_check_failed' : 'low_disk';
}

function storageBlock(reason, capacity) {
  return blockedOutcome(reason, Date.now(), undefined, capacity.scope === 'account' ? 'account' : 'system');
}

function accountIdentity(account) {
  return JSON.stringify(Object.entries(account).filter(([key]) => !key.startsWith('last_')
    && !key.startsWith('sync_block_') && !['sync_failure_count','sync_next_retry_at','sync_result_unknown','sync_review_required','sync_paused_until','sync_pause_started_at','sourceAddress'].includes(key)));
}

function providerBlock(account) {
  const group = providerGroup(account);
  const cooldown = readProviderCooldown(db, group);
  if (cooldown) return blockedOutcome('provider_cooldown', Date.now(), cooldown);
  const sameGroup = [...runningLocks.values(), ...[...connectionTests.values()].map(test => test.providerKey)]
    .filter(key => key === group).length;
  return sameGroup >= providerConcurrency(db, group) ? blockedOutcome('provider_busy') : null;
}

function recordBlock(account, outcome) {
  if (account && outcome.block && !maintenanceActive() && (account.sync_block_code !== outcome.block.code
      || account.sync_next_retry_at !== outcome.nextRetryAt || account.sync_block_scope !== outcome.block.scope)) saveAccountBlock(db, account.id, outcome);
  return outcome;
}

function maintenanceActive() {
  return shuttingDown || Boolean(queueFault) || maintenanceLock.current() === 'restore' || stateWritesBlocked(DIRS.root);
}

// ---- 排队/启动 ----
// 循环填充可用并发名额,队首账号如果因为某种原因暂不可运行,跳过它继续检查
// 下一个,而不是直接return导致整条队列被堵死。
function drainQueue() {
  try { if (probeQueue()) drainQueueUnsafe(); }
  catch (error) { degradeQueue(error, '队列读取失败，已暂停启动新任务'); }
}

function drainQueueUnsafe() {
  if (maintenanceActive()) return;
  let guard = 0; // 防御性上限,避免任何未预见的逻辑错误导致死循环
  while (currentRunningCount() + connectionTests.size < maxConcurrent() && guard < 100) {
    guard++;
    const queued = jobStore.findNextQueuedJob(db);
    if (!queued) break;
    const preparation = runJob(queued).catch((error) => {
      preparingControls.delete(Number(queued.account_id));
      const current = jobStore.getJobForAccount(db, queued.id, queued.account_id);
      if (current && ['queued', 'running'].includes(current.status)) {
        finishJob(queued.id, queued.account_id, { status: 'failed', expected: current.status, category: 'spawn_failed',
          message: '同步准备失败，请检查应用目录和日志' });
      } else {
        runningLocks.delete(Number(queued.account_id));
      }
    });
    const guardedPreparation = preparation.catch(error => {
      runningLocks.delete(Number(queued.account_id));
      degradeQueue(error, '队列准备结果无法核对');
    });
    preparingJobs.add(guardedPreparation);
    guardedPreparation.finally(() => preparingJobs.delete(guardedPreparation));
    if (!runningLocks.has(Number(queued.account_id))) break;
  }
}

async function runJob(job) {
  const account = getAccount(job.account_id);
  if (!account) {
    finishJob(job.id, job.account_id, { status: 'failed', expected: 'queued', category: 'configuration_changed', message: '账号已移除' });
    return;
  }
  // Reserve before the first await so overlapping drains cannot select the
  // same queued job or exceed the global sync/test concurrency budget.
  const groupBlock = providerBlock(account);
  runningLocks.set(account.id, providerGroup(account));
  const preparation = { cancelled: false };
  preparingControls.set(account.id, preparation);
  const reserved = db.prepare(`UPDATE sync_jobs SET status='running',stage='preparing',result_code=NULL,next_attempt_at=NULL
      WHERE id=? AND account_id=? AND status='queued'`).run(job.id, account.id);
  if (reserved.changes !== 1) {
    preparingControls.delete(account.id);
    runningLocks.delete(account.id);
    return;
  }
  const yieldSlot = () => {
    preparingControls.delete(account.id);
    runningLocks.delete(account.id);
    setImmediate(drainQueue);
  };
  function checkSchedule(current) {
    if (job.trigger_source !== 'scheduled') return false;
    if (!current.enabled) {
      preparingControls.delete(account.id);
      finishJob(job.id, account.id, { status: 'cancelled', code: 'schedule_disabled', message: '定时同步已关闭，传输未开始' });
      return true;
    }
    if (parseSqliteUtc(current.sync_paused_until) <= Date.now()) return false;
    deferQueuedSync(db, job.id, account.id, blockedOutcome('account_paused', Date.now(), current.sync_paused_until));
    yieldSlot();
    return true;
  }
  if (checkSchedule(account)) return;
  if (groupBlock) {
    deferQueuedSync(db, job.id, account.id, groupBlock);
    preparingControls.delete(account.id);
    runningLocks.delete(account.id);
    setImmediate(drainQueue);
    return;
  }
  const identity = accountIdentity(account), target = JSON.stringify(storageTarget(account));
  const capacity = await storageCapacity(account);
  const current = getAccount(account.id);
  if (preparation.cancelled || maintenanceActive() || !current || accountIdentity(current) !== identity
      || JSON.stringify(storageTarget(current)) !== target) {
    preparingControls.delete(account.id);
    finishJob(job.id, account.id, { status: 'cancelled', code: preparation.cancelled ? 'cancelled' : 'preparation_cancelled', exitCode: -1,
      durationMs: 0, message: '同步准备已取消、配置已变更或服务正在维护' });
    return;
  }
  if (checkSchedule(current)) return;
  const initialBlock = capacityReason(capacity);
  if (initialBlock) {
    deferQueuedSync(db, job.id, account.id, storageBlock(initialBlock, capacity));
    preparingControls.delete(account.id);
    runningLocks.delete(account.id);
    setImmediate(drainQueue);
    return;
  }

  const logFile = path.join(DIRS.logs, `job-${job.id}.log`);
  let logStream;
  const startedAt = Date.now();
  let completed = false;
  let timeoutTimer = null;
  let diskTimer = null;
  let terminator = null;

  // ChildProcess 在启动失败时可能先触发 error，随后仍触发 close。任务完成必须
  // 只提交一次，否则会重复更新状态、发送失败通知和拉起后续队列任务。
  // 同时等待 WriteStream 真正关闭，确保日志已经完整落盘并释放文件描述符。
  function completeOnce(result) {
    if (completed) return;
    completed = true;
    preparingControls.delete(account.id);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (diskTimer) clearInterval(diskTimer);
    if (terminator) terminator.complete();

    const commit = () => finishJob(job.id, account.id, result);
    if (!logStream || logStream.closed || logStream.destroyed) {
      commit();
      return;
    }

    logStream.once('close', commit);
    logStream.end();
  }

  try {
    assertSecureAccountEndpoint(account, getProvider(account.provider));
    const addresses = await assertPublicImapHost(account.host);
    account.sourceAddress = addresses.find((item) => Number(item.family) === 4)?.address || addresses[0].address;
    // On Linux, bypass the short capacity cache before opening a log or
    // starting a transfer. A mount may have disappeared during DNS checks.
    const readyCapacity = await storageCapacity(account, 1, true);
    const latest = getAccount(account.id);
    if (preparation.cancelled || maintenanceActive() || !latest || accountIdentity(latest) !== identity
        || JSON.stringify(storageTarget(latest)) !== target) {
      completeOnce({ exitCode: -1, durationMs: Date.now() - startedAt, status: 'cancelled', code: preparation.cancelled ? 'cancelled' : 'preparation_cancelled',
        message: '同步准备已取消、配置已变更或服务正在维护' });
      return;
    }
    if (checkSchedule(latest)) return;
    const readyBlock = capacityReason(readyCapacity);
    if (readyBlock) {
      deferQueuedSync(db, job.id, account.id, storageBlock(readyBlock, readyCapacity));
      completed = true;
      preparingControls.delete(account.id);
      runningLocks.delete(account.id);
      setImmediate(drainQueue);
      return;
    }
  } catch (error) {
    const category = categorizeSyncFailure(error.message, 'failed');
    const message = category === 'network' ? '无法解析邮箱服务器地址，请检查网络和域名' : `安全策略拒绝连接: ${error.message}`;
    // Preserve the error in job history without opening a log on storage that
    // has not passed the final preflight.
    completeOnce({
      exitCode: -1,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      message,
      category,
    });
    return;
  }

  try {
  logStream = createCappedLog(logFile, { maxBytes: maxJobLogBytes() });
  logStream.on('error', (err) => {
    // Log failures cannot crash the Web process or decide the transfer result.
    console.error(`[sync] 任务 ${job.id} 日志写入失败: ${err.message}`);
  });
  const args = buildArgs(account, { justFolders: false, sourceAddress: account.sourceAddress });
  // On Linux, the child cannot touch remote mail until SQLite records its
  // process identity. If the Web process exits earlier, EOF closes the gate.
  // exec preserves the PID and start time across the transition to imapsync.
  const gated = process.platform === 'linux';
  const mirror = account.deletion_mode === 'mirror_messages';
  // Without the Linux pipe gate this launch is already uncertain if the
  // parent exits at spawn. Never classify that window as safe to requeue.
  if (!gated) db.prepare(`UPDATE sync_jobs SET transport_state=NULL,mirror_at_release=? WHERE id=?`).run(mirror ? 1 : 0, job.id);
  const child = gated
    ? spawn('/bin/sh', ['-c', 'IFS= read -r gate && [ "$gate" = start ] && exec imapsync "$@"', 'mail-aggregator-sync', ...args],
      { env: childEnvironment(DIRS.root) })
    : spawn('imapsync', args, { env: childEnvironment(DIRS.root) });
  if (gated) child.stdin.on('error', () => {});
  terminator = createProcessTerminator({ child, jobId: job.id });
  const requestTermination = (status, message) => terminator.request(status, message);

  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });

  runningChildren.set(account.id, {
    jobId: job.id,
    child,
    requestTermination,
    completion,
    resolveCompletion,
  });
  preparingControls.delete(account.id);
  // 任务运行期间日志页也要能读取正在增长的文件，因此日志路径必须在启动时
  // 就持久化，不能等到 finishJob() 才写入。
  // Persist only after error/close handlers have been installed below.

  const timeoutMinutes = syncTimeoutMinutes();
  timeoutTimer = setTimeout(() => {
    requestTermination('timed_out', `同步超过 ${timeoutMinutes} 分钟，正在终止 imapsync`);
  }, timeoutMinutes * 60 * 1000);
  timeoutTimer.unref();

  let diskCheckPending = false;
  let capacityConfirmedAt = Date.now();
  let storageFailureCode = null;
  diskTimer = setInterval(async () => {
    if (diskCheckPending || completed) return;
    diskCheckPending = true;
    let currentCapacity;
    try { currentCapacity = await storageCapacity(account, 2); }
    catch (_) { currentCapacity = { ok: false, availableMb: null }; }
    finally { diskCheckPending = false; }
    // A late result must never write to a closed log or stop a later job.
    if (completed) return;
    const unavailable = capacityReason(currentCapacity);
    if (!unavailable) { capacityConfirmedAt = Date.now(); return; }
    if (currentCapacity.status === 'busy' && Date.now() - capacityConfirmedAt < 15000) return;
    const reason = unavailable === 'low_inodes'
      ? '存储文件节点已用尽，正在安全终止同步'
      : currentCapacity.failure === 'read_only' ? '同步依赖的存储已变为只读，正在安全终止同步'
      : ['mount_changed','mount_required'].includes(currentCapacity.failure) ? '同步依赖的存储挂载已变化，正在安全终止同步'
      : currentCapacity.availableMb === null
      ? '运行中无法确认剩余磁盘空间，正在安全终止同步'
      : `可用磁盘空间降至 ${currentCapacity.availableMb} MB（安全下限 ${currentCapacity.minimumMb} MB），正在终止同步`;
    logStream.write(`\n${reason}\n`);
    if (requestTermination('failed', reason)) storageFailureCode = storageBlock(unavailable, currentCapacity).block.code;
  }, 5000);
  diskTimer.unref();

  const output = createOutputCollector();
  child.stdout.on('data', (chunk) => {
    output.push(chunk, 'stdout');
    logStream.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output.push(chunk, 'stderr');
    logStream.write(chunk);
  });

  child.on('error', (err) => {
    completeOnce({
      exitCode: -1,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      category: 'spawn_failed',
      message: '无法启动 imapsync，请检查应用和服务日志',
      logFile,
    });
  });

  child.on('close', (code) => {
    // imapsync的统计摘要行不一定只出现在stdout里,不同版本/不同触发路径下
    // 可能会写到stderr,所以解析前把两路输出合并再喂给parseSummary,
    // 而不是只看stdout。原始日志文件本来就已经完整包含stdout+stderr,不受影响。
    const { summary, tail, sourceRateLimited } = output.finish();
    const termination = terminator.getTermination();
    const status = termination ? termination.status : code === 0 ? 'success' : 'failed';
    const category = storageFailureCode && status === 'failed' ? storageFailureCode
      : status === 'failed' || status === 'timed_out' ? categorizeSyncFailure(tail, status, sourceRateLimited) : null;
    const message =
      termination
        ? termination.message
        : code === 0
        ? `同步成功,复制 ${summary.messagesTransferred ?? 'N/A'},跳过 ${summary.messagesSkipped ?? 'N/A'}`
        : category === 'provider_rate_limited' ? '邮箱服务商暂时限流，冷却后重试'
        : category === 'auth_failed' ? '邮箱认证失败，请检查授权和本地邮箱凭据'
        : category === 'network' ? '邮箱网络连接失败，请检查网络后重试'
        : category === 'tls_failed' ? '邮箱 TLS 连接失败，请检查证书和服务器配置'
        : `imapsync 退出码 ${code},请查看日志`;
    completeOnce({
      exitCode: code,
      durationMs: Date.now() - startedAt,
      status,
      message,
      category,
      logFile,
      summary,
      ...(termination && status !== 'cancelled' && mirror ? { resultKnown: false } : {}),
    });
  });
  if (child.pid && markSyncTransferStarted(db, job.id, account.id,
      { pid: child.pid, pidIdentity: procIdentity(child.pid), logFile, mirror, now: new Date().toISOString() })) {
    if (gated) child.stdin.end('start\n');
  } else if (child.pid) {
    if (gated) child.stdin.end();
    requestTermination('interrupted', '任务已不能继续，请检查服务状态');
  }
  } catch (error) {
    const control = runningChildren.get(account.id);
    if (control) {
      control.child.stdin?.destroy();
      // Spawn may have succeeded while the SQLite start record failed. Stop
      // this process and keep the external outcome unknown until reconciled.
      control.requestTermination('interrupted', '任务启动状态无法确认，请核对同步结果');
      degradeQueue(error, '同步进程已启动但无法保存其状态');
      logStream.write('同步准备失败，请检查服务日志\n');
      console.error('[sync] 同步准备失败:', error.message);
    } else {
      completeOnce({ exitCode: -1, durationMs: Date.now() - startedAt, status: 'failed', message: '同步准备失败，请检查目录权限与配置', logFile: logStream ? logFile : null });
    }
  }
}

function finishJob(jobId, accountId, result) {
  const entry = { accountId, result: { ...result, finishedAt: result.finishedAt || new Date().toISOString() } };
  try { commitJob(jobId, accountId, entry.result); }
  catch (error) {
    pendingResults.set(jobId, entry);
    degradeQueue(error, '任务结果写入失败，已暂停队列');
  } finally {
    runningLocks.delete(accountId);
    const control = runningChildren.get(accountId);
    runningChildren.delete(accountId);
    if (control) control.resolveCompletion();
    setImmediate(drainQueue);
  }
}

function commitJob(jobId, accountId, result) {
  const settled = settleSyncJob(db, jobId, accountId, result, (store, intent) => {
    if (intent.category === 'provider_rate_limited') {
      const account = getAccount(accountId);
      if (account) recordProviderCooldown(store, providerGroup(account), intent.occurredAt);
    }
    notifications.recordSyncNotificationIntent?.(store, intent);
  });
  if (settled.intent && notifications.wakeSyncNotificationDelivery) {
    try { notifications.wakeSyncNotificationDelivery(); } catch (error) { console.error('[notifications] 无法唤醒派送:', error.message); }
  }
  return settled;
}

// 供API/Scheduler调用:触发一次同步。
// 如果该账号已经有 queued 或 running 的任务,直接拒绝,不再插入新记录。
async function triggerSync(accountId, { authorize = null, enabledOnly = false,
  triggerSource = enabledOnly ? 'scheduled' : 'manual', ownerUserId = null, confirmUnknown = false } = {}) {
  if (maintenanceActive()) return blockedOutcome(queueFault ? 'queue_degraded' : 'maintenance', Date.now(), queueFault?.nextProbeAt);
  const account = getAccount(accountId);
  if (!account || (ownerUserId !== null && Number(account.owner_user_id) !== Number(ownerUserId))) return { ok: false, reason: 'not_found' };
  if (!accountHasCredential(account)) {
    const missing = blockedOutcome(account.auth_type === 'oauth2' ? 'authorization_required' : 'missing_credentials');
    return recordBlock(account, missing);
  }
  if (needsSyncReview(account) && !confirmUnknown) {
    return blockedOutcome('confirm_unknown_result');
  }
  const pausedUntil = parseSqliteUtc(account.sync_paused_until);
  if (triggerSource === 'scheduled' && pausedUntil > Date.now()) return blockedOutcome('account_paused', Date.now(), account.sync_paused_until);
  if (triggerSource === 'scheduled' && parseSqliteUtc(account.sync_next_retry_at) > Date.now() && account.sync_block_code) {
    // A scheduled retry is driven by durable state. Manual attempts may recheck
    // capacity sooner, but still cannot bypass the underlying safety limit.
    const currentBlock = { low_space: 'low_disk', low_inodes: 'low_inodes', capacity_unavailable: 'disk_check_failed',
      capacity_busy: 'disk_check_busy', provider_cooldown: 'provider_cooldown', provider_busy: 'provider_busy' }[account.sync_block_code];
    if (currentBlock) return blockedOutcome(currentBlock, Date.now(), account.sync_next_retry_at, account.sync_block_scope ?? undefined);
  }
  if (isAccountLocked(accountId)) return { ok: false, reason: 'already_running' };
  const identity = accountIdentity(account), target = JSON.stringify(storageTarget(account));
  const capacity = await storageCapacity(account);
  const result = withStateLock(DIRS.root, () => {
    if (authorize) authorize();
    // This callback owns the short state lock. Other operations still cannot
    // start while the durable queue is degraded.
    if (maintenanceActive()) return blockedOutcome(queueFault ? 'queue_degraded' : 'maintenance', Date.now(), queueFault?.nextProbeAt);
    const current = getAccount(accountId);
    if (!current || (ownerUserId !== null && Number(current.owner_user_id) !== Number(ownerUserId))) return { ok: false, reason: 'not_found' };
    if (accountIdentity(current) !== identity || JSON.stringify(storageTarget(current)) !== target
        || (enabledOnly && !current.enabled)) return { ok: false, reason: 'configuration_changed' };
    if (triggerSource === 'scheduled' && parseSqliteUtc(current.sync_paused_until) > Date.now()) return blockedOutcome('account_paused', Date.now(), current.sync_paused_until);
    if (needsSyncReview(current) && !confirmUnknown) return blockedOutcome('confirm_unknown_result');
    if (!accountHasCredential(current)) return recordBlock(current,
      blockedOutcome(current.auth_type === 'oauth2' ? 'authorization_required' : 'missing_credentials'));
    const reason = capacityReason(capacity);
    if (reason) return recordBlock(current, storageBlock(reason, capacity));
    const groupBlock = providerBlock(current);
    if (groupBlock?.reason === 'provider_cooldown') return recordBlock(current, groupBlock);
    if (isAccountLocked(accountId)) return { ok: false, reason: 'already_running' };
    const queued = jobStore.enqueueJob(db, accountId, triggerSource);
    return { ...queued, outcome: queued.ok ? 'accepted' : 'skipped' };
  });
  if (result.ok) {
    drainQueue();
  }
  return result;
}

// 取消排队任务，或停止当前Node进程实际持有的运行任务。
// accountId来自嵌套路由，用于确保URL里的账号和任务真实归属一致。
function cancelJob(jobId, accountId) {
  const job = jobStore.getJobForAccount(db, jobId, accountId);
  if (!job) return { ok: false, reason: 'not_found' };

  if (job.status === 'queued') {
    return jobStore.cancelQueuedJob(db, jobId, accountId);
  }

  if (job.status === 'running') {
    const pending = preparingControls.get(Number(accountId));
    if (pending) {
      db.prepare("UPDATE sync_jobs SET stage='cancelling' WHERE id=? AND account_id=? AND status='running'").run(job.id, accountId);
      pending.cancelled = true;
      return { ok: true, status: 'cancelling' };
    }
    const control = runningChildren.get(job.account_id);
    if (!control || Number(control.jobId) !== Number(job.id)) {
      return { ok: false, reason: 'not_owned' };
    }
    const accepted = control.requestTermination('cancelled', '用户已请求停止同步');
    return accepted
      ? { ok: true, status: 'cancelling' }
      : { ok: false, reason: 'already_stopping' };
  }

  return { ok: false, reason: 'not_cancellable' };
}

// v0.1.6: 对失败/中断/已取消的历史任务创建一个新的同步任务。
// 不复用旧记录，保留完整审计轨迹；仍然通过账号级唯一索引防止重复排队。
async function retryJob(jobId, ownerUserId = null, { authorize = null, confirmUnknown = false } = {}) {
  if (maintenanceActive()) return blockedOutcome(queueFault ? 'queue_degraded' : 'maintenance', Date.now(), queueFault?.nextProbeAt);
  const previous = ownerUserId === null
    ? db.prepare('SELECT account_id,status,result_known FROM sync_jobs WHERE id=?').get(jobId)
    : db.prepare(`SELECT j.account_id,j.status,j.result_known FROM sync_jobs j JOIN accounts a ON a.id=j.account_id
        WHERE j.id=? AND a.owner_user_id=?`).get(jobId, ownerUserId);
  if (!previous) return { ok: false, reason: 'not_found' };
  const account = getAccount(previous.account_id);
  if (!account || !accountHasCredential(account)) return blockedOutcome(account?.auth_type === 'oauth2' ? 'authorization_required' : 'missing_credentials');
  if ((account.sync_result_unknown || (previous.status === 'interrupted' && previous.result_known !== 1))
      && account.deletion_mode === 'mirror_messages' && !confirmUnknown) {
    return { ok: false, reason: 'confirm_unknown_result', outcome: 'skipped' };
  }
  if (isAccountLocked(account.id)) return { ok: false, reason: 'already_running' };
  const identity = accountIdentity(account), target = JSON.stringify(storageTarget(account));
  const capacity = await storageCapacity(account);
  const result = withStateLock(DIRS.root, () => {
    if (authorize) authorize();
    if (maintenanceActive()) return { ok: false, reason: 'maintenance' };
    const current = getAccount(account.id);
    if (!current || (ownerUserId !== null && Number(current.owner_user_id) !== Number(ownerUserId))) return { ok: false, reason: 'not_found' };
    if (accountIdentity(current) !== identity || JSON.stringify(storageTarget(current)) !== target) return { ok: false, reason: 'configuration_changed' };
    if (needsSyncReview(current) && !confirmUnknown) return blockedOutcome('confirm_unknown_result');
    if (!accountHasCredential(current)) return recordBlock(current,
      blockedOutcome(current.auth_type === 'oauth2' ? 'authorization_required' : 'missing_credentials'));
    const reason = capacityReason(capacity);
    if (reason) return recordBlock(current, storageBlock(reason, capacity));
    const groupBlock = providerBlock(current);
    if (groupBlock?.reason === 'provider_cooldown') return recordBlock(current, groupBlock);
    if (isAccountLocked(account.id)) return { ok: false, reason: 'already_running' };
    return jobStore.retryJob(db, jobId);
  });
  if (result.ok) {
    drainQueue();
  }
  return result;
}

async function triggerAllEnabled(ownerUserId = null, { authorize = null } = {}) {
  const accounts = ownerUserId === null
    ? db.prepare('SELECT id FROM accounts WHERE enabled = 1 ORDER BY id').all()
    : db.prepare('SELECT id FROM accounts WHERE enabled=1 AND owner_user_id=? ORDER BY id').all(ownerUserId);
  const result = { queued: [], skipped: [] };
  for (const account of accounts) {
    const outcome = await triggerSync(account.id, { authorize, enabledOnly: true, triggerSource: 'bulk', ownerUserId });
    if (outcome.ok) result.queued.push(outcome.jobId);
    else result.skipped.push({ accountId: account.id, reason: outcome.reason });
  }
  return result;
}

function cancelAllQueued(ownerUserId = null) {
  return jobStore.cancelAllQueued(db, ownerUserId);
}

// ---- 连接测试:60秒后请求终止,错误分类,不做正式同步 ----
async function testConnection(accountId, options = {}) {
  accountId = Number(accountId);
  const assertOperational = () => {
    if (shuttingDown || maintenanceLock.current() === 'restore') throw probeError('maintenance');
  };
  options.authorize?.();
  if (shuttingDown || maintenanceLock.current() === 'restore' || stateWritesBlocked(DIRS.root)) return probeUnavailable('maintenance');
  if (isAccountLocked(accountId) || hasActiveJob(accountId) || currentRunningCount() + connectionTests.size >= maxConcurrent()) {
    return probeUnavailable('busy');
  }
  const account = getAccount(accountId);
  if (!account) return probeUnavailable('not_found');
  if (providerBlock(account)) return probeUnavailable('busy');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  connectionTests.set(accountId, { completion, providerKey: providerGroup(account), requestTermination() { controller.abort(probeError('interrupted')); } });
  try {
    return await runAccountImapProbe(account, { ...options, signal, assertOperational });
  } finally {
    connectionTests.delete(accountId);
    resolveCompletion();
    setImmediate(drainQueue);
  }
}

// ---- 应用启动恢复 ----
// Web服务可能在同步进行中被重启(rc-service restart / 机器重启 / crash)。
// 这种情况下内存里的runningLocks会丢失,但DB里的 status='running' 记录会
// 永久残留,导致: 1) Dashboard一直显示"正在同步" 2) 该账号被永久锁死无法再同步。
// 已退出的上次子进程可核对为 interrupted。仍有身份匹配的进程时，延后启动任务，
// 不会根据可能已被重用的 PID 发送信号。
let bootIdentity;
function procIdentity(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    bootIdentity ||= fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (fields[0] === 'Z' || !/^\d+$/.test(fields[19])) return null;
    return `${bootIdentity}:${fields[19]}`;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    // An unreadable live PID must never be assumed to have already exited.
    return 'unverified';
  }
}

function reconcileStaleJobs() {
  let waiting = false;
  const reconciled = jobStore.reconcileRunningJobs(db, job => {
    if (runningLocks.has(job.account_id) || pendingResults.has(job.id)) return false;
    const identity = procIdentity(job.pid);
    if (!identity) return true;
    if (identity === 'unverified' || identity === job.pid_identity) { waiting = true; return false; }
    if (job.pid_identity && job.pid_identity !== 'unverified') return true;
    // Existing releases had no process identity. Wait only for a live imapsync,
    // and do not signal it merely because a reused PID has a familiar name.
    try {
      if (fs.readFileSync(`/proc/${job.pid}/cmdline`, 'utf8').includes('imapsync')) { waiting = true; return false; }
    } catch (error) {
      if (!['ENOENT','ESRCH'].includes(error.code)) { waiting = true; return false; }
    }
    return true;
  });
  if (reconciled.length) console.log(`[startup] 已核对 ${reconciled.length} 个中断的同步任务`);
  return !waiting;
}

function reconcileAfterRestart() {
  try {
    if (!reconcileStaleJobs()) throw new Error('上次运行的同步进程仍未退出');
  } catch (error) { degradeQueue(error, '启动时同步任务待核对'); }
}

// 优雅关闭:尽量终止正在跑的子进程,避免留下孤儿进程
async function shutdownGracefully() {
  shuttingDown = true;
  const tests = [...connectionTests.values()];
  tests.forEach((control) => control.requestTermination('interrupted', '服务关闭，测试已中断'));
  await Promise.all([...preparingJobs]);
  const controls = [...runningChildren.values(), ...tests];
  for (const control of controls) {
    control.requestTermination('interrupted', '服务关闭，同步已中断');
  }
  return Promise.all(controls.map((control) => control.completion)).then(() => undefined);
}

function currentConnectionTestCount() {
  return connectionTests.size;
}

module.exports = {
  triggerSync,
  cancelJob,
  retryJob,
  triggerAllEnabled,
  cancelAllQueued,
  testConnection,
  drainQueue,
  isAccountLocked,
  hasActiveJob,
  currentRunningCount,
  currentConnectionTestCount,
  isTestingConnection: accountId => connectionTests.has(Number(accountId)),
  syncQueueHealth,
  maxConcurrent,
  syncTimeoutMinutes,
  maxJobLogBytes,
  reconcileAfterRestart,
  shutdownGracefully,
};
