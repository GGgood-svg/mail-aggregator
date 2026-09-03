function closeServer(server) {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function createShutdownController({
  server,
  stopScheduler,
  stopMaintenance,
  terminateChildren,
  forceExitDelayMs = 15000,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  exit = process.exit,
  logger = console,
}) {
  let shutdownPromise = null;

  return function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;

    logger.log(`收到 ${signal},开始优雅关闭...`);
    stopScheduler();
    stopMaintenance();

    // Keep this timer referenced during shutdown. A pending Promise alone does not keep
    // Node alive, and the process must remain up long enough for the 10-second child
    // escalation timer to send SIGKILL when imapsync ignores SIGTERM.
    const forceExitTimer = schedule(() => {
      logger.error(`优雅关闭超过 ${forceExitDelayMs / 1000} 秒,强制退出`);
      exit(1);
    }, forceExitDelayMs);

    shutdownPromise = Promise.all([
      closeServer(server),
      Promise.resolve().then(terminateChildren),
    ]).then(
      () => {
        cancelSchedule(forceExitTimer);
        exit(0);
      },
      (error) => {
        cancelSchedule(forceExitTimer);
        logger.error(`优雅关闭失败: ${error.message}`);
        exit(1);
      }
    );

    return shutdownPromise;
  };
}

module.exports = { closeServer, createShutdownController };
