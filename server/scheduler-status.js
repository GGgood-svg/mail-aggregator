function summarizeScheduler(status, nowMs = Date.now()) {
  const scheduler = status || { running: false };
  const tickMs = Number(scheduler.tickIntervalMs) > 0 ? Number(scheduler.tickIntervalMs) : 15000;
  const lastTickMs = scheduler.lastTickAt ? Date.parse(scheduler.lastTickAt) : NaN;
  const staleAfterMs = Math.max(tickMs * 3, 30000);

  let healthCode = 'healthy';
  let healthLabel = '正常';
  if (!scheduler.running) {
    healthCode = 'stopped';
    healthLabel = '已停止';
  } else if (scheduler.lastError) {
    healthCode = 'error';
    healthLabel = '有异常';
  } else if (!Number.isFinite(lastTickMs)) {
    healthCode = 'starting';
    healthLabel = '启动中';
  } else if (nowMs - lastTickMs > staleAfterMs) {
    healthCode = 'stale';
    healthLabel = '可能停滞';
  }

  return {
    ...scheduler,
    healthCode,
    healthLabel,
    healthy: healthCode === 'healthy' || healthCode === 'starting',
    staleAfterMs,
  };
}

module.exports = { summarizeScheduler };
