const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db, DIRS } = require('./db');
const {
  resolveTargetPassPath,
  hasSourceSecret,
  hasOAuthTokens,
} = require('./credentials');
const { notifySyncFailure } = require('./notifications');
const { parseSummary, categorizeTestError } = require('./sync-output');
const { createProcessTerminator } = require('./process-terminator');
const { applyDestinationStrategy } = require('./folder-strategy');
const { applySourceAuthentication } = require('./imapsync-auth');
const { applySyncPolicy } = require('./sync-policy');
const jobStore = require('./job-store');
const maintenanceLock = require('./maintenance-lock');

// account_id -> true,表示该账号当前正在同步中(内存锁,和DB的status='running'保持一致,
// 用于同一进程内的快速判断;真正防重复排队的兜底保证来自DB的部分唯一索引)
const runningLocks = new Map();
// account_id -> { jobId, child, requestTermination }，只保存当前Node进程实际
// 启动并持有的子进程。取消任务时不根据数据库里的PID盲目终止系统进程。
const runningChildren = new Map();
const connectionTests = new Set();

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
function buildArgs(account, { justFolders = false } = {}) {
  const { localDovecot } = require('./config');
  const local = localDovecot();
  const localHost = local.host;
  const localPort = local.port;

  const args = [
    '--host1', account.host,
    '--port1', String(account.port),
    '--user1', account.username,

    '--host2', localHost,
    '--port2', String(localPort),
    '--user2', account.local_user,
    '--passfile2', resolveTargetPassPath(account.id),

    '--useuid',
    '--tmpdir', accountCacheDir(account.id),
    '--nofoldersizes',
    '--addheader',
    '--nolog',
  ];

  applySourceAuthentication(args, account);

  if (account.ssl) {
    args.push('--ssl1');
  }

  applyDestinationStrategy(args, account);
  applySyncPolicy(args, account, { justFolders });

  if (justFolders) {
    args.push('--justfolders');
  }

  return args;
}

function maxConcurrent() {
  const value = parseInt(getSetting('max_concurrent_syncs', '1'), 10);
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 1;
}

function syncTimeoutMinutes() {
  const value = parseInt(getSetting('sync_timeout_minutes', '120'), 10);
  return Number.isInteger(value) && value >= 5 && value <= 1440 ? value : 120;
}

function currentRunningCount() {
  return runningLocks.size;
}

let shuttingDown = false;

function isAccountLocked(accountId) {
  return runningLocks.has(accountId);
}

function hasActiveJob(accountId) {
  return jobStore.hasActiveJob(db, accountId);
}

function accountHasCredential(account) {
  return account.auth_type === 'oauth2'
    ? hasOAuthTokens(account.id)
    : hasSourceSecret(account.id);
}

// ---- 排队/启动 ----
// 循环填充可用并发名额,队首账号如果因为某种原因暂不可运行,跳过它继续检查
// 下一个,而不是直接return导致整条队列被堵死。
function drainQueue() {
  if (shuttingDown || maintenanceLock.current() === 'restore') return;
  let guard = 0; // 防御性上限,避免任何未预见的逻辑错误导致死循环
  while (currentRunningCount() < maxConcurrent() && guard < 100) {
    guard++;
    const queued = jobStore.findNextQueuedJob(db);
    if (!queued) break;
    runJob(queued);
  }
}

function runJob(job) {
  const account = getAccount(job.account_id);
  if (!account) {
    db.prepare(
      `UPDATE sync_jobs SET status='failed', finished_at=datetime('now') WHERE id=?`
    ).run(job.id);
    return;
  }

  runningLocks.set(account.id, true);
  db.prepare(`UPDATE sync_jobs SET status='running' WHERE id=?`).run(job.id);

  const args = buildArgs(account, { justFolders: false });
  const logFile = path.join(DIRS.logs, `job-${job.id}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const startedAt = Date.now();
  let completed = false;
  let timeoutTimer = null;
  let terminator = null;

  // ChildProcess 在启动失败时可能先触发 error，随后仍触发 close。任务完成必须
  // 只提交一次，否则会重复更新状态、发送失败通知和拉起后续队列任务。
  // 同时等待 WriteStream 真正关闭，确保日志已经完整落盘并释放文件描述符。
  function completeOnce(result) {
    if (completed) return;
    completed = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (terminator) terminator.complete();

    const commit = () => finishJob(job.id, account.id, result);
    if (logStream.closed || logStream.destroyed) {
      commit();
      return;
    }

    logStream.once('close', commit);
    logStream.end();
  }

  logStream.on('error', (err) => {
    // 日志写入失败不应导致整个服务因未处理的 stream error 崩溃。同步结果仍由
    // imapsync 的退出状态决定，日志路径会保留，读取时按文件是否存在处理。
    console.error(`[sync] 任务 ${job.id} 日志写入失败: ${err.message}`);
  });

  const child = spawn('imapsync', args, { env: { PATH: process.env.PATH } });
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
  // 任务运行期间日志页也要能读取正在增长的文件，因此日志路径必须在启动时
  // 就持久化，不能等到 finishJob() 才写入。
  db.prepare(`UPDATE sync_jobs SET pid=?, log_file=? WHERE id=?`)
    .run(child.pid || null, logFile, job.id);

  const timeoutMinutes = syncTimeoutMinutes();
  timeoutTimer = setTimeout(() => {
    requestTermination('timed_out', `同步超过 ${timeoutMinutes} 分钟，正在终止 imapsync`);
  }, timeoutMinutes * 60 * 1000);
  timeoutTimer.unref();

  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    logStream.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    logStream.write(chunk);
  });

  child.on('error', (err) => {
    completeOnce({
      exitCode: -1,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      message: `无法启动 imapsync: ${err.message}`,
      logFile,
    });
  });

  child.on('close', (code) => {
    // imapsync的统计摘要行不一定只出现在stdout里,不同版本/不同触发路径下
    // 可能会写到stderr,所以解析前把两路输出合并再喂给parseSummary,
    // 而不是只看stdout。原始日志文件本来就已经完整包含stdout+stderr,不受影响。
    const combinedOutput = `${stdoutBuf}\n${stderrBuf}`;
    const summary = parseSummary(combinedOutput);
    const termination = terminator.getTermination();
    const status = termination ? termination.status : code === 0 ? 'success' : 'failed';
    const message =
      termination
        ? termination.message
        : code === 0
        ? `同步成功,复制 ${summary.messagesTransferred ?? 'N/A'},跳过 ${summary.messagesSkipped ?? 'N/A'}`
        : `imapsync 退出码 ${code},请查看日志`;
    completeOnce({
      exitCode: code,
      durationMs: Date.now() - startedAt,
      status,
      message,
      logFile,
      summary,
    });
  });
}

function finishJob(jobId, accountId, { exitCode, durationMs, status, message, logFile, summary }) {
  const s = summary || {};
  db.prepare(
    `UPDATE sync_jobs SET
      finished_at = datetime('now'),
      status = ?,
      exit_code = ?,
      duration_ms = ?,
      host1_messages = ?,
      host2_messages = ?,
      host1_folders = ?,
      host2_folders = ?,
      messages_transferred = ?,
      messages_skipped = ?,
      errors = ?,
      log_file = ?
     WHERE id = ?`
  ).run(
    status,
    exitCode,
    durationMs,
    s.host1Messages ?? null,
    s.host2Messages ?? null,
    s.host1Folders ?? null,
    s.host2Folders ?? null,
    s.messagesTransferred ?? null,
    s.messagesSkipped ?? null,
    s.errors ?? null,
    logFile,
    jobId
  );

  // 邮件总数/文件夹数/复制/跳过/错误 各自独立用COALESCE保留上一次可信值,
  // 避免某个字段这次没解析出来就被误覆盖成空
  db.prepare(
    `UPDATE accounts SET
      last_sync_at = datetime('now'),
      last_sync_status = ?,
      last_sync_message = ?,
      last_host2_messages = COALESCE(?, last_host2_messages),
      last_host2_folders = COALESCE(?, last_host2_folders),
      last_transferred = COALESCE(?, last_transferred),
      last_skipped = COALESCE(?, last_skipped),
      last_errors = COALESCE(?, last_errors)
     WHERE id = ?`
  ).run(
    status,
    message,
    s.host2Messages ?? null,
    s.host2Folders ?? null,
    s.messagesTransferred ?? null,
    s.messagesSkipped ?? null,
    s.errors ?? null,
    accountId
  );

  runningLocks.delete(accountId);
  const control = runningChildren.get(accountId);
  runningChildren.delete(accountId);
  if (control) control.resolveCompletion();
  if (status === 'success') {
    db.prepare('DELETE FROM notification_events WHERE account_id=?').run(accountId);
  } else if (status === 'failed' || status === 'timed_out') {
    const account = getAccount(accountId);
    if (account) notifySyncFailure(account, message, jobId);
  }
  drainQueue();
}

// 供API/Scheduler调用:触发一次同步。
// 如果该账号已经有 queued 或 running 的任务,直接拒绝,不再插入新记录。
function triggerSync(accountId) {
  if (maintenanceLock.current() === 'restore') return { ok: false, reason: 'maintenance' };
  const account = getAccount(accountId);
  if (!account) return { ok: false, reason: 'not_found' };
  if (!accountHasCredential(account)) return { ok: false, reason: 'missing_credentials' };

  const result = jobStore.enqueueJob(db, accountId);
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
function retryJob(jobId) {
  if (maintenanceLock.current() === 'restore') return { ok: false, reason: 'maintenance' };
  const previous = db.prepare('SELECT account_id FROM sync_jobs WHERE id=?').get(jobId);
  if (!previous) return { ok: false, reason: 'not_found' };
  const account = getAccount(previous.account_id);
  if (!account || !accountHasCredential(account)) {
    return { ok: false, reason: 'missing_credentials' };
  }
  const result = jobStore.retryJob(db, jobId);
  if (result.ok) {
    drainQueue();
  }
  return result;
}

function triggerAllEnabled() {
  const accounts = db.prepare('SELECT id FROM accounts WHERE enabled = 1 ORDER BY id').all();
  const result = { queued: [], skipped: [] };
  for (const account of accounts) {
    const outcome = triggerSync(account.id);
    if (outcome.ok) result.queued.push(outcome.jobId);
    else result.skipped.push({ accountId: account.id, reason: outcome.reason });
  }
  return result;
}

function cancelAllQueued() {
  return jobStore.cancelAllQueued(db);
}

// ---- 连接测试:60秒后请求终止,错误分类,不做正式同步 ----
function testConnection(accountId) {
  return new Promise((resolve) => {
    if (maintenanceLock.current() === 'restore') {
      resolve({ ok: false, category: 'maintenance', message: '系统正在恢复，请稍后再测试连接' });
      return;
    }
    const account = getAccount(accountId);
    if (!account) {
      resolve({ ok: false, category: 'not_found', message: '账号不存在' });
      return;
    }
    if (!accountHasCredential(account)) {
      resolve({
        ok: false,
        category: 'auth_failed',
        message: account.auth_type === 'oauth2' ? 'OAuth2账号尚未授权' : '账号密码/授权码尚未保存',
      });
      return;
    }
    const args = buildArgs(account, { justFolders: true });
    const testToken = Symbol(`connection-test-${account.id}`);
    connectionTests.add(testToken);
    let stdoutBuf = '';
    let stderrBuf = '';
    let completed = false;
    const child = spawn('imapsync', args, { env: { PATH: process.env.PATH } });
    const terminator = createProcessTerminator({ child, jobId: `test-${accountId}` });

    function completeOnce(result) {
      if (completed) return;
      completed = true;
      connectionTests.delete(testToken);
      clearTimeout(timeout);
      terminator.complete();
      resolve(result);
    }

    const timeout = setTimeout(() => {
      terminator.request('timed_out', '连接测试超过60秒，正在终止 imapsync');
    }, 60000);
    timeout.unref();

    child.stdout.on('data', (c) => (stdoutBuf += c.toString()));
    child.stderr.on('data', (c) => (stderrBuf += c.toString()));

    child.on('error', (err) => {
      completeOnce({
        ok: false,
        category: 'spawn_failed',
        message: `无法启动 imapsync: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      const combinedOutput = `${stdoutBuf}\n${stderrBuf}`;
      const summary = parseSummary(combinedOutput);
      const termination = terminator.getTermination();
      const timedOut = termination && termination.status === 'timed_out';
      if (code === 0 && !timedOut) {
        completeOnce({
          ok: true,
          message: '连接成功',
          folders: summary.host1Folders,
          messages: summary.host1Messages,
        });
      } else {
        const { category, message } = categorizeTestError(combinedOutput, timedOut);
        completeOnce({ ok: false, category, message });
      }
    });
  });
}

// ---- 应用启动恢复 ----
// Web服务可能在同步进行中被重启(rc-service restart / 机器重启 / crash)。
// 这种情况下内存里的runningLocks会丢失,但DB里的 status='running' 记录会
// 永久残留,导致: 1) Dashboard一直显示"正在同步" 2) 该账号被永久锁死无法再同步。
// 启动时统一处理这些"孤儿"任务:标记为interrupted,并尝试终止可能还在后台
// 残留运行的imapsync进程(避免它和下一次同步的cache读写冲突)。
function reconcileAfterRestart() {
  const staleRunning = jobStore.reconcileRunningJobs(db);
  for (const job of staleRunning) {
    if (job.pid) {
      try {
        const cmdlinePath = `/proc/${job.pid}/cmdline`;
        if (fs.existsSync(cmdlinePath)) {
          const cmdline = fs.readFileSync(cmdlinePath, 'utf8');
          if (cmdline.includes('imapsync')) {
            process.kill(job.pid, 'SIGTERM');
          }
        }
      } catch (e) {
        // pid已经不存在或没有权限读取/proc,忽略即可,不影响标记interrupted
      }
    }
  }
  if (staleRunning.length > 0) {
    console.log(`[startup] 已将 ${staleRunning.length} 个因服务重启而中断的同步任务标记为 interrupted`);
  }
}

// 优雅关闭:尽量终止正在跑的子进程,避免留下孤儿进程
function shutdownGracefully() {
  shuttingDown = true;
  const controls = [...runningChildren.values()];
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
  maxConcurrent,
  syncTimeoutMinutes,
  reconcileAfterRestart,
  shutdownGracefully,
};
