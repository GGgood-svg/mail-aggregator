'use strict';

const { randomUUID } = require('node:crypto');
const { migrateRestoreNotificationSource } = require('./notification-restore-source');
const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const MAX_ATTEMPTS = 8;
const RETENTION = 30 * DAY;
const LEASE = 30_000;
const CATEGORIES = new Set(['auth_failed', 'tls_failed', 'network_failed', 'timeout', 'timed_out', 'start_failed',
  'preparation_failed', 'low_disk', 'low_space', 'low_inodes', 'capacity_unavailable', 'unknown', 'unknown_failure',
  'provider_rate_limited', 'network', 'storage', 'spawn_failed', 'imap_transport', 'local_auth_failed', 'permission_denied', 'provider_rate_limited', 'sync_failed', 'process', 'output_limit']);
const ACTIVE = "'queued','retrying','sending'";
const OPERATION_EVENTS = Object.freeze({ restore_committed: 'restore.committed', restore_rolled_back: 'restore.rolled_back',
  update_installed: 'update.installed', update_rolled_back: 'update.rolled_back', update_failed: 'update.failed' });
const CAPACITY_USES = new Set(['application','database','credentials','logs','cache','temporary','restore_points','mail']);
const OUTBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS notification_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
  kind TEXT NOT NULL, destination TEXT NOT NULL, provider TEXT NOT NULL, incident_id TEXT NOT NULL,
  account_id INTEGER, job_id INTEGER, mount_id TEXT, mount_uses TEXT, reason_code TEXT NOT NULL,
  occurred_at INTEGER NOT NULL, next_attempt_at INTEGER, state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, lease_id TEXT, lease_until INTEGER, delivery_code TEXT,
  sent_at INTEGER, updated_at INTEGER NOT NULL, UNIQUE(generation, account_id, job_id, kind)
);`;
const SYNC_COLUMNS = 'seq,event_id,generation,kind,destination,provider,incident_id,account_id,job_id,reason_code,occurred_at,next_attempt_at,state,attempts,lease_id,lease_until,delivery_code,sent_at,updated_at';

function migrateNotificationOutbox(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_runtime (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL);
    INSERT OR IGNORE INTO notification_runtime(singleton,generation) VALUES(1,0);
    CREATE TABLE IF NOT EXISTS notification_incidents (
      incident_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, destination TEXT NOT NULL, account_id INTEGER NOT NULL,
      opened_at INTEGER NOT NULL, closed_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_current_incident
      ON notification_incidents(generation,destination,account_id) WHERE closed_at IS NULL;
    CREATE TABLE IF NOT EXISTS capacity_incidents (
      incident_id TEXT PRIMARY KEY, mount_id TEXT NOT NULL, reason_code TEXT NOT NULL, opened_at INTEGER NOT NULL,
      closed_at INTEGER, uses_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_active ON capacity_incidents(mount_id) WHERE closed_at IS NULL;
  `);
  const columns = db.prepare('PRAGMA table_info(notification_outbox)').all();
  if (columns.length && !columns.some(column => column.name === 'mount_id')) {
    db.transaction(() => db.exec(`ALTER TABLE notification_outbox RENAME TO notification_outbox_sync_legacy;
      ${OUTBOX_SCHEMA}
      INSERT INTO notification_outbox (${SYNC_COLUMNS}) SELECT ${SYNC_COLUMNS} FROM notification_outbox_sync_legacy;
      INSERT INTO sqlite_sequence(name,seq) SELECT 'notification_outbox',seq FROM sqlite_sequence WHERE name='notification_outbox_sync_legacy'
        AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='notification_outbox');
      UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='notification_outbox_sync_legacy'),0))
        WHERE name='notification_outbox';
      DROP TABLE notification_outbox_sync_legacy;`))();
  } else db.exec(OUTBOX_SCHEMA);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_deliverable ON notification_outbox(state,next_attempt_at,seq);
    CREATE INDEX IF NOT EXISTS idx_notification_history ON notification_outbox(occurred_at,event_id);
    CREATE INDEX IF NOT EXISTS idx_notification_incident_events ON notification_outbox(incident_id,state,kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_capacity_event ON notification_outbox(incident_id,kind) WHERE mount_id IS NOT NULL;`);
  const currentColumns = new Set(db.prepare('PRAGMA table_info(notification_outbox)').all().map(column => column.name));
  for (const column of ['operation_id', 'operation_from', 'operation_to', 'operation_epoch']) {
    if (!currentColumns.has(column)) db.exec(`ALTER TABLE notification_outbox ADD COLUMN ${column} TEXT`);
  }
  if (!currentColumns.has('may_have_delivered')) {
    // The schema additions and pending-row reconciliation must commit together.
    db.exec('SAVEPOINT notification_webhook_retry_policy');
    try {
      db.exec(`ALTER TABLE notification_outbox ADD COLUMN attempt_dedup_epoch TEXT;
        ALTER TABLE notification_outbox ADD COLUMN may_have_delivered INTEGER NOT NULL DEFAULT 0;
        UPDATE notification_outbox SET state='uncertain', next_attempt_at=NULL, may_have_delivered=1
          WHERE state='retrying' AND NOT (attempts=1 AND delivery_code IS 'http_429');
        RELEASE notification_webhook_retry_policy;`);
    } catch (error) {
      db.exec('ROLLBACK TO notification_webhook_retry_policy; RELEASE notification_webhook_retry_policy');
      throw error;
    }
  }
  const volumeColumns = db.prepare('PRAGMA table_info(capacity_incidents)').all();
  if (!volumeColumns.some(column => column.name === 'healthy_since')) db.exec('ALTER TABLE capacity_incidents ADD COLUMN healthy_since INTEGER');
  migrateRestoreNotificationSource(db);
}

const safeId = value => Number.isSafeInteger(value) && value > 0;
function recordSyncIntent(db, input, destination, now = Date.now()) {
  if (!destination || destination.subscriptions?.sync === false || !safeId(input.accountId) || !safeId(input.jobId) || !['failure', 'recovery'].includes(input.kind)) return null;
  const { accountId, jobId, kind } = input;
  const parsed = typeof input.occurredAt === 'string' ? Date.parse(input.occurredAt) : input.occurredAt;
  const at = Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 8.64e15 ? parsed : now;
  const category = kind === 'failure' ? CATEGORIES.has(input.category) ? input.category : 'unknown' : 'recovered';
  const generation = db.prepare('SELECT generation FROM notification_runtime WHERE singleton=1').get().generation;
  const key = destination.key;
  const prior = db.prepare('SELECT event_id FROM notification_outbox WHERE generation=? AND account_id=? AND job_id=? AND kind=?')
    .get(generation, accountId, jobId, kind);
  if (prior) return prior.event_id;
  let incident = db.prepare(`SELECT incident_id FROM notification_incidents
    WHERE generation=? AND destination=? AND account_id=? AND closed_at IS NULL`).get(generation, key, accountId)?.incident_id;
  if (!incident) {
    if (kind === 'recovery') return null;
    incident = randomUUID();
    db.prepare('INSERT INTO notification_incidents(incident_id,generation,destination,account_id,opened_at) VALUES(?,?,?,?,?)')
      .run(incident, generation, key, accountId, at);
  }
  let state = 'queued';
  if (kind === 'failure') {
    const last = db.prepare(`SELECT MAX(COALESCE(sent_at,occurred_at)) AS at FROM notification_outbox
      WHERE incident_id=? AND kind='failure' AND state IN (${ACTIVE},'sent','uncertain')`).get(incident).at;
    if (last !== null && at - last < destination.cooldownMinutes * MINUTE) state = 'suppressed';
  }
  const eventId = randomUUID();
  db.prepare(`INSERT INTO notification_outbox(event_id,generation,kind,destination,provider,incident_id,account_id,job_id,
    reason_code,occurred_at,next_attempt_at,state,delivery_code,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(eventId, generation, kind, key, destination.provider, incident, accountId, jobId, category, at,
      state === 'queued' ? now : null, state, state === 'suppressed' ? 'cooldown' : null, now);
  if (kind === 'recovery') db.prepare('UPDATE notification_incidents SET closed_at=? WHERE incident_id=?').run(at, incident);
  return eventId;
}

function suppressNotificationDeliveries(db, now = Date.now()) {
  db.prepare(`UPDATE notification_outbox SET state=CASE WHEN state='sending' OR may_have_delivered=1 THEN 'uncertain' ELSE 'suppressed' END,
    lease_id=NULL, lease_until=NULL, next_attempt_at=NULL, delivery_code='data_restored', updated_at=? WHERE state IN (${ACTIVE})`).run(now);
  db.prepare('UPDATE notification_incidents SET closed_at=? WHERE closed_at IS NULL').run(now);
  db.prepare('UPDATE notification_runtime SET generation=generation+1 WHERE singleton=1').run();
}

function recordCapacityObservations(db, capacity, now = Date.now(), destination = null) {
  if (!Array.isArray(capacity?.observations)) return new Set();
  const pendingRecovery = new Set();
  const enqueue = (incident, kind, reason) => {
    if (!destination?.subscriptions?.capacity) return;
    const { generation } = db.prepare('SELECT generation FROM notification_runtime WHERE singleton=1').get();
    if (kind === 'capacity_recovery' && !db.prepare(`SELECT 1 FROM notification_outbox WHERE incident_id=? AND kind='capacity_failure'
      AND destination=? AND generation=? AND state IN (${ACTIVE},'sent')`).get(incident.incident_id,destination.key,generation)) return;
    db.prepare(`INSERT INTO notification_outbox(event_id,generation,kind,destination,provider,incident_id,mount_id,mount_uses,reason_code,
      occurred_at,next_attempt_at,state,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?) ON CONFLICT DO NOTHING`)
      .run(randomUUID(),generation,kind,destination.key,destination.provider,incident.incident_id,incident.mount_id,incident.uses_json,reason,now,now,now);
  };
  db.transaction(() => {
    for (const item of capacity.observations.slice(0, 16)) {
      if (typeof item.mountId !== 'string' || !/^[0-9a-f]{20}$/.test(item.mountId)) continue;
      const current = db.prepare('SELECT * FROM capacity_incidents WHERE mount_id=? AND closed_at IS NULL').get(item.mountId);
      if (item.ok) {
        if (!current) continue;
        if (current.healthy_since === null) {
          db.prepare('UPDATE capacity_incidents SET healthy_since=? WHERE incident_id=?').run(now,current.incident_id);
          pendingRecovery.add(item.mountId);
        } else if (now - current.healthy_since >= MINUTE) {
          db.prepare('UPDATE capacity_incidents SET closed_at=? WHERE incident_id=?').run(now,current.incident_id);
          enqueue(current,'capacity_recovery','recovered');
        } else pendingRecovery.add(item.mountId);
      } else if (['low_space','low_inodes'].includes(item.code)) {
        const uses = JSON.stringify([...new Set((Array.isArray(item.uses) ? item.uses : []).filter(use => CAPACITY_USES.has(use)))].sort());
        if (current) db.prepare(`UPDATE capacity_incidents SET reason_code=?,uses_json=?,healthy_since=NULL WHERE incident_id=?`)
          .run(item.code,uses,current.incident_id);
        else {
          const incident = { incident_id:randomUUID(), mount_id:item.mountId, uses_json:uses };
          db.prepare('INSERT INTO capacity_incidents(incident_id,mount_id,reason_code,opened_at,uses_json) VALUES(?,?,?,?,?)')
            .run(incident.incident_id,item.mountId,item.code,now,uses);
          enqueue(incident,'capacity_failure',item.code);
        }
      } else if (current?.healthy_since != null) {
        db.prepare('UPDATE capacity_incidents SET healthy_since=NULL WHERE incident_id=?').run(current.incident_id);
      }
    }
  })();
  return pendingRecovery;
}

function bodyFor(row) {
  const common = { eventId: row.event_id, incidentId: row.incident_id, reasonCode: row.reason_code,
    occurredAt: new Date(row.occurred_at).toISOString() };
  if (row.operation_id) return { eventId: row.event_id, occurredAt: common.occurredAt, event: OPERATION_EVENTS[row.kind],
    operation: { id: row.operation_id, ...(row.operation_to && { from: row.operation_from, to: row.operation_to }) } };
  if (row.mount_id) return { ...common, event: row.kind === 'capacity_failure' ? 'capacity.low' : 'capacity.recovered',
    mount: { id: row.mount_id, uses: JSON.parse(row.mount_uses || '[]') } };
  return { ...common, event: row.kind === 'failure' ? 'sync.failed' : 'sync.recovered', account: { id: row.account_id }, jobId: row.job_id };
}

const publicEvent = row => ({ ...bodyFor(row), state: row.state, attempts: row.attempts,
  deliveryCode: row.delivery_code, nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
  sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null });

function deliveryHistory(db, { before, limit } = {}) {
  const size = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 100) : 30;
  const cursor = safeId(Number(before)) ? Number(before) : Number.MAX_SAFE_INTEGER;
  const data = db.prepare('SELECT * FROM notification_outbox WHERE seq<? ORDER BY seq DESC LIMIT ?').all(cursor, size + 1);
  return { events: data.slice(0, size).map(publicEvent), nextBefore: data.length > size ? data[size - 1].seq : null };
}

// Keyset pagination over both stores; sorting by send time would reorder old
// entries during retries. New events at the head are picked up on refresh.
function mergedDeliveryHistory(stores, { before, limit } = {}) {
  const size = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 100) : 30;
  const cursor = /^(\d{1,16}):([a-z0-9:-]{1,110})$/.exec(String(before || ''));
  const at = cursor && Number.isSafeInteger(Number(cursor[1])) ? Number(cursor[1]) : Number.MAX_SAFE_INTEGER;
  const id = cursor?.[2] || '';
  const data = stores.flatMap(db => db.prepare(`SELECT * FROM notification_outbox
    WHERE (occurred_at,event_id)<(?,?) ORDER BY occurred_at DESC,event_id DESC LIMIT ?`).all(at, id, size + 1))
    .sort((a, b) => b.occurred_at - a.occurred_at || (a.event_id < b.event_id ? 1 : a.event_id > b.event_id ? -1 : 0));
  const last = data[size - 1];
  return { events: data.slice(0, size).map(publicEvent), nextBefore: data.length > size ? `${last.occurred_at}:${last.event_id}` : null };
}

function retryDelay(attempts, jitter = Math.random) {
  return Math.floor(Math.min(60 * MINUTE, 15_000 * 2 ** Math.max(0, attempts - 1)) * (0.8 + jitter() * 0.4));
}

function createDeliveryWorker(db, { destination, deliver, canDeliver = () => true, now = Date.now,
  jitter = Math.random, onError = () => {}, parallel = 2 } = {}) {
  let activity = null, ticker = null, lifecycle = 0;
  const deduplicates = (target, row) => row.provider === 'webhook' && target?.provider === 'webhook' &&
    target.key === row.destination && !!row.attempt_dedup_epoch && target.dedupEpoch === row.attempt_dedup_epoch;
  const expiredLeases = db.prepare(`SELECT * FROM notification_outbox WHERE state='sending'
    AND (lease_until IS NULL OR lease_until<=?)`);
  const ambiguousRetry = db.prepare(`SELECT 1 FROM notification_outbox WHERE state='retrying' AND may_have_delivered=1 LIMIT 1`);
  const claim = db.transaction(target => {
    const time = now();
    for (const row of expiredLeases.all(time)) {
      const safeRetry = deduplicates(target, row) && row.attempts < MAX_ATTEMPTS && row.occurred_at >= time - RETENTION;
      db.prepare(`UPDATE notification_outbox SET state=?, lease_id=NULL, lease_until=NULL, next_attempt_at=?,
        delivery_code='lease_expired', may_have_delivered=1, updated_at=? WHERE seq=?`)
        .run(safeRetry ? 'retrying' : 'uncertain', safeRetry ? time + retryDelay(row.attempts, jitter) : null, time, row.seq);
    }
    db.prepare(`UPDATE notification_outbox SET state='uncertain', next_attempt_at=NULL, updated_at=?
      WHERE state='retrying' AND may_have_delivered=1 AND (provider<>'webhook' OR destination IS NOT ?
        OR attempt_dedup_epoch IS NULL OR attempt_dedup_epoch IS NOT ?)`).run(time,
      target?.key ?? null, target?.provider === 'webhook' ? target.dedupEpoch ?? null : null);
    if (!target) return [];
    db.prepare(`UPDATE notification_outbox SET state='suppressed', next_attempt_at=NULL, delivery_code='destination_changed', updated_at=?
      WHERE state IN ('queued','retrying') AND destination<>?`).run(time, target.key);
    db.prepare(`UPDATE notification_incidents SET closed_at=? WHERE closed_at IS NULL AND destination<>?`).run(time,target.key);
    db.prepare(`UPDATE notification_outbox SET state=CASE WHEN may_have_delivered=1 THEN 'uncertain' ELSE 'suppressed' END,
      next_attempt_at=NULL,delivery_code='subscription_disabled',updated_at=?
      WHERE state IN ('queued','retrying') AND ((operation_id IS NULL AND mount_id IS NULL AND ?=0)
        OR (mount_id IS NOT NULL AND ?=0)
        OR (kind IN ('restore_committed','restore_rolled_back') AND operation_epoch IS NOT ?)
        OR (kind IN ('update_installed','update_rolled_back','update_failed') AND operation_epoch IS NOT ?))`)
      .run(time, Number(target.subscriptions?.sync !== false), Number(target.subscriptions?.capacity === true),
        target.operationEpochs?.restore?.id || null, target.operationEpochs?.update?.id || null);
    db.prepare(`UPDATE notification_outbox SET state=CASE WHEN may_have_delivered=1 THEN 'uncertain' ELSE 'suppressed' END,
      next_attempt_at=NULL, delivery_code='expired', updated_at=?
      WHERE state IN ('queued','retrying') AND occurred_at<?`).run(time, time - RETENTION);
    db.prepare(`UPDATE notification_outbox AS current SET state=CASE WHEN may_have_delivered=1 THEN 'uncertain' ELSE 'suppressed' END,
      next_attempt_at=NULL, delivery_code='no_delivered_failure', updated_at=?
      WHERE kind IN ('recovery','capacity_recovery') AND state IN ('queued','retrying') AND NOT EXISTS (SELECT 1 FROM notification_outbox AS earlier
        WHERE earlier.incident_id=current.incident_id AND earlier.destination=current.destination AND earlier.generation=current.generation
        AND earlier.kind IN ('failure','capacity_failure') AND earlier.state IN (${ACTIVE},'sent'))`).run(time);
    const rows = db.prepare(`SELECT * FROM notification_outbox AS current WHERE state IN ('queued','retrying') AND destination=? AND next_attempt_at<=?
      AND (operation_id IS NOT NULL OR kind IN ('failure','capacity_failure') OR EXISTS (SELECT 1 FROM notification_outbox AS earlier WHERE earlier.incident_id=current.incident_id
        AND earlier.generation=current.generation AND earlier.destination=current.destination AND earlier.kind IN ('failure','capacity_failure') AND earlier.state='sent'))
      AND NOT EXISTS (SELECT 1 FROM notification_outbox AS earlier WHERE (earlier.account_id=current.account_id OR earlier.mount_id=current.mount_id)
        AND earlier.destination=current.destination AND earlier.seq<current.seq AND earlier.state IN (${ACTIVE}))
      ORDER BY next_attempt_at,seq LIMIT ?`).all(target.key, time, parallel);
    return rows.map(row => {
      const lease = randomUUID();
      const epoch = target.provider === 'webhook' ? target.dedupEpoch ?? null : null;
      db.prepare(`UPDATE notification_outbox SET state='sending', lease_id=?, lease_until=?, attempts=attempts+1,
        attempt_dedup_epoch=?, updated_at=? WHERE seq=?`).run(lease, time + LEASE, epoch, time, row.seq);
      return { ...row, lease_id: lease, attempts: row.attempts + 1, attempt_dedup_epoch: epoch };
    });
  });
  function finish(row, { state, code, delay = null, ambiguous = false }) {
    const time = now();
    db.prepare(`UPDATE notification_outbox SET state=?, delivery_code=?, next_attempt_at=?, sent_at=?, updated_at=?,
      lease_id=NULL, lease_until=NULL, may_have_delivered=? WHERE seq=? AND lease_id=? AND state='sending'`)
      .run(state, code, delay === null ? null : time + delay, state === 'sent' ? time : null, time,
        Number(state !== 'sent' && (ambiguous || row.may_have_delivered === 1)), row.seq, row.lease_id);
  }
  async function one(row, target) {
    try {
      await deliver(target, bodyFor(row));
    } catch (error) {
      const http = Number(error?.httpStatus);
      const isHttp = Number.isInteger(http) && http >= 100 && http <= 599;
      const code = isHttp ? `http_${http}` : 'connection_error';
      // A later definite rejection cannot resolve any earlier ambiguous attempt.
      const ambiguous = !isHttp || http === 408 || http >= 500 || row.may_have_delivered === 1;
      if (ambiguous && !deduplicates(destination(), row)) return finish(row, { state: 'uncertain', code, ambiguous });
      if ((!isHttp || http === 408 || http >= 500 || http === 429) && row.attempts < MAX_ATTEMPTS) {
        const retryAfter = Number(error?.retryAfterMs);
        const suggested = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(DAY, retryAfter) : 0;
        return finish(row, { state: 'retrying', code, ambiguous, delay: Math.max(retryDelay(row.attempts, jitter), suggested) });
      }
      return finish(row, { state: ambiguous ? 'uncertain' : 'failed', code, ambiguous });
    }
    finish(row, { state: 'sent', code: null });
  }
  let nextCleanup = 0;
  function prune(time) {
    const cutoff = time - RETENTION;
    db.prepare(`DELETE FROM notification_incidents WHERE closed_at<? AND NOT EXISTS
      (SELECT 1 FROM notification_outbox WHERE notification_outbox.incident_id=notification_incidents.incident_id AND state IN (${ACTIVE}))`).run(cutoff);
    db.prepare(`DELETE FROM notification_outbox WHERE seq IN (SELECT current.seq FROM notification_outbox AS current
      WHERE current.updated_at<? AND current.state NOT IN (${ACTIVE})
        AND NOT EXISTS (SELECT 1 FROM notification_outbox AS keep WHERE keep.incident_id=current.incident_id
          AND keep.state IN (${ACTIVE}))
        AND NOT (current.kind='failure' AND current.state='sent' AND EXISTS (SELECT 1 FROM notification_incidents AS incident
          WHERE incident.incident_id=current.incident_id AND incident.closed_at IS NULL)
          AND current.seq=(SELECT MAX(sent.seq) FROM notification_outbox AS sent WHERE sent.incident_id=current.incident_id
            AND sent.kind='failure' AND sent.state='sent'))
        AND NOT (current.kind='capacity_failure' AND current.state='sent' AND EXISTS (SELECT 1 FROM capacity_incidents AS incident
          WHERE incident.incident_id=current.incident_id AND incident.closed_at IS NULL))
      ORDER BY current.updated_at LIMIT 2000)`).run(cutoff);
    db.prepare('DELETE FROM capacity_incidents WHERE closed_at<?').run(cutoff);
  }
  function tick() {
    if (activity) return activity;
    if (!canDeliver()) return Promise.resolve();
    const generation = lifecycle;
    activity = Promise.resolve().then(async () => {
      if (generation !== lifecycle || !canDeliver()) return;
      const target = destination();
      if (!target && !ambiguousRetry.get() && !expiredLeases.get(now())) return;
      const rows = claim(target);
      if (now() >= nextCleanup) { prune(now()); nextCleanup = now() + DAY; }
      await Promise.allSettled(rows.map(row => one(row, target))).then(results => {
        if (results.some(item => item.status === 'rejected')) onError();
      });
    }).catch(() => onError()).finally(() => { activity = null; });
    return activity;
  }
  function start() {
    if (ticker) return;
    ticker = setInterval(tick, 2000); ticker.unref?.();
    void tick();
  }
  function stop() { lifecycle++; if (ticker) clearInterval(ticker); ticker = null; }
  return { start, stop, tick, isActive: () => activity !== null, drain: () => activity || Promise.resolve(),
    wake: () => { if (ticker) void tick(); } };
}

module.exports = { migrateNotificationOutbox, recordSyncIntent, suppressNotificationDeliveries, recordCapacityObservations,
  deliveryHistory, mergedDeliveryHistory, createDeliveryWorker };
