'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { createOperationsStore, SAMPLE, AUDIT_RETENTION } = require('./operations-store');
const { journalPresent } = require('./restore-journal');
const AUDIT_POLL_MS = 30_000;

// Only these known routes are recorded. Never save paths, bodies, IPs, or headers.
const ROUTES = [
  ['POST', /^\/api\/auth\/setup\/?$/i, 'setup'], ['POST', /^\/api\/auth\/login\/?$/i, 'login'],
  ['POST', /^\/api\/auth\/login\/totp\/?$/i, 'totp_login'],
  ['POST', /^\/api\/auth\/totp\/enable\/?$/i, 'totp_enabled'],
  ['POST', /^\/api\/auth\/totp\/recovery-codes\/?$/i, 'totp_recovery_rotated'],
  ['POST', /^\/api\/auth\/totp\/disable\/?$/i, 'totp_disabled'],
  ['POST', /^\/api\/auth\/logout\/?$/i, 'logout'], ['POST', /^\/api\/auth\/change-password\/?$/i, 'password_changed'],
  ['DELETE', /^\/api\/auth\/devices\/[a-f0-9-]{36}\/?$/i, 'device_revoked'],
  ['POST', /^\/api\/auth\/devices\/revoke-others\/?$/i, 'other_devices_revoked'],
  ['POST', /^\/api\/users\/?$/i, 'user_created'], ['PUT', /^\/api\/users\/(\d{1,15})\/?$/i, 'user_changed'],
  ['DELETE', /^\/api\/users\/(\d{1,15})\/?$/i, 'user_deleted'],
  ['POST', /^\/api\/accounts\/\d+\/sync\/?$/i, 'sync_requested'],
  ['POST', /^\/api\/accounts\/\d+\/jobs\/\d+\/cancel\/?$/i, 'sync_cancelled'],
  ['POST', /^\/api\/jobs\/\d+\/retry\/?$/i, 'sync_retried'],
  ['PUT', /^\/api\/notifications\/settings\/?$/i, 'notifications_changed'],
  ['POST', /^\/api\/system\/backup\/?$/i, 'backup'], ['POST', /^\/api\/system\/backup-pair\/?$/i, 'backup_pair'],
  ['POST', /^\/api\/system\/restore\/apply\/?$/i, 'restore'], ['GET', /^\/api\/system\/restore\/snapshots?\/[^/]+\/?$/i, 'restore_point'],
  ['POST', /^\/api\/system\/app-update\/check\/?$/i, 'update_checked'], ['PUT', /^\/api\/system\/app-update\/settings\/?$/i, 'update_settings'],
  ['POST', /^\/api\/system\/app-update\/install\/?$/i, 'update_install'],
  ['POST', /^\/api\/system\/restart\/?$/i, 'service_restart'], ['POST', /^\/api\/system\/uninstall\/?$/i, 'service_uninstall'],
];
const HEALTH = ['node', 'imapsync', 'dovecot-command', 'imap-listener', 'database', 'disk'];
const FAILURES = new Set(['auth_failed', 'tls_failed', 'network_failed', 'timeout', 'timed_out', 'start_failed', 'preparation_failed',
  'low_space', 'low_inodes', 'capacity_unavailable', 'provider_rate_limited', 'network', 'storage', 'spawn_failed', 'imap_transport',
  'local_auth_failed', 'permission_denied', 'sync_failed', 'process', 'output_limit', 'unknown']);
const own = (object, key) => Object.hasOwn(object, key);

function auditRequest(method, pathname) {
  for (const [verb, pattern, event] of ROUTES) {
    if (method !== verb) continue;
    const match = pattern.exec(pathname);
    if (match) return { event, subjectId: match[1] ? Number(match[1]) : undefined };
  }
  return null;
}

// The local updater response identifies the accepted operation. Never derive
// an audit ID from the requested tag, raw body, or an earlier unrelated install.
function acceptedUpdateOperationId(result, tag) {
  if (typeof tag !== 'string' || result?.pending !== tag) return null;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.pendingOperationId || '')) return result.pendingOperationId;
  if (!Array.isArray(result.history)) return null;
  const queued = result.history.slice(0,60).find(item => item?.outcome === 'queued' && item.source === 'manual' && `v${item.to}` === tag);
  return queued?.operationId ?? null;
}

function createOperations({ dirs, db, healthSnapshot, readUpdates, canWrite = () => true, clock = Date.now }) {
  let database, store, timer, auditTimer, health, active, auditActive, restoreAfter, fetchRestore,
    lifecycle = 0, unavailable = false, closed = false;
  const dbFile = path.join(dirs.db, 'operations.db');
  const jobCounts = db.prepare("SELECT status, COUNT(*) AS n FROM sync_jobs WHERE status IN ('queued','running') GROUP BY status");
  const recentFailures = db.prepare(`SELECT result_code FROM (SELECT status,result_code FROM sync_jobs ORDER BY id DESC LIMIT 500)
    WHERE status IN ('failed','timed_out','interrupted')`);
  function storage() {
    if (store) return store;
    const opened = new Database(dbFile, { timeout: 25 });
    try {
      fs.chmodSync(dbFile, 0o600);
      opened.pragma('journal_mode = WAL'); opened.pragma('synchronous = NORMAL');
      store = createOperationsStore(opened, { clock }); database = opened;
      return store;
    } catch (error) { opened.close(); throw error; }
  }
  function write(work) {
    if (closed || !canWrite()) return false;
    try { work(storage()); unavailable = false; return true; }
    catch (_) { unavailable = true; return false; }
  }
  function tick() {
    if (active || !canWrite()) return;
    const epoch = lifecycle;
    active = Promise.resolve().then(healthSnapshot).then(snapshot => {
      if (epoch !== lifecycle || !canWrite()) return;
      const at = clock();
      const checks = HEALTH.flatMap(id => {
        const found = snapshot.health?.checks?.find(item => item.id === id);
        return found ? [{ id, ok: found.ok === true }] : [];
      });
      health = { at, ok: checks.length ? checks.every(check => check.ok) : null, checks };
      if (snapshot.capacity?.observations) write(store => store.recordCapacity(snapshot.capacity.observations, at));
    }).catch(() => {}).finally(() => { active = null; });
  }
  function refreshAudit() {
    if (auditActive || !timer || !canWrite()) return auditActive;
    const epoch = lifecycle;
    const enabled = () => epoch === lifecycle && Boolean(timer) && canWrite();
    auditActive = Promise.resolve().then(async () => {
      if (!enabled()) return;
      const now = clock();
      try {
        // A DB commit can exist while credential recovery is still pending.
        // Wait for the journal to be removed before accepting the marker.
        if (!journalPresent(dirs.root) && (fetchRestore || db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_notification_source'"
        ).get())) {
          fetchRestore ||= db.prepare(`SELECT operation_id,outcome,at FROM restore_notification_source
            WHERE (at,operation_id)>(?,?) AND at<=? ORDER BY at,operation_id LIMIT 100`);
          const cursor = restoreAfter || [new Date(now - AUDIT_RETENTION).toISOString(), ''];
          const rows = fetchRestore.all(...cursor,new Date(now).toISOString());
          if (rows.length && write(target => target.recordTerminalAudit('restore', rows.map(row => ({
            operationId:row.operation_id, outcome:row.outcome, at:Date.parse(row.at)
          })),now))) {
            const last = rows.at(-1);
            restoreAfter = [last.at,last.operation_id];
          }
        }
      } catch (_) { unavailable = true; }
      if (!readUpdates || !enabled()) return;
      const records = await readUpdates();
      if (!enabled() || !Array.isArray(records) || !records.length) return;
      write(target => target.recordTerminalAudit('update', records, clock()));
    }).catch(() => {}).finally(() => { auditActive = null; });
    return auditActive;
  }
  function start() {
    if (closed || timer) return;
    timer = setInterval(tick, SAMPLE); timer.unref(); tick();
    auditTimer = setInterval(refreshAudit, AUDIT_POLL_MS); auditTimer.unref(); refreshAudit();
  }
  function stop() {
    lifecycle++; if (timer) clearInterval(timer); if (auditTimer) clearInterval(auditTimer);
    timer = null; auditTimer = null; restoreAfter = null;
  }
  function close() { closed = true; stop(); database?.close(); database = null; store = null; }
  function overview() {
    const queue = { queued: 0, running: 0 };
    for (const { status, n } of jobCounts.all()) if (own(queue, status)) queue[status] = n;
    const failures = {};
    for (const { result_code } of recentFailures.all()) {
      const code = FAILURES.has(result_code) ? result_code : 'unknown';
      failures[code] = (failures[code] || 0) + 1;
    }
    return { health: health && clock() - health.at < 3 * SAMPLE ? health : null, queue, failures, storageAvailable: !unavailable };
  }
  function query(work) {
    if (closed || !store && !canWrite()) throw Object.assign(new Error('运维记录暂不可用'), { statusCode: 503 });
    try { return work(storage()); }
    catch (_) { throw Object.assign(new Error('运维记录暂不可用'), { statusCode: 503 }); }
  }
  function audit(req, res, next) {
    const activity = auditRequest(req.method, req.path);
    if (!activity) return next();
    res.once('finish', () => {
      const { statusCode: status } = res;
      const isAuth = activity.event === 'login' || activity.event === 'totp_login' || activity.event === 'setup';
      const actorId = isAuth ? (status < 300 ? req.session?.userId : null) : req.user?.id;
      if (!isAuth && !Number.isSafeInteger(actorId)) return;
      if (activity.event === 'user_created' && status === 201 && Number.isSafeInteger(res.locals.auditSubjectId)) activity.subjectId = res.locals.auditSubjectId;
      const operationId = res.locals.auditOperationId;
      const syncSubmission = ['sync_requested','sync_retried'].includes(activity.event);
      const outcome = status >= 500 ? 'failed' : status >= 400 || (syncSubmission && !operationId) ? 'rejected'
        : status === 202 || syncSubmission ? 'accepted' : 'success';
      write(store => store.recordAudit({ ...activity, actorId, status, outcome, operationId }));
    });
    next();
  }
  return { start, stop, close, overview, audit, refreshAudit,
    capacity: period => query(store => store.capacityTrend(period)),
    auditHistory: filters => query(store => store.auditHistory(filters)) };
}

module.exports = { createOperations, auditRequest, acceptedUpdateOperationId };
