'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { initializeRestoreState } = require('../server/restore-journal');
const { migrateNotificationOutbox, deliveryHistory, mergedDeliveryHistory, recordSyncIntent } = require('../server/notification-outbox');
const { createOperationNotifications, normalizeUpdate, readUpdaterNotificationHistory } = require('../server/notification-operations');
const { notificationConfigStore, nextOperationEpochs, subscriptions, webhookDedupEpoch, nextWebhookDeduplication } = require('../server/notification-config');
const { createUpdateGate } = require('../server/update-gate');

const RESTORE = 'a'.repeat(32), RESTORE_2 = 'b'.repeat(32), RESTORE_3 = 'c'.repeat(32);
const UPDATE = '5a8b9415-3e22-44d0-bdc4-09f54a1154f8';
const UPDATE_2 = '4d9840a2-083a-414f-a601-0c67634bc124';
const BASE = 1_800_000_000_000;

function files(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-operation-notify-'));
  const root = fs.realpathSync(directory);
  t.after(() => {
    assert.equal(fs.realpathSync(directory), root);
    assert(path.basename(root).startsWith('mail-operation-notify-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return name => path.join(root, name);
}
function appDatabase(filename = ':memory:') {
  const db = new Database(filename);
  initializeRestoreState(db);
  migrateNotificationOutbox(db);
  return db;
}
function mark(db, id, outcome, at) {
  db.prepare(`INSERT INTO restore_state VALUES (1,?,?,?) ON CONFLICT(singleton) DO UPDATE
    SET operation_id=excluded.operation_id,outcome=excluded.outcome,recorded_at=excluded.recorded_at`)
    .run(id, outcome, new Date(at).toISOString());
}
function fixture(applicationDb, db) {
  const history = () => deliveryHistory(db);
  let now = BASE, maintenance = false, reads = 0, updates = [];
  const provider = 'webhook', key = 'fictional-destination';
  const config = { enabled:true, subscriptions:{ restore:true, update:true } };
  const dedupEpoch = nextWebhookDeduplication({}, { enabled:true, provider }, true, false).webhookDedupEpoch;
  let target = { provider, key, dedupEpoch, operationEpochs: nextOperationEpochs({}, config, key, now) };
  const sent = [];
  const start = ({ send, canDeliver, readUpdates } = {}) => createOperationNotifications({ db, applicationDb,
    destination:() => target, canDeliver:canDeliver || (() => !maintenance), now:() => now,
    readUpdates:readUpdates || (async () => { reads++; return updates; }),
    deliver:async (_, event) => { sent.push(event); await send?.(event); }, onError:error => { throw error || new Error('outbox worker'); } });
  return { start, history, sent, reads:() => reads, setUpdates:value => { updates = value; },
    setMaintenance:value => { maintenance = value; }, advance:ms => { now += ms; return now; }, clock:() => now,
    reenable() { target = { provider, key, dedupEpoch, operationEpochs:nextOperationEpochs({}, config, key, now) }; } };
}

test('restore terminal markers commit in the same SQLite transaction and survive singleton overwrite without duplicate recovery', async t => {
  const app = appDatabase(), store = new Database(':memory:');
  t.after(() => { store.close(); app.close(); });
  const f = fixture(app, store), worker = f.start();
  const at = f.advance(1000);
  assert.throws(app.transaction(() => { mark(app, RESTORE, 'committed', at); throw new Error('rollback'); }), /rollback/);
  mark(app, RESTORE, 'preparing', at);
  mark(app, RESTORE_2, 'committed', at);
  mark(app, RESTORE_2, 'recovered_committed', at + 1);
  mark(app, RESTORE_3, 'rolled_back', at + 2);
  f.advance(2);
  f.setMaintenance(true);
  worker.poll(); await worker.tick();
  assert.equal(f.history().events.length, 0);
  assert.equal(f.reads(), 0);
  f.setMaintenance(false);
  worker.poll(); await worker.tick();
  assert.deepEqual(f.sent.map(event => [event.event, event.operation.id]), [
    ['restore.committed', RESTORE_2], ['restore.rolled_back', RESTORE_3],
  ]);
  assert(!JSON.stringify(f.sent).includes('jobId'));
  await f.start().tick();
  assert.equal(f.sent.length, 2);
});

test('restarted process and a replaced SQLite application snapshot cannot replay a sent event', async t => {
  const filename = files(t), livePath = filename('mail-aggregator.db'), oldPath = filename('old-app.db'), deliveryPath = filename('notification-operations.db');
  let app = appDatabase(livePath), store = new Database(deliveryPath);
  try {
    const first = fixture(app, store);
    mark(app, RESTORE, 'committed', first.advance(1000));
    await app.backup(oldPath);
    const before = first.start();
    before.poll(); await before.tick();
    assert.equal(first.sent[0].eventId, `operation:restore:${RESTORE}`);
    mark(app, RESTORE_2, 'rolled_back', first.advance(1000));
    before.poll(); await before.tick();
    assert.equal(first.sent.length, 2);
    app.close(); store.close();
    fs.copyFileSync(oldPath, livePath);
    app = appDatabase(livePath); store = new Database(deliveryPath);
    const after = fixture(app, store); after.advance(3000);
    const restarted = after.start();
    restarted.poll(); await restarted.tick();
    assert.deepEqual(after.sent, []);
    assert.equal(after.history().events.length, 2);
    // Delivery history can expire without forgetting the operation receipt.
    store.prepare('DELETE FROM notification_outbox WHERE operation_id=?').run(RESTORE);
    const anotherRestart = after.start();
    anotherRestart.poll(); await anotherRestart.tick();
    assert.deepEqual(after.sent, []);
    mark(app, RESTORE_3, 'committed', after.advance(1000));
    anotherRestart.poll(); await anotherRestart.tick();
    assert.equal(after.sent[0].operation.id, RESTORE_3);
  } finally { if (app.open) app.close(); if (store.open) store.close(); }
});

test('updates require a confirmed completion, suppress pre-opt-in outcomes, and retry with the same stable event ID', async t => {
  const app = appDatabase(), store = new Database(':memory:');
  t.after(() => { store.close(); app.close(); });
  const f = fixture(app, store);
  const failed = f.start({ send:async () => { throw Object.assign(new Error('sensitive endpoint error'), { httpStatus:503 }); } });
  const at = f.advance(1000);
  const entry = { operationId:UPDATE, from:'1.0.0', to:'1.0.1', at, reason:'sensitive updater error' };
  f.setUpdates(['queued','preparing','installing','deferred','rolled_back','rollback_failed','finalization_failed']
    .map(outcome => ({ ...entry, outcome })).concat([{ ...entry, at:BASE - 1, outcome:'installed' }]));
  failed.poll(); await failed.waitForLookup(); await failed.tick();
  assert.deepEqual(f.history().events, []);
  f.advance(31_000);
  const rolledBack = { ...entry, outcome:'rollback_verified' };
  f.setUpdates([rolledBack, rolledBack]);
  failed.poll(); await failed.waitForLookup(); await failed.tick();
  const pending = f.history().events[0];
  assert.equal(pending.state, 'retrying');
  assert.equal(pending.deliveryCode, 'http_503');
  const success = f.start();
  f.advance(31_000);
  success.poll(); await success.waitForLookup(); await success.tick();
  assert.deepEqual(f.sent.map(event => event.eventId), [pending.eventId, pending.eventId]);
  assert.deepEqual(f.sent[0], { eventId:`operation:update:${UPDATE}`, occurredAt:new Date(at).toISOString(), event:'update.rolled_back',
    operation:{ id:UPDATE, from:'1.0.0', to:'1.0.1' } });
  assert.equal(f.history().events[0].state, 'sent');
});

test('candidate readiness neither claims pending events nor accepts a late updater read from a paused worker', async t => {
  const app = appDatabase(), store = new Database(':memory:');
  t.after(() => { store.close(); app.close(); });
  const f = fixture(app, store);
  let paused = false, finishRead;
  const gate = createUpdateGate({ journal:'synthetic', pending:() => paused, database:() => true,
    busy:() => worker.busy(), pause:() => worker.stop(), resume:() => {} });
  const worker = f.start({ canDeliver:() => !gate.blocked(), readUpdates:() => new Promise(resolve => { finishRead = resolve; }) });
  const at = f.advance(1000);
  mark(app, RESTORE, 'committed', at);
  worker.poll();
  await Promise.resolve();
  assert.equal(f.history().events[0].state, 'queued');
  paused = true;
  assert.equal(gate.isIdle(), true);
  finishRead([{ operationId:UPDATE, from:'1.0.0', to:'1.0.1', at, outcome:'installed' }]);
  await worker.waitForLookup();
  worker.poll(); await worker.tick();
  assert.equal(f.history().events.length, 1);
  assert.deepEqual(f.sent, []);
  paused = false;
  await worker.tick();
  assert.equal(f.sent.length, 1);
});

test('resubscribing invalidates pending events from the former opt-in epoch', async t => {
  const app = appDatabase(), store = new Database(':memory:');
  t.after(() => { store.close(); app.close(); });
  const f = fixture(app, store), worker = f.start();
  mark(app, RESTORE, 'committed', f.advance(1000));
  worker.poll();
  assert.equal(f.history().events[0].state, 'queued');
  f.reenable();
  mark(app, RESTORE_2, 'committed', f.advance(1000));
  worker.poll(); await worker.tick();
  assert.deepEqual(f.sent.map(event => event.operation.id), [RESTORE_2]);
  assert.equal(f.history().events.find(event => event.operation.id === RESTORE).deliveryCode, 'subscription_disabled');
});

test('history merges both clocks with a tie-safe cursor and configuration ignores old copied secrets after migration', async t => {
  const app = appDatabase(), store = new Database(':memory:');
  t.after(() => { store.close(); app.close(); });
  const filename = files(t);
  fs.mkdirSync(filename('secrets'));
  const legacy = filename('secrets/notification.json');
  fs.writeFileSync(legacy, JSON.stringify({ enabled:false, subscriptions:{ sync:false, capacity:true, restore:true, update:true } }));
  const config = notificationConfigStore(filename('.'), filename('secrets'));
  config.initialize();
  assert.deepEqual(subscriptions(config.read()), { sync:false, capacity:true, restore:false, update:false });
  fs.writeFileSync(legacy, JSON.stringify({ enabled:true, subscriptions:{ sync:true, restore:true, update:true } }));
  assert.equal(config.read().enabled, false);
  const f = fixture(app, store), worker = f.start();
  const at = f.advance(1000);
  mark(app, RESTORE, 'committed', at);
  f.setUpdates([{ operationId:UPDATE_2, from:'1.0.0', to:'1.0.1', at, outcome:'failed' }]);
  recordSyncIntent(app, { accountId:1, jobId:1, kind:'failure', occurredAt:at }, { key:'sync', provider:'webhook' }, at);
  worker.poll(); await worker.waitForLookup(); await worker.tick();
  let before, events = [];
  do {
    const page = mergedDeliveryHistory([app, store], { limit:1, before });
    events.push(...page.events.map(row => row.event)); before = page.nextBefore;
  } while (before);
  assert.deepEqual(new Set(events), new Set(['restore.committed','update.failed','sync.failed']));
  assert.equal(events.length, 3);
});

test('older root updater status remains compatible without assuming an unverified rollback succeeded', async () => {
  const requests = [], at = BASE + 1000;
  const entry = { operationId:UPDATE, from:'1.0.0', to:'1.0.1', at };
  const history = await readUpdaterNotificationHistory('/test/mock.sock', async (_, options) => {
    requests.push(options.op);
    if (options.op === 'notification-history') throw Object.assign(new Error('unsupported'), { code:'unknown_operation' });
    return { history:[{ ...entry, outcome:'rolled_back' }, { ...entry, operationId:UPDATE_2, outcome:'installed' }] };
  });
  assert.deepEqual(requests, ['notification-history','status']);
  assert.deepEqual(history.map(normalizeUpdate).filter(Boolean).map(item => [item.kind, item.id]), [['update_installed', UPDATE_2]]);
});


test('Webhook deduplication requires explicit approval and rotates independently of operation subscriptions', () => {
  const webhook = {enabled:true,provider:'webhook'};
  const next = (previous, confirmation, sameEndpoint = true, settings = webhook) =>
    ({ ...settings, ...nextWebhookDeduplication(previous,settings,confirmation,sameEndpoint) });
  const defaults = next(webhook,undefined);
  assert.equal(defaults.webhookSupportsDeduplication,false);
  assert.equal(webhookDedupEpoch(defaults),null);
  const confirmed = next(defaults,true);
  const epoch = webhookDedupEpoch(confirmed);
  assert.match(epoch,/^[a-f0-9-]{36}$/);
  assert.equal(webhookDedupEpoch(next(confirmed,undefined)),epoch);
  assert.equal(webhookDedupEpoch(next(confirmed,true)),epoch);
  const revoked = next(confirmed,false);
  assert.equal(webhookDedupEpoch(revoked),null);
  assert.notEqual(webhookDedupEpoch(next(revoked,true)),epoch);
  const disabled = next(confirmed,undefined,true,{ ...webhook, enabled:false });
  assert.equal(webhookDedupEpoch(disabled),null);
  assert.notEqual(webhookDedupEpoch(next(disabled,true)),epoch);
  assert.equal(webhookDedupEpoch(next(confirmed,undefined,false)),null);
  assert.notEqual(webhookDedupEpoch(next(confirmed,true,false)),epoch);
  assert.equal(webhookDedupEpoch(next(confirmed,true,false,{...webhook,provider:'telegram'})),null);
  assert.equal(webhookDedupEpoch({...confirmed,webhookDedupEpoch:'invalid'}),null);
});
