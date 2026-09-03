const DEFAULT_INTERVAL_SECONDS = 600;

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
  const dueAt = anchor ? anchor + interval * 1000 : 0;
  return { due: nowMs >= dueAt, dueAt, intervalSeconds: interval };
}

function createScheduler({
  loadAccounts,
  hasActiveJob,
  triggerSync,
  drainQueue,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  tickMs = 15000,
  logger = console,
}) {
  let timer = null;
  let lastTickAt = null;
  let lastSuccessAt = null;
  let lastError = null;
  let lastResult = null;

  function tick() {
    const tickNow = now();
    lastTickAt = new Date(tickNow).toISOString();
    const result = { checked: 0, triggered: 0, active: 0, notDue: 0, disabled: 0, errors: 0 };

    try {
      drainQueue();
      const accounts = loadAccounts();
      for (const account of accounts) {
        result.checked++;
        try {
          if (!account.enabled) {
            result.disabled++;
            continue;
          }
          if (hasActiveJob(account.id)) {
            result.active++;
            continue;
          }
          if (!scheduleDecision(account, tickNow).due) {
            result.notDue++;
            continue;
          }
          const outcome = triggerSync(account.id);
          if (outcome && outcome.ok) result.triggered++;
        } catch (error) {
          result.errors++;
          logger.error(`[scheduler] 账号 ${account.id} 调度失败: ${error.message}`);
        }
      }
      if (result.errors === 0) {
        lastSuccessAt = new Date(now()).toISOString();
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
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  function getStatus() {
    return { running: !!timer, lastTickAt, lastSuccessAt, lastError, lastResult, tickIntervalMs: tickMs };
  }

  return { tick, start, stop, getStatus };
}

module.exports = { DEFAULT_INTERVAL_SECONDS, parseSqliteUtc, scheduleDecision, createScheduler };
