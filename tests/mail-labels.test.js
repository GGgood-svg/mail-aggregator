'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { createDatabase } = require('./fixtures/sync-test-db.cjs');
const { createMailRouter } = require('../server/mail-reader');
const { initializeMailTasks } = require('../server/mail-tasks');
const { settleSyncJob, markSyncTransferStarted } = require('../server/sync-settlement');
const { createLabel, addBindings, restoreMailLabels, MAX_LABELS, MAX_ASSIGNMENTS } = require('../server/mail-labels');
const { MAX_PENDING, takeNext } = require('../server/mail-auto-preview');
const { mailError } = require('../server/mail-tools');
const { restoreRules } = require('../server/restore');
const tick = () => new Promise(resolve => setImmediate(resolve));

function data() {
  const db = createDatabase();
  db.exec(`ALTER TABLE accounts ADD COLUMN local_user TEXT NOT NULL DEFAULT 'mailuser';
    ALTER TABLE accounts ADD COLUMN mailbox_folder TEXT;
    ALTER TABLE accounts ADD COLUMN destination_mode TEXT NOT NULL DEFAULT 'subfolder';
    CREATE TABLE admin_users(id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE mailbox_ownership(local_user TEXT,mailbox_folder TEXT,owner_user_id INTEGER,former_account_id INTEGER);
    INSERT INTO admin_users(id) VALUES(1),(2);
    INSERT INTO accounts(id,name,owner_user_id,mailbox_folder) VALUES(1,'A',1,'U1-A1'),(2,'B',1,'U1-A2'),(3,'C',2,'U2-A3');
    INSERT INTO mailbox_ownership VALUES('mailuser','U1-A1',1,1),('mailuser','U1-A2',1,2),('mailuser','U2-A3',2,3);`);
  return db;
}
const settle = (db, account, { status = 'success', started = true, resultKnown = true, record } = {}) => {
  const id = Number(db.prepare("INSERT INTO sync_jobs(account_id,started_at,status) VALUES(?,'fixture','running')").run(account).lastInsertRowid);
  if (started) markSyncTransferStarted(db, id, account, { pid: 1234, pidIdentity: 'fixture', logFile: 'fixture.log' });
  settleSyncJob(db, id, account, { status, resultKnown }, record);
  return id;
};
const pending = db => db.prepare('SELECT * FROM mail_auto_preview_pending ORDER BY account_id').all();
const addRule = (db, { id = 1, owner = 1, folder = null, floor = null } = {}) => db.prepare(`INSERT INTO mail_rules(id,owner_user_id,name,scope,folder,filters_json,action,auto_after_job_id)
  VALUES(?,?,'Auto test',?,?,?,'star',?)`).run(id, owner, folder ? 'folder' : 'all', folder, '{"subject":"fixture"}', floor);

async function fixture(t) {
  const db = data();
  let server, router, blocked = false, duringFetch;
  const views = [], boxes = {};
  for (const root of ['U1-A1','U1-A2','U2-A3','Legacy']) boxes[`${root}.INBOX`] = { validity: '77', uids: [3,2,1] };
  const deps = {
    taskDb: db, labelLocalUser: 'mailuser', automaticPreviewBlocked: () => blocked,
    mailAccessForRequest: req => ({ all: false, roots: req.user.id === 1 ? ['U1-A1','U1-A2','Legacy'] : ['U2-A3'] }),
    createClient() {
      let box, folder;
      const row = uid => ({ uid, envelope: { subject: `${folder} fixture ${uid}` }, flags: new Set(), internalDate: new Date('2026-01-01') });
      return { on() {}, async connect() {}, async logout() {}, close() {},
        async list() { return Object.keys(boxes).map(path => ({path,flags:new Set()})); },
        async mailboxOpen(path, mode) {
          assert.equal(mode.readOnly, true, 'previews and label writes must use read-only IMAP');
          folder = path; box = boxes[path]; views.push(path);
          return { uidValidity: box.validity, uidNext: 4, exists: box.uids.length };
        },
        async search(query) { const [low,high] = query.uid.split(':').map(Number); return box.uids.filter(uid => uid >= low && uid <= high); },
        async fetchAll(uids) { const hook = duringFetch; duringFetch = null; hook?.(folder); return box.uids.filter(uid => uids.includes(uid)).map(row); },
        async fetchOne(uid) { return box.uids.includes(uid) ? row(uid) : null; },
        async messageFlagsAdd() { assert.fail('unexpected IMAP write'); },
        async messageFlagsRemove() { assert.fail('unexpected IMAP write'); },
      };
    },
  };
  async function start() {
    router = createMailRouter(deps);
    const app = express(); app.use(express.json());
    app.use('/api/mail', (req,res,next) => {
      req.user = { id: Number(req.get('fixture-owner') || 1) }; req.sessionID = `s${req.user.id}`; next();
    }, router);
    server = app.listen(0,'127.0.0.1'); await once(server,'listening');
    void router.mailTasks;
  }
  async function stop() { await router.mailTasks.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await start();
  t.after(async () => { await stop(); db.close(); });
  async function request(path, method = 'GET', payload, owner = 1) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mail${path}`, { method,
      headers: { 'content-type': 'application/json', 'fixture-owner': String(owner) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }
  async function finish(id, owner = 1) {
    for (let count = 0; count < 4000; count++) {
      const task = router.mailTasks.get(owner,id);
      if (!['queued','running','cancelling'].includes(task.status)) return task;
      await tick();
    }
    assert.fail('Mail task did not settle');
  }
  return { db, boxes, views, request, finish, get service() { return router.mailTasks; }, async restart() { await stop(); await start(); },
    block(value) { blocked = value; }, onFetch(hook) { duringFetch = hook; } };
}
const folderA = 'U1-A1.INBOX', folderB = 'U1-A2.INBOX', folderC = 'U2-A3.INBOX';
const assignment = (folder = folderA, uidValidity = '77', assigned = true) => ({ folder, uidValidity, assigned });

test('label routes isolate users and account generations even when UIDs match', async t => {
  const f = await fixture(t), call = f.request;
  const label = await call('/labels','POST',{ name: '  Café  ' });
  assert.equal(label.status,201); assert.equal(label.body.name,'Café');
  const uri = `/labels/${label.body.id}`;
  assert.equal((await call('/labels','POST',{name:'CAFE\u0301'})).status,409);
  assert.deepEqual((await call('/labels','GET',undefined,2)).body.labels,[]);
  assert.equal((await call(uri,'DELETE',undefined,2)).status,404);
  assert.equal((await call(`${uri}/messages/2`,'PUT',assignment(folderC))).status,404);
  assert.equal((await call(`${uri}/messages/2`,'PUT',assignment('Legacy.INBOX'))).status,409);
  assert.equal((await call(`${uri}/messages/2`,'PUT',assignment(folderA,'78'))).status,409);
  assert.equal((await call(`${uri}/messages/4`,'PUT',assignment())).status,404);
  const selected = await call(`${uri}/messages/2`,'PUT',assignment());
  assert.equal(selected.status,200); assert.deepEqual(selected.body.labelIds,[label.body.id]);
  assert.deepEqual((await call(`/labels/messages/2?folder=${folderB}&uidValidity=77`)).body.labelIds,[]);
  assert.deepEqual((await call(`${uri}/messages/2`,'PUT',assignment(folderA,'77',false))).body.labelIds,[]);
  assert.equal((await call(uri,'PUT',{name:'Révision'})).body.name,'Révision');
  assert.equal((await call(`${uri}/messages/2`,'PUT',assignment())).status,200);
  const search = { continuation: true, folder: folderA, labelId: label.body.id, pageSize: 1 };
  const page = await call('/messages/search','POST',search);
  assert.equal(page.status,200); assert.deepEqual(page.body.messages.map(item => item.uid),[2]);
  const cursor = page.body.pageCursor; assert.ok(cursor);
  const otherLabel = (await call('/labels','POST',{name:'Other'})).body.id;
  assert.equal((await call('/messages/search','POST',{...search,labelId:otherLabel,cursor})).status,409);
  f.onFetch(() => f.db.exec('DELETE FROM mail_label_messages'));
  assert.deepEqual((await call('/messages/search','POST',search)).body.messages,[],'an association removed during IMAP fetch is no longer shown');
  assert.equal((await call(`${uri}/messages/2`,'PUT',assignment())).status,200);
  f.boxes[folderA].validity = '78';
  assert.deepEqual((await call('/messages/search','POST',search)).body.messages,[]);
  assert.equal((await call('/messages/search','POST',{...search,cursor})).status,409);
  f.db.exec("DELETE FROM accounts WHERE id=1; INSERT INTO accounts(id,name,mailbox_folder) VALUES(4,'New','U1-A1');");
  assert.equal((await call(`${uri}/messages/2`,'PUT',assignment(folderA,'78'))).status,409,'an old ownership row cannot bless a recreated account');
  assert.equal((await call(uri,'DELETE')).status,200);
});

test('label action is checked by owner and only manual application writes label bindings', async t => {
  const f = await fixture(t), call = f.request;
  const label = (await call('/labels','POST',{name:'Cases'})).body;
  const spec = { name: 'Triage',scope:'folder', folder:folderA,filters:{subject:'fixture'},action:'label',labelId:label.id };
  assert.equal((await call('/rules','POST',{...spec,folder:folderC},2)).status,404);
  const created = await call('/rules','POST',spec); assert.equal(created.status,201);
  assert.equal(created.body.autoPreviewEnabled,false);
  const rule = `/rules/${created.body.id}`;
  assert.equal((await call(`/labels/${label.id}`,'DELETE')).status,409);
  const preview = await call(`${rule}/previews`,'POST'); assert.equal(preview.status,202);
  assert.equal((await f.finish(preview.body.id)).status,'completed');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mail_label_messages').get().n,0);
  const application = await call(`${rule}/previews/${preview.body.id}/apply`,'POST'); assert.equal(application.status,202);
  assert.equal((await f.finish(application.body.id)).updated,3);
  assert.deepEqual(f.db.prepare('SELECT account_id,uid FROM mail_label_messages ORDER BY uid').all().map(({account_id,uid})=>[account_id,uid]), [[1,1],[1,2],[1,3]]);
  assert.ok(f.views.length > 0 && f.views.every(folder => folder === folderA));
});

test('label migrations preserve existing rule IDs and restore definitions without restoring bindings or opt-in', () => {
  const source = data(), live = data();
  try {
    live.exec(`CREATE TABLE mail_rules(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_user_id INTEGER NOT NULL REFERENCES admin_users(id),
      name TEXT NOT NULL,scope TEXT NOT NULL,folder TEXT,filters_json TEXT NOT NULL,action TEXT CHECK(action IN ('seen','unseen','star','unstar')),
      revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO mail_rules(id,owner_user_id,name,scope,folder,filters_json,action,revision) VALUES(17,2,'Legacy','folder','U2-A3.INBOX','{}','seen',4);`);
    initializeMailTasks(source); initializeMailTasks(live); initializeMailTasks(live);
    assert.equal(live.prepare('SELECT revision FROM mail_rules WHERE id=17').get().revision,4);
    const old = createLabel(source,1,'Client'), current = createLabel(live,2,'client');
    createLabel(source,2,'Unmapped'); createLabel(live,1,'Private');
    addBindings(source,old.id,1,1,folderA,'77',[2]); addBindings(live,current.id,2,3,folderC,'77',[2]);
    source.prepare("INSERT INTO mail_rules(owner_user_id,name,scope,folder,filters_json,action,label_id,auto_after_job_id) VALUES(1,'Label rule','all',NULL,'{\"subject\":\"fixture\"}','label',?,0)").run(old.id);
    const owners = new Map([[1,2]]), definitions = restoreMailLabels(live,source,owners);
    assert.equal(definitions.ids.get(old.id),current.id);
    assert.equal(definitions.summary.labelsSkipped,1);
    assert.equal(live.prepare('SELECT COUNT(*) n FROM mail_label_messages').get().n,0);
    assert.equal(restoreRules(live,source,owners,definitions.ids).rules,1);
    const repaired = live.prepare("SELECT * FROM mail_rules WHERE name='Label rule'").get();
    assert.equal(repaired.label_id,current.id); assert.equal(repaired.auto_after_job_id,null);
    for (let i=1;i<MAX_LABELS;i++) createLabel(live,1,`Label ${i}`);
    assert.throws(()=>createLabel(live,1,'Too many'),{statusCode:409});
    const more = createLabel(live,2,'More');
    live.prepare(`WITH RECURSIVE ids(uid) AS (SELECT 1 UNION ALL SELECT uid+1 FROM ids WHERE uid<?)
      INSERT INTO mail_label_messages SELECT ?,2,3,?,'77',uid FROM ids`).run(MAX_ASSIGNMENTS,more.id,folderC);
    assert.equal(addBindings(live,more.id,2,3,folderC,'77',[2]),0);
    assert.throws(()=>live.transaction(()=>addBindings(live,more.id,2,3,folderC,'77',[MAX_ASSIGNMENTS+1]))(),{statusCode:409});
    assert.equal(live.prepare('SELECT COUNT(*) n FROM mail_label_messages').get().n,MAX_ASSIGNMENTS);
  } finally { source.close(); live.close(); }
});

test('auto trigger uses committed, started and known successes; coalesces and bounds account work', () => {
  const db = data();
  try {
    settle(db,1); initializeMailTasks(db);
    assert.equal(pending(db).length,0,'initialization does not replay historical jobs');
    settle(db,1); assert.equal(pending(db).length,0,'default is off');
    addRule(db,{floor:0});
    settle(db,1,{status:'failed'}); settle(db,1,{started:false}); settle(db,1,{resultKnown:false});
    assert.equal(pending(db).length,0);
    assert.throws(()=>settle(db,1,{record() { throw new Error('fixture atomic failure'); }}),/atomic/);
    assert.equal(pending(db).length,0,'sync rollbacks also roll back preview intent');
    db.exec("UPDATE sync_jobs SET status='interrupted' WHERE status='running'");
    const first = settle(db,1), latest = settle(db,1); settle(db,2);
    assert.ok(latest > first); assert.deepEqual(pending(db).map(row=>row.account_id),[1,2]);
    assert.equal(pending(db)[0].job_id,latest);
    assert.equal(settleSyncJob(db,latest,1,{status:'success'}).applied,false);
    assert.equal(pending(db).length,2);
    for (let i=4;i<4+MAX_PENDING;i++) {
      db.prepare('INSERT INTO accounts(id,name,mailbox_folder) VALUES(?,?,?)').run(i,`A${i}`,`U1-A${i}`);
      db.prepare("INSERT INTO mailbox_ownership VALUES('mailuser',?,1,?)").run(`U1-A${i}`,i);
      settle(db,i);
    }
    assert.equal(pending(db).length,MAX_PENDING);
    assert.equal(pending(db)[0].job_id,latest,'an already pending account is not evicted');
    assert.equal(pending(db)[0].job_id < settle(db,1),true,'existing account can still coalesce while saturated');
  } finally { db.close(); }
});

test('automatic queue defers a busy owner and processes another account without losing the first result', () => {
  const db = data();
  try {
    initializeMailTasks(db); addRule(db,{floor:0});
    const first = settle(db,1), second = settle(db,2), check = Date.now();
    const take = (timestamp, create) => db.transaction(() => takeNext(db,timestamp,'mailuser',create))();
    take(check, (_rule, source) => { assert.equal(source.jobId,first); throw mailError('busy',429); });
    take(check, (_rule, source) => assert.equal(source.jobId,second));
    take(check, () => assert.fail('the first account is still deferred'));
    assert.deepEqual(pending(db).map(row=>row.job_id),[first]);
    take(check+15_000, (_rule, source) => assert.equal(source.jobId,first));
    take(check+15_000, () => assert.fail('a job/rule pair is not replayed'));
    assert.equal(pending(db).length,0);
  } finally { db.close(); }
});

test('opted-in sync starts a durable account-scoped read-only preview; revocation blocks later use', async t => {
  const f = await fixture(t), {db,request:call}=f;
  const spec = { name:'Automatic', scope:'all', filters:{subject:'fixture'}, action:'star', autoPreviewEnabled:true };
  const existing = settle(db,1);
  const ask = await call('/rules','POST',spec); assert.equal(ask.status,201); assert.equal(ask.body.autoPreviewEnabled,true);
  assert.equal(db.prepare('SELECT auto_after_job_id FROM mail_rules WHERE id=?').get(ask.body.id).auto_after_job_id,existing);
  settle(db,3); assert.equal(pending(db).length,0);
  settle(db,1);
  f.block(true); f.service.pollAutomatic(); assert.equal(f.service.list(1).items.length,0);
  f.block(false); f.service.pollAutomatic(); const started = f.service.list(1).items[0]; assert.equal(started.automatic,true);
  await f.restart(); f.service.pollAutomatic();
  const done = await f.finish(started.id); assert.equal(done.status,'completed'); assert.equal(done.matched,3);
  assert.ok(f.views.every(folder => folder===folderA));
  f.service.pollAutomatic(); assert.equal(pending(db).length,0); assert.equal(f.service.list(1).items.length,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM mail_tasks WHERE kind='rule_apply'").get().n,0);
  const uri=`/rules/${ask.body.id}/previews/${done.id}`;
  assert.equal((await call(uri,'GET',undefined,2)).status,404);
  db.exec("UPDATE mailbox_ownership SET former_account_id=99 WHERE mailbox_folder='U1-A1'");
  assert.equal((await call(`${uri}/apply`,'POST')).status,409);
  settle(db,1); assert.equal(pending(db).length,0);
  const active = settle(db,2); assert.ok(active > existing);
  f.onFetch(() => db.exec('UPDATE mail_rules SET auto_after_job_id=NULL'));
  f.service.pollAutomatic();
  const task = db.prepare("SELECT id FROM mail_tasks WHERE id<>? AND automatic=1").get(done.id);
  assert.equal((await f.finish(task.id)).status,'interrupted');
  assert.equal((await call(`/tasks/${task.id}/resume`,'POST')).status,409,'revoked automatic job cannot impersonate a session on resume');
});
