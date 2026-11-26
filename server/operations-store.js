'use strict';

const { randomUUID } = require('node:crypto');
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const SAMPLE = 5 * MINUTE, RETENTION = 7 * DAY, AUDIT_RETENTION = 30 * DAY;
const USES = new Set(['application', 'database', 'credentials', 'logs', 'cache', 'temporary', 'restore_points', 'mail']);
const CODES = new Set(['low_space', 'low_inodes', 'capacity_busy', 'capacity_unavailable']);
const AUDIT_EVENTS = new Set(['setup', 'login', 'logout', 'password_changed', 'device_revoked', 'other_devices_revoked',
  'totp_login', 'totp_enabled', 'totp_recovery_rotated', 'totp_disabled',
  'user_created', 'user_changed', 'user_deleted', 'notifications_changed', 'backup', 'backup_pair', 'restore',
  'restore_point', 'update_checked', 'update_settings', 'update_install', 'service_restart', 'service_uninstall',
  'sync_requested', 'sync_retried', 'sync_cancelled', 'restore_result', 'update_result']);
const AUDIT_OUTCOMES = new Set(['success', 'accepted', 'rejected', 'failed', 'rolled_back', 'recovery_required']);
const REQUEST_OUTCOMES = new Set(['success', 'accepted', 'rejected', 'failed']);
const TERMINAL = Object.freeze({
  restore: Object.freeze({ committed:'success', recovered_committed:'success', rolled_back:'rolled_back' }),
  update: Object.freeze({ installed:'success', rollback_verified:'rolled_back', failed:'failed',
    rollback_failed:'recovery_required', finalization_failed:'recovery_required' }),
});
const HEX = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SYNC_EVENTS = new Set(['sync_requested', 'sync_retried', 'sync_cancelled']);
const goodId = value => Number.isSafeInteger(value) && value > 0;
const taskId = value => typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && goodId(Number(value));
const operationKey = value => typeof value === 'string' && (taskId(value) || HEX.test(value) || UUID.test(value));
function auditOperationId(event, value) {
  const id = goodId(value) ? String(value) : value;
  if (typeof id !== 'string') return null;
  if (SYNC_EVENTS.has(event)) return taskId(id) ? id : null;
  if (event === 'restore' || event === 'restore_result') return HEX.test(id) ? id : null;
  if (event === 'update_install' || event === 'update_result') return HEX.test(id) || UUID.test(id) ? id : null;
  return null;
}
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const mountKey = value => typeof value === 'string' && /^[a-f0-9]{16,64}$/.test(value);

function safeObservation(item) {
  if (!mountKey(item?.mountId)) return null;
  const uses = Array.isArray(item.uses) ? [...new Set(item.uses.filter(use => USES.has(use)))].sort() : [];
  if (!uses.length) return null;
  const code = CODES.has(item.code) ? item.code : item.ok === true ? null : 'capacity_unavailable';
  return { mountId: item.mountId, uses, code, availableMb: count(item.availableMb), availableInodes: count(item.availableInodes),
    minimumMb: count(item.minimumMb ?? item.requiredMb) };
}

function createOperationsStore(db, { clock = Date.now } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capacity_samples (
      mount_id TEXT NOT NULL, at INTEGER NOT NULL, uses TEXT NOT NULL, code TEXT, available_mb INTEGER,
      available_inodes INTEGER, minimum_mb INTEGER, PRIMARY KEY(mount_id, at)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS capacity_samples_time ON capacity_samples(at);
    CREATE TABLE IF NOT EXISTS operations_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, actor INTEGER, subject INTEGER,
      event TEXT NOT NULL, outcome TEXT NOT NULL, status INTEGER NOT NULL, occurrences INTEGER NOT NULL DEFAULT 1,
      group_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS operations_audit_time ON operations_audit(at);
    CREATE INDEX IF NOT EXISTS operations_audit_actor ON operations_audit(actor, seq);
    CREATE INDEX IF NOT EXISTS operations_audit_event ON operations_audit(event, seq);
    CREATE TABLE IF NOT EXISTS operations_audit_receipts (
      event TEXT NOT NULL, operation_id TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(event,operation_id,outcome)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS operations_audit_receipts_time ON operations_audit_receipts(at);
  `);
  if (!db.prepare('PRAGMA table_info(operations_audit)').all().some(column => column.name === 'operation_id')) {
    db.exec('ALTER TABLE operations_audit ADD COLUMN operation_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS operations_audit_operation ON operations_audit(operation_id, seq)');
  const insertSample = db.prepare(`INSERT INTO capacity_samples(mount_id, at, uses, code, available_mb, available_inodes, minimum_mb)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(mount_id,at) DO UPDATE SET uses=excluded.uses, code=excluded.code,
    available_mb=excluded.available_mb, available_inodes=excluded.available_inodes, minimum_mb=excluded.minimum_mb`);
  const removeSamples = db.prepare('DELETE FROM capacity_samples WHERE at<?');
  const recordCapacity = db.transaction((observations, now = clock()) => {
    const bucket = Math.floor(now / SAMPLE) * SAMPLE;
    for (const item of (Array.isArray(observations) ? observations : []).slice(0, 16)) {
      const safe = safeObservation(item);
      if (safe) insertSample.run(safe.mountId, bucket, safe.uses.join(','), safe.code, safe.availableMb, safe.availableInodes, safe.minimumMb);
    }
    removeSamples.run(bucket - RETENTION);
  });
  const recentVolumes = db.prepare(`SELECT mount_id, MAX(at) AS latest FROM capacity_samples WHERE at>=?
    GROUP BY mount_id ORDER BY latest DESC,mount_id LIMIT 16`);
  const lastSample = db.prepare(`SELECT at,uses,code,available_mb AS availableMb,available_inodes AS availableInodes,minimum_mb AS minimumMb
    FROM capacity_samples WHERE mount_id=? AND at=?`);
  const range = db.prepare(`SELECT CAST(at / ? AS INTEGER) * ? AS period, MIN(available_mb) AS availableMb,
    MIN(available_inodes) AS availableInodes, COUNT(*) AS samples
    FROM capacity_samples WHERE mount_id=? AND at>=? AND at<=? GROUP BY period ORDER BY period`);
  function capacityTrend(period = '24h', now = clock()) {
    const step = period === '7d' ? HOUR : 15 * MINUTE;
    const length = period === '7d' ? 7 * DAY : DAY;
    const endAt = Math.floor(now / step) * step;
    const startAt = endAt - length + step;
    return { startAt, endAt, stepMs: step, sampleIntervalMs: SAMPLE, volumes: recentVolumes.all(startAt).map(({ mount_id, latest }) => {
      const current = lastSample.get(mount_id, latest);
      const values = new Map(range.all(step, step, mount_id, startAt, now).map(item => [item.period, item]));
      const points = Array.from({ length: length / step }, (_, index) => {
        const item = values.get(startAt + index * step);
        return item ? [item.availableMb, item.availableInodes, item.samples] : null;
      });
      return { mountId: mount_id, latest: { ...current, uses: current.uses.split(',') }, points };
    }) };
  }
  const insertAudit = db.prepare(`INSERT INTO operations_audit(id, at, actor, subject, event, outcome, status, group_key, operation_id)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(group_key) DO UPDATE SET occurrences=operations_audit.occurrences+1`);
  const receipt = db.prepare(`INSERT OR IGNORE INTO operations_audit_receipts(event,operation_id,outcome,at) VALUES(?,?,?,?)`);
  const auditTrimByTime = db.prepare('DELETE FROM operations_audit WHERE at<?');
  const receiptTrim = db.prepare('DELETE FROM operations_audit_receipts WHERE at<?');
  const auditTrimByCount = db.prepare(`DELETE FROM operations_audit WHERE seq IN
    (SELECT seq FROM operations_audit ORDER BY at DESC,seq DESC LIMIT -1 OFFSET 10000)`);
  const findAuditCursor = db.prepare('SELECT at,seq FROM operations_audit WHERE seq=?');
  let lastAuditPrune = -Infinity;
  function pruneAudit(now) {
    auditTrimByCount.run();
    if (now - lastAuditPrune < SAMPLE) return;
    auditTrimByTime.run(now - AUDIT_RETENTION);
    receiptTrim.run(now - AUDIT_RETENTION);
    lastAuditPrune = now;
  }
  const recordAudit = db.transaction(({ event, outcome, actorId, subjectId, status, operationId }, now = clock()) => {
    if (!AUDIT_EVENTS.has(event) || event.endsWith('_result') || !REQUEST_OUTCOMES.has(outcome) ||
        !Number.isSafeInteger(status) || status < 200 || status > 599) return;
    const grouped = event === 'login' && outcome !== 'success';
    const group = grouped ? `login:${outcome}:${Math.floor(now / SAMPLE)}` : null;
    insertAudit.run(randomUUID(), now, !grouped && goodId(actorId) ? actorId : null, goodId(subjectId) ? subjectId : null,
      event, outcome, status, group, auditOperationId(event, operationId));
    pruneAudit(now);
  });
  // Receipts survive the row-count cap, so polling or replaying an earlier app DB
  // cannot bring an evicted but still recent terminal result back into the audit.
  const recordTerminalAudit = db.transaction((source, rows, now = clock()) => {
    if (!Object.hasOwn(TERMINAL, source) || !Array.isArray(rows)) return;
    const event = `${source}_result`, outcomes = TERMINAL[source];
    let inserted = false;
    for (const row of rows.slice(0, 100).sort((a,b) => (a?.at ?? 0) - (b?.at ?? 0))) {
      if (!row || typeof row.outcome !== 'string' || !Object.hasOwn(outcomes, row.outcome) ||
          !Number.isSafeInteger(row.at) || row.at < now - AUDIT_RETENTION || row.at > now) continue;
      const id = auditOperationId(event, row.operationId), outcome = outcomes[row.outcome];
      if (!id || !receipt.run(event, id, outcome, row.at).changes) continue;
      insertAudit.run(randomUUID(), row.at, null, null, event, outcome, 0, null, id);
      inserted = true;
    }
    if (inserted) pruneAudit(now);
  });
  function auditHistory({ before, limit, event, outcome, actor, subject, from, to, operationId } = {}) {
    if (operationId !== undefined && !operationKey(operationId)) return { events: [], nextBefore: null };
    const expressions = ['at>=?'];
    const params = [clock() - AUDIT_RETENTION];
    if (goodId(Number(before))) {
      const cursor = findAuditCursor.get(Number(before));
      if (!cursor) return { events: [], nextBefore: null };
      expressions.push('(at,seq)<(?,?)'); params.push(cursor.at,cursor.seq);
    }
    for (const [column, value, validate, op] of [['event', event, item => AUDIT_EVENTS.has(item), '='],
      ['outcome', outcome, item => AUDIT_OUTCOMES.has(item), '='], ['actor', Number(actor), goodId, '='], ['subject', Number(subject), goodId, '='],
      ['at', Number(from), goodId, '>='], ['at', Number(to), goodId, '<='], ['operation_id', operationId, operationKey, '=']]) {
      if (validate(value)) { expressions.push(`${column}${op}?`); params.push(value); }
    }
    const size = goodId(Number(limit)) ? Math.min(100, Number(limit)) : 30;
    const rows = db.prepare(`SELECT seq,id,at,actor AS actorId,subject AS subjectId,event,outcome,NULLIF(status,0) AS status,occurrences,operation_id AS operationId
      FROM operations_audit WHERE ${expressions.join(' AND ')} ORDER BY at DESC,seq DESC LIMIT ?`).all(...params, size + 1);
    return { events: rows.slice(0, size).map(({ seq, ...publicFields }) => publicFields), nextBefore: rows.length > size ? rows[size-1].seq : null };
  }
  return { recordCapacity, capacityTrend, recordAudit, recordTerminalAudit, auditHistory };
}

module.exports = { createOperationsStore, safeObservation, SAMPLE, AUDIT_RETENTION, AUDIT_EVENTS, AUDIT_OUTCOMES };
