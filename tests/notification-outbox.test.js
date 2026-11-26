'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const DEDUP = '5a8b9415-3e22-44d0-bdc4-09f54a1154f8';
const RECONFIRMED = '4d9840a2-083a-414f-a601-0c67634bc124';
const { migrateNotificationOutbox, recordSyncIntent, suppressNotificationDeliveries,
  recordCapacityObservations, deliveryHistory, createDeliveryWorker } = require('../server/notification-outbox');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...args) => {
    db.exec('BEGIN');
    try { const result = fn(...args); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  t.after(() => db.close());
  migrateNotificationOutbox(db);
  migrateNotificationOutbox(db);
  const target = { key: 'fictional-target-a', provider: 'webhook', cooldownMinutes: 30 };
  let now = 1_800_000_000_000;
  return { db, target, insert(jobId, kind = 'failure', accountId = 11, category = 'auth_failed', destination = target) {
    return recordSyncIntent(db, { jobId, accountId, kind, category, occurredAt: new Date(now).toISOString() }, destination, now);
  }, advance(ms) { now += ms; }, clock: () => now };
}

test('outbox intent is atomic with its enclosing SQLite operation and not recreated on duplicate completion', t => {
  const f = fixture(t);
  assert.throws(f.db.transaction(() => { f.insert(1); throw new Error('later write failed'); }), /later write failed/);
  assert.equal(deliveryHistory(f.db).events.length, 0);
  const id = f.db.transaction(() => f.insert(1))();
  assert.equal(f.db.transaction(() => f.insert(1))(), id);
  const id2 = f.db.transaction(() => f.insert(2))();
  assert.notEqual(id, id2);
  const view = deliveryHistory(f.db, { limit: 1 });
  assert.equal(view.events[0].state, 'suppressed');
  assert.equal(view.events[0].deliveryCode, 'cooldown');
  assert.equal(deliveryHistory(f.db, { before: view.nextBefore, limit: 1 }).events[0].eventId, id);
  assert(!JSON.stringify(view).includes(f.target.key));
});

test('retry persists across worker changes with the same event ID and recovery is sent only after a failure receipt', async t => {
  const f = fixture(t);
  f.target.dedupEpoch = DEDUP;
  const failureId = f.insert(1, 'failure', 11, 'secret from external process');
  const recoveryId = f.insert(2, 'recovery');
  assert.equal(f.insert(10, 'recovery', 99), null);
  const sent = [];
  const create = deliver => createDeliveryWorker(f.db, { destination: () => f.target, deliver, now: f.clock, jitter: () => 0.5 });
  await create(async (_, body) => { sent.push(body); throw Object.assign(new Error('unavailable'), { httpStatus: 503 }); }).tick();
  let history = deliveryHistory(f.db).events;
  assert.equal(history[1].state, 'retrying');
  assert.equal(history[1].deliveryCode, 'http_503');
  assert.equal(history[1].eventId, failureId);
  assert.equal(history[1].reasonCode, 'unknown');
  assert.equal(history[0].state, 'queued');
  const worker = create(async (_, body) => { sent.push(body); });
  await worker.tick();
  assert.deepEqual(sent.map(item => item.eventId), [failureId]);
  f.advance(15_000);
  await worker.tick();
  await worker.tick();
  assert.deepEqual(sent.map(item => item.eventId), [failureId, failureId, recoveryId]);
  assert.equal(sent[0].incidentId, sent[2].incidentId);
  history = deliveryHistory(f.db).events;
  assert.equal(history[0].state, 'sent');
  assert.equal(history[1].state, 'sent');
});

test('pausing claims keeps an already-started delivery visible to the update idle check until its receipt is stored', async t => {
  const f = fixture(t);
  let begin, release;
  const started = new Promise(resolve => { begin = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  f.insert(1);
  const worker = createDeliveryWorker(f.db, { destination: () => f.target, now: f.clock, deliver: () => { begin(); return finish; } });
  worker.start();
  t.after(() => { worker.stop(); release(); });
  await started;
  worker.stop();
  assert.equal(worker.isActive(), true);
  assert.equal(deliveryHistory(f.db).events[0].state, 'sending');
  f.insert(2, 'failure', 12);
  worker.wake();
  release();
  await worker.drain();
  assert.equal(worker.isActive(), false);
  assert.deepEqual(deliveryHistory(f.db).events.map(item => item.state), ['queued', 'sent']);
});

test('a late receipt after restore cannot revive old work or block fresh reused identifiers', async t => {
  const f = fixture(t);
  const oldId = f.insert(1);
  let begun, release;
  const ready = new Promise(resolve => { begun = resolve; });
  const worker = createDeliveryWorker(f.db, { destination: () => f.target, now: f.clock, deliver: () => {
    begun(); return new Promise(resolve => { release = resolve; });
  } });
  const pending = worker.tick();
  await ready;
  f.db.transaction(() => suppressNotificationDeliveries(f.db, f.clock()))();
  const newId = f.insert(1);
  assert.notEqual(oldId, newId);
  release(); await pending;
  assert.deepEqual(deliveryHistory(f.db).events.map(({ eventId, state }) => ({ eventId, state })),
    [{ eventId: newId, state: 'queued' }, { eventId: oldId, state: 'uncertain' }]);
});

test('Telegram ambiguity is not retried, rate-limit retry respects its hint and a second account proceeds', async t => {
  const f = fixture(t);
  const target = { ...f.target, provider: 'telegram' };
  f.insert(1, 'failure', 11, 'auth_failed', target);
  f.insert(2, 'failure', 12, 'auth_failed', target);
  const attempts = [];
  const worker = createDeliveryWorker(f.db, { destination: () => target, now: f.clock, deliver: async (_, body) => {
    attempts.push(body.jobId);
    if (body.jobId === 2) throw Object.assign(new Error('slow down'), { httpStatus: 429, retryAfterMs: 120_000 });
    throw new Error('timeout after send');
  } });
  await worker.tick();
  f.advance(119_999); await worker.tick();
  assert.deepEqual(attempts, [1, 2]);
  f.advance(1); await worker.tick();
  assert.deepEqual(attempts, [1, 2, 2]);
  assert.deepEqual(deliveryHistory(f.db).events.map(item => item.state), ['retrying','uncertain']);
});

test('one volume incident survives repeated global and account observations; busy never closes it', t => {
  const { db } = fixture(t);
  const mountId = '12345678901234567890';
  let now = 1_800_000_000_000;
  function report(code) { recordCapacityObservations(db, { observations: [{ mountId, code, ok: !code, uses: ['logs','mail'] }] }, now); }
  report('low_space'); report('low_space'); report('low_inodes'); report('capacity_busy');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capacity_incidents').get().n, 1);
  const unresolved = db.prepare('SELECT * FROM capacity_incidents').get();
  assert.equal(unresolved.closed_at, null);
  assert.equal(unresolved.reason_code, 'low_inodes');
  report(null); now += 60_000; report(null); report('low_space');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capacity_incidents').get().n, 2);
  assert.notEqual(db.prepare('SELECT incident_id FROM capacity_incidents WHERE closed_at IS NULL').get().incident_id, unresolved.incident_id);
});

test('capacity subscription generates one low event and a confirmed recovery, with same incident and no made-up sync job', async t => {
  const f = fixture(t);
  const target = { ...f.target, dedupEpoch:DEDUP, subscriptions: { capacity:true, sync:false } };
  const mountId = '12345678901234567890';
  const put = code => recordCapacityObservations(f.db, { observations:[{ mountId, code, ok:!code, uses:['logs','logs','/private','mail'] }] }, f.clock(), target);
  assert.equal(f.insert(1, 'failure', 11, 'auth_failed', target), null);
  put('low_space'); put('low_inodes');
  assert.equal(deliveryHistory(f.db).events.length,1);
  const sent = [];
  const worker = createDeliveryWorker(f.db, { destination:() => target, now:f.clock, jitter:() => .5, deliver: async (_, event) => {
    sent.push(event);
    if (sent.length === 1) throw Object.assign(new Error('temporarily unavailable'), { httpStatus:503 });
  } });
  await worker.tick();
  assert.deepEqual([...put(null)], [mountId]);
  f.advance(30_000); assert.deepEqual([...put(null)], [mountId]);
  put('capacity_busy');
  f.advance(60_000); assert.deepEqual([...put(null)], [mountId]);
  f.advance(60_000); assert.deepEqual([...put(null)], []);
  assert.equal(deliveryHistory(f.db).events.length,2);
  await worker.tick(); await worker.tick();
  assert.deepEqual(sent.map(event => event.event), ['capacity.low','capacity.low','capacity.recovered']);
  assert.equal(sent[0].eventId,sent[1].eventId);
  assert.equal(sent[1].incidentId,sent[2].incidentId);
  assert.deepEqual(sent[2].mount,{ id:mountId, uses:['logs','mail'] });
  assert.equal(Object.hasOwn(sent[0],'jobId'),false);
  assert.equal(Object.hasOwn(sent[0],'account'),false);
  assert.deepEqual(f.db.prepare('SELECT account_id,job_id FROM notification_outbox LIMIT 1').get(),
    Object.assign(Object.create(null), { account_id:null, job_id:null }));
});

test('withdrawn capacity subscription cannot send pending alerts, and backup restore cannot make old volume events replay', async t => {
  const f = fixture(t);
  let target = { ...f.target, subscriptions:{ capacity:true, sync:true } };
  const put = code => recordCapacityObservations(f.db, { observations:[{ mountId:'12345678901234567890', code, ok:!code, uses:['logs'] }] }, f.clock(), target);
  const sent = [];
  const worker = createDeliveryWorker(f.db, { destination:() => target, now:f.clock, deliver: async (_,body) => sent.push(body) });
  put('low_space');
  target = { ...target, subscriptions:{ capacity:false, sync:true } };
  await worker.tick();
  assert.equal(deliveryHistory(f.db).events[0].deliveryCode,'subscription_disabled');
  target = { ...target, subscriptions:{ capacity:true, sync:true } };
  put(null); f.advance(60_000); put(null); put('low_space');
  assert.equal(deliveryHistory(f.db).events[0].event,'capacity.low');
  f.db.transaction(() => suppressNotificationDeliveries(f.db,f.clock()))();
  put(null); f.advance(60_000); put(null);
  await worker.tick();
  assert.equal(deliveryHistory(f.db).events[0].deliveryCode,'data_restored');
  assert.equal(sent.length,0);
});

test('upgrading a sync-only outbox keeps durable IDs, pending rows and sequence high-water', t => {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...args) => {
    db.exec('BEGIN');
    try { const output = fn(...args); db.exec('COMMIT'); return output; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  };
  t.after(() => db.close());
  db.exec(`CREATE TABLE notification_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
    kind TEXT NOT NULL, destination TEXT NOT NULL, provider TEXT NOT NULL, incident_id TEXT NOT NULL,
    account_id INTEGER NOT NULL, job_id INTEGER NOT NULL, reason_code TEXT NOT NULL, occurred_at INTEGER NOT NULL, next_attempt_at INTEGER,
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_id TEXT, lease_until INTEGER, delivery_code TEXT, sent_at INTEGER,
    updated_at INTEGER NOT NULL, UNIQUE(generation,account_id,job_id,kind));
    CREATE INDEX idx_notification_deliverable ON notification_outbox(state,next_attempt_at,seq);
    INSERT INTO notification_outbox(seq,event_id,generation,kind,destination,provider,incident_id,account_id,job_id,reason_code,occurred_at,next_attempt_at,state,attempts,updated_at)
    VALUES(4,'old-id',0,'failure','a','webhook','incident',2,3,'auth_failed',100,120,'retrying',2,110),
      (5,'limited',0,'failure','a','webhook','incident',2,4,'auth_failed',101,121,'retrying',1,111);
    UPDATE notification_outbox SET delivery_code='http_429' WHERE event_id='limited';
    UPDATE sqlite_sequence SET seq=999 WHERE name='notification_outbox';`);
  migrateNotificationOutbox(db); migrateNotificationOutbox(db);
  assert.equal(db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('notification_outbox').seq,999);
  assert.deepEqual(deliveryHistory(db).events.map(event => [event.eventId,event.jobId,event.state,event.attempts]), [['limited',4,'retrying',1],['old-id',3,'uncertain',2]]);
  assert.equal(db.prepare('SELECT mount_id FROM notification_outbox WHERE event_id=?').get('old-id').mount_id,null);
});


test('unconfirmed Webhook results are marked for review, including timeout, HTTP 408 and HTTP 5xx', async t => {
  const f = fixture(t), sent = [];
  const codes = [null, 408, 500, 503];
  for (const [index] of codes.entries()) f.insert(index + 1, 'failure', index + 1);
  const deliver = async (_, body) => {
    sent.push(body.eventId);
    const httpStatus = codes[body.jobId - 1];
    throw httpStatus === null ? new Error('private timeout details') : Object.assign(new Error('private reply'), { httpStatus });
  };
  const worker = createDeliveryWorker(f.db, { destination:() => f.target, deliver, now:f.clock });
  await worker.tick(); await worker.tick();
  const events = deliveryHistory(f.db).events.sort((a,b) => a.jobId - b.jobId);
  assert.deepEqual(events.map(event => [event.state,event.deliveryCode]),
    [['uncertain','connection_error'],['uncertain','http_408'],['uncertain','http_500'],['uncertain','http_503']]);
  f.target.dedupEpoch = DEDUP;
  f.advance(60_000); await worker.tick();
  assert.equal(sent.length, 4, 'opt-in does not resurrect uncertain rows');
  assert(!JSON.stringify(events).includes('private'));
});

test('unconfirmed Webhook may retry explicit HTTP 429 and respects Retry-After', async t => {
  const f = fixture(t), sent = [];
  const eventId = f.insert(1);
  const worker = createDeliveryWorker(f.db, { destination:() => f.target, now:f.clock, jitter:() => .5,
    deliver:async (_, event) => {
      sent.push(event.eventId);
      if (sent.length === 1) throw Object.assign(new Error('rate limit'), { httpStatus:429, retryAfterMs:120_000 });
    } });
  await worker.tick();
  assert.equal(deliveryHistory(f.db).events[0].state, 'retrying');
  f.advance(119_999); await worker.tick();
  assert.deepEqual(sent, [eventId]);
  f.advance(1); await worker.tick();
  assert.deepEqual(sent, [eventId,eventId]);
  assert.equal(deliveryHistory(f.db).events[0].state, 'sent');
});

test('interrupted sends honor the original deduplication epoch when their delivery leases expire', async t => {
  const f = fixture(t), sent = [];
  let active = f.target;
  const claimAndLeave = async (eventId, epoch) => {
    let begun;
    const started = new Promise(resolve => { begun = resolve; });
    active = { ...f.target, dedupEpoch:epoch };
    const interrupted = createDeliveryWorker(f.db, { destination:() => active, now:f.clock,
      deliver:async (_, event) => { assert.equal(event.eventId, eventId); begun(); return new Promise(() => {}); } });
    void interrupted.tick();
    await started;
    interrupted.stop();
  };
  const resumed = createDeliveryWorker(f.db, { destination:() => active, now:f.clock, jitter:() => .5,
    deliver:async (_, event) => { sent.push(event.eventId); } });
  const unknown = f.insert(1, 'failure', 1);
  await claimAndLeave(unknown, null);
  active = null;
  f.advance(30_000); await resumed.tick();
  assert.equal(deliveryHistory(f.db).events[0].deliveryCode, 'lease_expired');
  assert.equal(deliveryHistory(f.db).events[0].state, 'uncertain');
  const confirmed = f.insert(2, 'failure', 2);
  await claimAndLeave(confirmed, DEDUP);
  f.advance(30_000); await resumed.tick();
  assert.equal(deliveryHistory(f.db).events.find(event => event.eventId === confirmed).state, 'retrying');
  assert.deepEqual(sent, []);
  f.advance(15_000); await resumed.tick();
  assert.deepEqual(sent, [confirmed]);
  const stale = f.insert(3, 'failure', 3);
  await claimAndLeave(stale, DEDUP);
  active = { ...f.target, dedupEpoch:RECONFIRMED };
  f.advance(30_000); await resumed.tick();
  assert.equal(deliveryHistory(f.db).events.find(event => event.eventId === stale).state, 'uncertain');
  assert.deepEqual(sent, [confirmed]);
});

test('a later 429 cannot erase an ambiguous delivery and a new endpoint or confirmation cannot retry it', async t => {
  const f = fixture(t), sent = [];
  let active = { ...f.target, dedupEpoch:DEDUP };
  const worker = createDeliveryWorker(f.db, { destination:() => active, now:f.clock, jitter:() => .5,
    deliver:async (_, event) => {
      sent.push(event.eventId);
      throw Object.assign(new Error('not available'), { httpStatus:sent.length === 2 ? 429 : 503 });
    } });
  const first = f.insert(1);
  await worker.tick(); f.advance(15_000); await worker.tick();
  assert.equal(deliveryHistory(f.db).events[0].deliveryCode, 'http_429');
  active = { ...active, dedupEpoch:RECONFIRMED };
  f.advance(30_000); await worker.tick();
  const second = f.insert(2, 'failure', 2);
  await worker.tick();
  active = { ...active, key:'next-destination' };
  f.advance(15_000); await worker.tick();
  assert.deepEqual(sent, [first,first,second]);
  assert.deepEqual(deliveryHistory(f.db).events.map(event => event.state), ['uncertain','uncertain']);
});

test('a late ambiguous result after revocation and an ambiguous retry at restore both remain for review', async t => {
  const f = fixture(t), sent = [];
  let active = { ...f.target, dedupEpoch:DEDUP }, entered, fail;
  const started = new Promise(resolve => { entered = resolve; });
  const inFlight = new Promise((_, reject) => { fail = reject; });
  const worker = createDeliveryWorker(f.db, { destination:() => active, now:f.clock, jitter:() => .5,
    deliver:async (_, event) => { sent.push(event.eventId); entered(); await inFlight; } });
  const first = f.insert(1);
  const pending = worker.tick(); await started;
  active = { ...f.target, dedupEpoch:RECONFIRMED };
  fail(Object.assign(new Error('unavailable'), {httpStatus:503})); await pending;
  assert.equal(deliveryHistory(f.db).events[0].state,'uncertain');
  const second = f.insert(2, 'failure', 2);
  await worker.tick();
  assert.equal(deliveryHistory(f.db).events.find(event => event.eventId === second).state,'retrying');
  f.db.transaction(() => suppressNotificationDeliveries(f.db,f.clock()))();
  f.advance(60_000); await worker.tick();
  assert.deepEqual(sent,[first,second]);
  const retained = deliveryHistory(f.db).events.find(event => event.eventId === second);
  assert.equal(retained.state,'uncertain');
  assert.equal(retained.deliveryCode,'data_restored');
});


for (const [engine, createDb] of [['node:sqlite', () => new DatabaseSync(':memory:')],
  ['better-sqlite3', () => new (require('better-sqlite3'))(':memory:')]]) {
  test(`Webhook startup migration is atomic on ${engine} and never queues old uncertain attempts`, t => {
    const db = createDb();
    t.after(() => db.close());
    migrateNotificationOutbox(db);
    db.exec(`ALTER TABLE notification_outbox DROP COLUMN attempt_dedup_epoch;
      ALTER TABLE notification_outbox DROP COLUMN may_have_delivered;
      INSERT INTO notification_outbox(event_id,generation,kind,destination,provider,incident_id,account_id,job_id,reason_code,
        occurred_at,next_attempt_at,state,attempts,delivery_code,updated_at) VALUES
        ('old-503',0,'failure','target','webhook','incident-a',1,1,'unknown',100,200,'retrying',1,'http_503',100),
        ('old-first-429',0,'failure','target','webhook','incident-b',2,2,'unknown',100,200,'retrying',1,'http_429',100),
        ('old-later-429',0,'failure','target','webhook','incident-c',3,3,'unknown',100,200,'retrying',2,'http_429',100);
      CREATE TRIGGER fail_notification_retry_migration BEFORE UPDATE ON notification_outbox
        WHEN OLD.event_id='old-later-429' BEGIN SELECT RAISE(ABORT,'notification migration test fault'); END;`);
    const columns = () => db.prepare('PRAGMA table_info(notification_outbox)').all().map(column => column.name);
    assert.throws(() => migrateNotificationOutbox(db), /notification migration test fault/);
    assert(!columns().includes('attempt_dedup_epoch'));
    assert(!columns().includes('may_have_delivered'));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notification_outbox WHERE state='retrying' AND next_attempt_at=200").get().count,3);
    db.exec('DROP TRIGGER fail_notification_retry_migration');
    migrateNotificationOutbox(db);
    migrateNotificationOutbox(db);
    assert.deepEqual(db.prepare(`SELECT event_id,state,next_attempt_at,attempt_dedup_epoch,may_have_delivered
      FROM notification_outbox ORDER BY seq`).all().map(row => Object.values(row)), [
      ['old-503','uncertain',null,null,1], ['old-first-429','retrying',200,null,0], ['old-later-429','uncertain',null,null,1],
    ]);
  });
}
