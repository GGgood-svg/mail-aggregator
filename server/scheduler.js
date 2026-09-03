const { db } = require('./db');
const { triggerSync, drainQueue, hasActiveJob } = require('./sync');
const { createScheduler } = require('./scheduler-core');

const TICK_MS = 15000; // 每15秒检查一次

const scheduler = createScheduler({
  loadAccounts: () => db.prepare(
    `SELECT a.*,
       (SELECT MAX(COALESCE(j.finished_at, j.started_at)) FROM sync_jobs j
        WHERE j.account_id = a.id AND j.status = 'cancelled') AS last_cancelled_at
     FROM accounts a WHERE a.enabled = 1`
  ).all(),
  hasActiveJob,
  triggerSync,
  drainQueue,
  tickMs: TICK_MS,
});

module.exports = scheduler;
