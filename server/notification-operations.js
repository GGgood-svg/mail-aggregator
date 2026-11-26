'use strict';
const { TARGET } = require('../scripts/updater/release');
const { UUID } = require('./notification-config');
const { createDeliveryWorker, migrateNotificationOutbox } = require('./notification-outbox');
const RETENTION = 30 * 24 * 60 * 60_000;
const HEX_ID = /^[a-f0-9]{32}$/;
const RESTORE = Object.freeze({ committed:'restore_committed', recovered_committed:'restore_committed', rolled_back:'restore_rolled_back' });
const UPDATE = Object.freeze({ installed:'update_installed', rollback_verified:'update_rolled_back', failed:'update_failed' });

function normalizeRestore(row) {
  if (!HEX_ID.test(row?.operation_id) || !Object.hasOwn(RESTORE, row.outcome)) return null;
  return { source:'restore', id:row.operation_id, kind:RESTORE[row.outcome], at:Date.parse(row.at) };
}
function normalizeUpdate(row) {
  if (!(UUID.test(row?.operationId) || HEX_ID.test(row?.operationId)) || !Object.hasOwn(UPDATE, row.outcome) ||
    typeof row.from !== 'string' || typeof row.to !== 'string' || !TARGET.test(`v${row.from}`) || !TARGET.test(`v${row.to}`)) return null;
  return { source:'update', id:row.operationId, kind:UPDATE[row.outcome], at:row.at, from:row.from, to:row.to };
}

// An app-only bundle cannot replace the root-owned updater. Older updater
// installations may still provide terminal history through the status RPC.
async function readUpdaterNotificationHistory(socket, request) {
  try { return await request(socket, { op:'notification-history' }); }
  catch (error) {
    if (error.code !== 'unknown_operation') throw error;
    return (await request(socket, { op:'status' })).history;
  }
}

function createOperationOutbox(db) {
  migrateNotificationOutbox(db);
  db.exec(`CREATE TABLE IF NOT EXISTS notification_operation_receipts (
    source TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY(source,operation_id)
  ) WITHOUT ROWID;`);
  const receipt = db.prepare('INSERT OR IGNORE INTO notification_operation_receipts(source,operation_id) VALUES(?,?)');
  const enqueue = db.prepare(`INSERT INTO notification_outbox (event_id,generation,kind,destination,provider,incident_id,
    operation_id,operation_from,operation_to,operation_epoch,reason_code,occurred_at,next_attempt_at,state,updated_at)
    VALUES (?,0,@kind,@destination,@provider,?,@id,@from,@to,@epoch,@kind,@at,@now,'queued',@now)`);
  const ingest = db.transaction((items, destination, now) => {
    let added = false;
    for (const item of items) {
      if (!item || !Number.isSafeInteger(item.at) || item.at < now - RETENTION || item.at > now) continue;
      const epoch = destination?.operationEpochs?.[item.source];
      if (!epoch || item.at <= epoch.since) continue;
      if (!receipt.run(item.source, item.id).changes) continue;
      const eventId = `operation:${item.source}:${item.id}`;
      enqueue.run(eventId, eventId, { ...item, from:item.from || null, to:item.to || null, epoch:epoch.id, now,
        destination:destination.key, provider:destination.provider });
      added = true;
    }
    return added;
  });
  return { ingest };
}

function createOperationNotifications({ db, applicationDb, destination, deliver, canDeliver, readUpdates,
  now = Date.now, onError = () => {} }) {
  const store = createOperationOutbox(db);
  const worker = createDeliveryWorker(db, { destination, deliver, canDeliver, now, onError });
  const fetchRestore = applicationDb.prepare(`SELECT operation_id,outcome,at FROM restore_notification_source
    WHERE (at,operation_id)>(?,?) AND at<=? ORDER BY at,operation_id LIMIT 100`);
  let timer = null, lifecycle = 0, lookup = null, nextLookup = 0, restoreEpoch, restoreAfter;
  function accept(items, target) {
    if (store.ingest(items, target, now())) worker.wake();
  }
  function poll() {
    try {
      if (!canDeliver()) return;
      const target = destination();
      const time = now();
      const restore = target?.operationEpochs?.restore;
      if (restore) {
        if (restoreEpoch !== restore.id) {
          restoreEpoch = restore.id;
          restoreAfter = [new Date(Math.max(restore.since, time - RETENTION)).toISOString(), 'z'];
        }
        const records = fetchRestore.all(...restoreAfter, new Date(time).toISOString());
        if (records.length) {
          accept(records.map(normalizeRestore), target);
          const last = records.at(-1);
          restoreAfter = [last.at, last.operation_id];
        }
      }
      const update = target?.operationEpochs?.update;
      if (!update || !readUpdates || lookup || time < nextLookup) return;
      nextLookup = time + 30_000;
      const revision = lifecycle;
      lookup = Promise.resolve().then(readUpdates).then(records => {
        if (revision !== lifecycle || !canDeliver()) return;
        const latest = destination();
        if (latest?.operationEpochs?.update?.id !== update.id) return;
        if (Array.isArray(records)) accept(records.slice(0, 60).map(normalizeUpdate), latest);
      }).catch(onError).finally(() => { lookup = null; });
    } catch (_) { onError(); }
  }
  function start() {
    if (timer) return;
    timer = setInterval(poll, 5000); timer.unref?.();
    poll(); worker.start();
  }
  function stop() {
    lifecycle++; worker.stop();
    if (timer) clearInterval(timer);
    timer = null; nextLookup = 0;
  }
  return { start, stop, wake() { if (timer) { poll(); worker.wake(); } }, busy:worker.isActive, drain:worker.drain,
    poll, tick:worker.tick, waitForLookup:() => lookup || Promise.resolve() };
}

module.exports = { createOperationOutbox, createOperationNotifications, normalizeRestore, normalizeUpdate, readUpdaterNotificationHistory };
