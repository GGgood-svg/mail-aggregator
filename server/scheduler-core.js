const DEFAULT_INTERVAL_SECONDS = 600;
const MAX_RETRY_SECONDS = 6 * 60 * 60;
const AUTH_RETRY_SECONDS = 6 * 60 * 60;

function parseSqliteUtc(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function scheduleDecision(account, nowMs) {
  const interval = Number.isInteger(Number(account.sync_interval))
    && Number(account.sync_interval) >= 60
    && Number(account.sync_interval) <= 604800
    ? Number(account.sync_interval)
    : DEFAULT_INTERVAL_SECONDS;
  const anchors = [parseSqliteUtc(account.last_sync_at), parseSqliteUtc(account.last_cancelled_at)]
    .filter((value) => value !== null);
  const anchor = anchors.length ? Math.max(...anchors) : 0;
  const failed = ['failed', 'timed_out'].includes(account.last_sync_status)
    && (!parseSqliteUtc(account.last_cancelled_at) || parseSqliteUtc(account.last_cancelled_at) < (parseSqliteUtc(account.last_sync_at) || 0));
  const failureCount = failed ? Math.max(1, Math.min(30, Number(account.sync_failure_count) || 1)) : 0;
  let delay = interval;
  if (failed && account.last_sync_category === 'auth_failed') delay = Math.max(interval, AUTH_RETRY_SECONDS);
  else if (failed) delay = Math.max(interval, Math.min(MAX_RETRY_SECONDS, interval * 2 ** Math.min(failureCount - 1, 12)));
  const dueAt = anchor ? anchor + delay * 1000 : 0;
  return { due: nowMs >= dueAt, dueAt, intervalSeconds: interval, retryDelaySeconds: delay,
    failureCount, category: failed ? account.last_sync_category || 'unknown' : null };
}

function createScheduler({
  loadAccounts,
  hasActiveJob,
  triggerSync,
  drainQueue,
  queueHealth = () => null,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  tickMs = 15000,
  logger = console,
}) {
  let timer = null;
  let lastTickAt = null;
  let lastSuccessAt = null;
  let lastScanCompletedAt = null;
  let lastError = null;
  let lastResult = null;
  let pendingTick = null;
  let generation = 0;

  function tick() {
    if (pendingTick) return pendingTick;
    pendingTick = runTick().finally(() => { pendingTick = null; });
    return pendingTick;
  }

  async function runTick() {
    const tickGeneration = generation;
    const tickNow = now();
    lastTickAt = new Date(tickNow).toISOString();
    const result = { checked: 0, triggered: 0, active: 0, notDue: 0, disabled: 0,
      paused: 0, deferred: 0, skipped: 0, errors: 0, blockedByReason: {} };
    function deferred(reason) {
      result.deferred++;
      result.blockedByReason[reason] = (result.blockedByReason[reason] || 0) + 1;
    }

    try {
      drainQueue();
      const accounts = loadAccounts();
      // Serialize mutations inside triggerSync, not the independent capacity
      // probes. A slow volume should leave slots for healthy accounts.
      let cursor = 0;
      async function scheduleOne(account) {
        result.checked++;
        try {
          if (!account.enabled) {
            result.disabled++;
            return;
          }
          if (hasActiveJob(account.id)) {
            if (account.waiting_sync_block) deferred(account.waiting_sync_block);
            else result.active++;
            return;
          }
          if (parseSqliteUtc(account.sync_paused_until) > tickNow) {
            result.paused++;
            return;
          }
          if (!scheduleDecision(account, tickNow).due) {
            result.notDue++;
            return;
          }
          const outcome = await triggerSync(account.id, { enabledOnly: true, authorize: () => {
            if (generation !== tickGeneration) throw new Error('调度器已停止');
          } });
          if (outcome?.ok) result.triggered++;
          else if (outcome?.outcome === 'deferred') deferred(outcome.block?.code || 'other');
          else if (outcome?.outcome === 'failed') result.errors++;
          else result.skipped++;
        } catch (error) {
          result.errors++;
          logger.error(`[scheduler] 账号 ${account.id} 调度失败: ${error.message}`);
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, async () => {
        while (generation === tickGeneration && cursor < accounts.length) await scheduleOne(accounts[cursor++]);
      }));
      if (generation !== tickGeneration) return result;
      lastScanCompletedAt = new Date(now()).toISOString();
      if (result.errors === 0) {
        // Backward-compatible scheduling health timestamp. Do not mark a fully
        // blocked cycle as successful. Mail's success clock lives on accounts.
        if (!result.deferred || result.triggered) lastSuccessAt = lastScanCompletedAt;
        lastError = null;
      } else {
        lastError = `${result.errors} 个账号调度失败`;
      }
    } catch (error) {
      result.errors++;
      lastError = error.message;
      logger.error(`[scheduler] 调度周期失败: ${error.message}`);
    }
    lastResult = result;
    return result;
  }

  function start() {
    if (timer) return false;
    timer = setIntervalFn(tick, tickMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    tick();
    return true;
  }

  function stop() {
    generation++;
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  function getStatus() {
    return { running: !!timer, lastTickAt, lastScanCompletedAt, lastSuccessAt, lastError, lastResult, queue: queueHealth(), tickIntervalMs: tickMs };
  }

  return { tick, start, stop, getStatus };
}

module.exports = { DEFAULT_INTERVAL_SECONDS, MAX_RETRY_SECONDS, AUTH_RETRY_SECONDS, parseSqliteUtc, scheduleDecision, createScheduler };
