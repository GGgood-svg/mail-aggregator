function createProcessTerminator({
  child,
  jobId,
  forceKillDelayMs = 10000,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  logger = console,
}) {
  let completed = false;
  let termination = null;
  let forceKillTimer = null;

  function sendSignal(signal) {
    try {
      child.kill(signal);
    } catch (error) {
      logger.error(`[sync] 任务 ${jobId} 发送${signal}失败: ${error.message}`);
    }
  }

  function request(status, message) {
    if (completed || termination) return false;
    termination = { status, message };
    logger.warn(`[sync] 任务 ${jobId}: ${message}`);
    sendSignal('SIGTERM');

    forceKillTimer = schedule(() => {
      if (!completed) sendSignal('SIGKILL');
    }, forceKillDelayMs);
    if (forceKillTimer && typeof forceKillTimer.unref === 'function') {
      forceKillTimer.unref();
    }
    return true;
  }

  function complete() {
    if (completed) return;
    completed = true;
    if (forceKillTimer) {
      cancelSchedule(forceKillTimer);
      forceKillTimer = null;
    }
  }

  return {
    request,
    complete,
    getTermination: () => termination,
  };
}

module.exports = { createProcessTerminator };
