'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createMailTaskService, initializeMailTasks } = require('../server/mail-tasks');
const { newestUids, scanNewestUids } = require('../server/mail-search-uids');
const { normalizeRule } = require('../server/mail-rules');
const { mailError } = require('../server/mail-tools');
const tick = () => new Promise(resolve => setImmediate(resolve));
const msg = uid => ({ uid, flags: new Set() });
function fixture(t, count = 10, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...args) => { db.exec('BEGIN'); try { const value = fn(...args); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE admin_users(id INTEGER PRIMARY KEY);');
  for (let id = 1; id <= 20; id++) db.prepare('INSERT INTO admin_users VALUES(?)').run(id);
  initializeMailTasks(db);
  const boxes = { A: { validity: '77', next: count + 1, messages: Array.from({ length: count }, (_, i) => msg(i + 1)) } };
  const writes = [], searches = [], fetched = [], visits = [], indexes = new WeakMap();
  let currentTime = Date.now(), monotonic = 0, revoked = false, denied = null;
  const dependencies = { db, now: () => currentTime, monotonicNow: () => monotonic, newestUids, scanNewestUids,
    authorize(context, folder) { if (revoked || !context?.user?.id) throw mailError('revoked', 401); if (folder === denied) throw mailError('denied', 404); },
    async listFolders() { return Object.keys(boxes); },
    async withFolder(context, folder, readOnly, signal, work, timeoutMs) {
      const visit = { folder, readOnly, timeoutMs, searches: 0 };
      visits.push(visit);
      await options.onOpen?.(folder, context, signal);
      const box = boxes[folder]; if (!box) throw mailError('missing', 404);
      const check = () => { if (signal.aborted) throw signal.reason; dependencies.authorize(context, folder); };
      if (options.fast && !indexes.has(box)) indexes.set(box, new Map(box.messages.map(message => [message.uid, message])));
      const find = uids => options.fast ? uids.map(uid => indexes.get(box).get(uid)).filter(Boolean) : box.messages.filter(message => uids.includes(message.uid));
      const mailbox = { path: folder, uidValidity: box.validity, uidNext: box.next, exists: box.messages.length };
      const client = {
        mailbox, capabilities: new Set(options.esearch ? ['ESEARCH'] : []),
        async search(query, config) {
          searches.push(query); visit.searches++;
          await options.onSearch?.(folder, visit, client, service);
          if (options.failSearch?.(folder)) throw Error('fixture search failure');
          const [low, high] = query.uid.split(':').map(Number);
          const matches = box.messages.filter(message => message.uid >= low && message.uid <= high && (query.seen === undefined || message.flags.has('\\Seen') === query.seen) && (query.flagged === undefined || message.flags.has('\\Flagged') === query.flagged)).map(message => message.uid);
          if (config.returnOptions?.includes('MAX')) return { max: matches.at(-1) };
          return matches;
        },
        async fetchAll(uids, fields) { fetched.push([...uids]); await options.onFetch?.(folder, uids, service, fields); return find(uids); },
        async messageFlagsAdd(uids, flags) { assert.equal(readOnly, false); writes.push({ folder, uids: [...uids], flags, add: true }); find(uids).forEach(m => flags.forEach(flag => m.flags.add(flag))); await options.onWrite?.(folder, uids, service); return true; },
        async messageFlagsRemove(uids, flags) { assert.equal(readOnly, false); writes.push({ folder, uids: [...uids], flags, add: false }); find(uids).forEach(m => flags.forEach(flag => m.flags.delete(flag))); await options.onWrite?.(folder, uids, service); return true; },
      };
      return work(client, mailbox, check);
    },
  };
  let service = createMailTaskService(dependencies);
  t.after(async () => { await service.close(); db.close(); });
  const context = (id = 1) => ({ user: { id }, sessionID: 'PRIVATE-SID-DO-NOT-PERSIST', session: { userId: id, sessionVersion: 0 } });
  async function finish(id, owner = 1) {
    for (let tries = 0; tries < 20000; tries++) { const task = service.get(owner, id); if (!['queued', 'running', 'cancelling'].includes(task.status)) return task; await tick(); }
    throw Error('Task did not settle');
  }
  function rule(action = 'star', scope = 'all') {
    const info = db.prepare('INSERT INTO mail_rules(owner_user_id,name,scope,folder,filters_json,action) VALUES(1,?,?,?,?,?)')
      .run('Fixture', scope, scope === 'folder' ? 'A' : null, JSON.stringify({ seen: 'unread' }), action);
    return db.prepare('SELECT * FROM mail_rules WHERE id=?').get(info.lastInsertRowid);
  }
  return { db, boxes, writes, searches, fetched, visits, context, finish, rule,
    get service() { return service; }, async restart() { await service.close(); service = createMailTaskService(dependencies); },
    revoke() { revoked = true; }, deny(folder) { denied = folder; }, advance(ms) { currentTime += ms; },
    advanceMonotonic(ms) { monotonic += ms; } };
}

test('seen tasks stream beyond 50000 mail, freeze every folder, isolate owners and persist no session credentials', async t => {
  const f = fixture(t, 50005, { onWrite(folder) {
    if (folder === 'A' && !f.boxes.B.messages.some(m => m.uid === 2)) { f.boxes.B.messages.push(msg(2)); f.boxes.B.next = 3; }
  } });
  f.boxes.B = { validity: '88', next: 2, messages: [msg(1)] };
  const task = f.service.createSeen(1, ['A', 'B'], f.context());
  assert.throws(() => f.service.get(2, task.id), { statusCode: 404 });
  assert.throws(() => f.service.createSeen(1, ['A'], f.context()), { statusCode: 429 });
  const result = await f.finish(task.id);
  assert.equal(result.status, 'completed'); assert.equal(result.updated, 50006);
  assert.equal(f.boxes.B.messages[1].flags.has('\\Seen'), false, 'new arrivals must remain outside the frozen boundary');
  assert.ok(f.writes.every(write => write.uids.length <= 200));
  assert.ok(f.searches.every(query => query.uid !== '1:*'));
  const persisted = JSON.stringify(f.db.prepare('SELECT * FROM mail_tasks').all());
  assert.doesNotMatch(persisted, /PRIVATE-SID|sessionVersion|sessionID/);
});

for (const window of ['before-command', 'after-command', 'before-checkpoint']) {
  test(`cancellation ${window} reconciles pending flags and never counts confirmation twice`, async t => {
    let cancelled = false, id, calls = 0;
    const cancel = service => { if (!cancelled) { cancelled = true; service.cancel(1, id); } };
    const f = fixture(t, 3, { onWrite(_, __, service) { if (window === 'after-command') cancel(service); },
      onFetch(_, __, service) { calls++; if (window === 'before-command' && calls === 1 || window === 'before-checkpoint' && calls === 2) cancel(service); } });
    id = f.service.createSeen(1, ['A'], f.context()).id;
    const result = await f.finish(id); assert.equal(result.status, 'cancelled'); assert.equal(result.updated, 0); assert.equal(result.uncertain, 3);
    const writesBefore = f.writes.length;
    await f.service.resume(1, id, f.context());
    const resumed = await f.finish(id); assert.equal(resumed.status, 'completed'); assert.equal(resumed.updated, 3); assert.equal(resumed.uncertain, 0);
    assert.equal(f.writes.length, window === 'before-command' ? writesBefore + 1 : writesBefore, 'already submitted flags are read before any repeated command');
  });
}

test('restart interrupts queued/running tasks; manual resume rechecks UIDVALIDITY and directory authorization', async t => {
  let id, cancelled = false;
  const f = fixture(t, 4, { onWrite(_, __, service) { if (!cancelled) { cancelled = true; service.cancel(1, id); } } });
  id = f.service.createSeen(1, ['A'], f.context()).id; await f.finish(id);
  f.db.prepare("UPDATE mail_tasks SET status='running' WHERE id=?").run(id);
  await f.restart(); assert.equal(f.service.get(1, id).status, 'interrupted'); assert.equal(f.writes.length, 1);
  await tick(); assert.equal(f.service.get(1, id).updated, 0, 'restart must not automatically recover authorization');
  f.boxes.A.validity = '99';
  assert.equal((await f.service.resume(1, id, f.context())).status, 'queued');
  assert.equal((await f.finish(id)).status, 'interrupted');
  assert.equal(f.service.get(1, id).resumable, false); assert.equal(f.writes.length, 1);
});

test('revoked session or directory permission stops after the submitted batch and before the next write', async t => {
  for (const kind of ['session', 'folder']) {
    const f = fixture(t, 450, { onWrite() { if (kind === 'session') f.revoke(); else f.deny('A'); } });
    const id = f.service.createSeen(1, ['A'], f.context()).id;
    const result = await f.finish(id); assert.equal(result.status, 'interrupted'); assert.equal(result.updated, 0);
    assert.equal(result.uncertain, 200); assert.equal(f.writes.length, 1);
    if (kind === 'session') await assert.rejects(f.service.resume(1, id, f.context()), { statusCode: 401 });
    else {
      assert.equal((await f.service.resume(1, id, f.context())).status, 'queued');
      assert.equal((await f.finish(id)).status, 'interrupted');
    }
    assert.equal(f.writes.length, 1);
  }
});

test('resume reserves its slot immediately and cancellation during its scope check prevents all writes', async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const checking = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, 1, { async onOpen() { entered(); await blocked; } });
  f.db.prepare(`INSERT INTO mail_tasks(id,owner_user_id,kind,status,action,spec_json,boundary_ready,resumable,created_at)
    VALUES('interrupted',1,'seen_all','interrupted','seen','{}',1,1,?)`).run(Date.now() - 100);
  f.db.exec(`INSERT INTO mail_task_folders(task_id,folder,ordinal,uid_validity,upper_uid,before_uid)
    VALUES('interrupted','A',0,'77',1,2)`);
  try {
    const queued = await f.service.resume(1, 'interrupted', f.context());
    assert.equal(queued.phase, 'queued');
    assert.ok(Date.parse(queued.updatedAt) >= Date.parse(queued.createdAt));
    await checking;
    assert.equal(f.service.get(1, 'interrupted').phase, 'checking_scope');
    await assert.rejects(f.service.resume(1, 'interrupted', f.context()), { statusCode: 429 });
    assert.equal(f.service.cancel(1, 'interrupted').status, 'cancelling');
    assert.throws(() => f.service.createSeen(1, ['A'], f.context()), { statusCode: 429 });
  } finally { release(); }
  const outcome = await f.finish('interrupted');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.phase, null);
  assert.equal(f.writes.length, 0);
});

test('complete rule preview scans all folders and application freezes exact UIDs and is idempotent', async t => {
  const f = fixture(t, 3), rule = f.rule();
  for (let i = 0; i < 10; i++) f.boxes[`B${i}`] = { validity: String(80 + i), next: 2, messages: [msg(1)] };
  const preview = f.service.createPreview(1, rule, f.context());
  const ready = await f.finish(preview.id);
  assert.equal(ready.status, 'completed'); assert.equal(ready.totalFolders, 11); assert.equal(ready.matched, 13); assert.equal(f.writes.length, 0);
  f.boxes.A.messages.push(msg(4)); f.boxes.A.next++;
  const applied = f.service.applyPreview(1, rule, preview.id, f.context());
  assert.equal(f.service.applyPreview(1, rule, preview.id, f.context()).id, applied.id);
  const result = await f.finish(applied.id);
  assert.equal(result.updated, 13); assert.equal(result.status, 'completed'); assert.equal(f.boxes.A.messages.at(-1).flags.has('\\Flagged'), false);
  assert.equal(f.service.applyPreview(1, rule, preview.id, f.context()).id, applied.id);
});

test('preview limits, incomplete directories, expiry, rule editing and UID rebuild prohibit application', async t => {
  for (const reason of ['folders', 'matches', 'partial', 'expired', 'edited', 'rebuild']) {
    const f = fixture(t, reason === 'matches' ? 50001 : 3, { failSearch: folder => reason === 'partial' && folder === 'A' });
    const rule = f.rule();
    if (reason === 'rebuild') f.boxes.B = { validity: '88', next: 2, messages: [msg(1)] };
    if (reason === 'folders') for (let i = 0; i < 500; i++) f.boxes[`B${i}`] = { validity: '88', next: 1, messages: [] };
    const preview = f.service.createPreview(1, rule, f.context()); const ready = await f.finish(preview.id);
    if (reason === 'expired') f.advance(600001);
    if (reason === 'edited') { rule.revision++; f.service.invalidateRule(1, rule.id); }
    if (reason === 'rebuild') {
      f.boxes.B.validity = '99'; const applied = f.service.applyPreview(1, rule, preview.id, f.context());
      assert.equal((await f.finish(applied.id)).status, 'interrupted');
    } else assert.throws(() => f.service.applyPreview(1, rule, preview.id, f.context()), { statusCode: 409 });
    assert.equal(f.writes.length, 0, reason);
    if (reason === 'partial') assert.equal(ready.status, 'partial');
  }
});

test('rules validate one whitelisted action and reuse strict search normalization', () => {
  const value = { name: 'test', scope: 'folder', folder: 'A', filters: { seen: 'unread' }, action: 'unseen' };
  assert.equal(normalizeRule(value).action, 'unseen');
  for (const action of ['delete', 'move', '__proto__', null]) assert.throws(() => normalizeRule({ ...value, action }));
  assert.throws(() => normalizeRule({ ...value, filters: { injected: 'x' } }));
});

test('task admission allows two running and eight waiting, with one active task per owner', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, 3, { onOpen: () => gate });
  const ids = [];
  try {
    for (let owner = 1; owner <= 10; owner++) ids.push(f.service.createSeen(owner, ['A'], f.context(owner)).id);
    assert.throws(() => f.service.createSeen(11, ['A'], f.context(11)), { statusCode: 429 });
    assert.throws(() => f.service.createSeen(1, ['A'], f.context()), { statusCode: 429 });
    await tick();
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mail_tasks WHERE status='running'").get().n, 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mail_tasks WHERE status='queued'").get().n, 8);
    const queued = f.db.prepare("SELECT id,owner_user_id FROM mail_tasks WHERE status='queued' LIMIT 1").get();
    f.service.cancel(queued.owner_user_id, queued.id);
    assert.equal(f.service.get(queued.owner_user_id, queued.id).status, 'cancelled'); assert.equal(f.service.get(queued.owner_user_id, queued.id).resumable, false);
    release(); await Promise.all(ids.map((id, index) => f.finish(id, index + 1)));
  } finally { release(); }
});

test('partial confirmation survives a restart and resumes only the unconfirmed subset', async t => {
  let once = true;
  const f = fixture(t, 450, { onWrite(_, uids) { if (once) { once = false; f.boxes.A.messages.find(item => item.uid === uids[0]).flags.delete('\\Seen'); } } });
  const id = f.service.createSeen(1, ['A'], f.context()).id;
  const partial = await f.finish(id); assert.equal(partial.status, 'partial'); assert.equal(partial.updated, 199); assert.equal(partial.uncertain, 1);
  await f.restart(); await f.service.resume(1, id, f.context());
  const result = await f.finish(id); assert.equal(result.updated, 450); assert.equal(result.status, 'completed'); assert.equal(result.uncertain, 0);
  assert.equal(f.writes[1].uids.length, 1);
});

test('each rule action applies only its captured flag intent', async t => {
  for (const action of ['seen','unseen','star','unstar']) {
    const f = fixture(t, 3), rule = f.rule(action, 'folder');
    rule.filters_json = '{}'; f.db.prepare("UPDATE mail_rules SET filters_json='{}' WHERE id=?").run(rule.id);
    if (['unseen','unstar'].includes(action)) f.boxes.A.messages.forEach(item => item.flags.add(action === 'unseen' ? '\\Seen' : '\\Flagged'));
    const preview = f.service.createPreview(1, rule, f.context()); assert.equal((await f.finish(preview.id)).matched, 3);
    const apply = f.service.applyPreview(1, rule, preview.id, f.context()); assert.equal((await f.finish(apply.id)).updated, 3);
    const flag = ['seen','unseen'].includes(action) ? '\\Seen' : '\\Flagged';
    assert.ok(f.boxes.A.messages.every(item => item.flags.has(flag) === ['seen','star'].includes(action)));
  }
});

test('retention prunes ended history by owner and age while preserving active tasks', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, 3, { onOpen: () => gate });
  try {
    const active = f.service.createSeen(1, ['A'], f.context()); await tick();
    const add = f.db.prepare("INSERT INTO mail_tasks(id,owner_user_id,kind,status,spec_json,created_at) VALUES(?,?,'seen_all','completed','{}',?)");
    for (let i = 0; i < 105; i++) add.run(`ended-${i}`, 1, Date.now() - i);
    add.run('old', 1, Date.now() - 8 * 86400000); add.run('other-owner', 2, Date.now() - 8 * 86400000);
    assert.equal(f.service.list(1).pagination.total, 101); assert.equal(f.service.get(1, active.id).status, 'running');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mail_tasks WHERE id='old'").get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mail_tasks WHERE id='other-owner'").get().n, 1);
    release(); await f.finish(active.id);
  } finally { release(); }
});

test('invalidating a preview retains its admission slots and history until the cancelled work ends', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, 3, { onOpen: () => gate }), rule = f.rule();
  try {
    const preview = f.service.createPreview(1, rule, f.context()); await tick();
    f.service.invalidateRule(1, rule.id);
    assert.throws(() => f.service.createSeen(1, ['A'], f.context()), { statusCode: 429 });
    for (let owner = 2; owner <= 10; owner++) f.service.createSeen(owner, ['A'], f.context(owner));
    assert.throws(() => f.service.createSeen(11, ['A'], f.context(11)), { statusCode: 429 });
    const add = f.db.prepare("INSERT INTO mail_tasks(id,owner_user_id,kind,status,spec_json,created_at) VALUES(?,1,'seen_all','completed','{}',?)");
    for (let i = 0; i < 105; i++) add.run(`ended-${i}`, Date.now() + i + 1000);
    f.service.list(1);
    assert.equal(f.service.get(1, preview.id).status, 'invalidated', 'retention must keep work that has not actually exited');
    release(); await f.service.interruptAll();
    assert.equal(f.service.get(1, preview.id).status, 'invalidated');
    const next = f.service.createSeen(1, ['A'], f.context()); assert.equal((await f.finish(next.id)).status, 'completed');
  } finally { release(); }
});


test('a temporary directory-open failure preserves the frozen scope across restart and resumes only the missing boundary', async t => {
  let unavailable = true;
  const f = fixture(t, 3, { onOpen(folder) { if (folder === 'B' && unavailable) throw mailError('fixture timeout', 504); } });
  f.boxes.B = { validity: '88', next: 2, messages: [msg(1)] };
  f.boxes.C = { validity: '99', next: 2, messages: [msg(1)] };
  const rule = f.rule();
  const preview = f.service.createPreview(1, rule, f.context());
  const partial = await f.finish(preview.id);
  assert.equal(partial.status, 'partial'); assert.equal(partial.resumable, true);
  assert.deepEqual(partial.results.map(item => [item.folder, item.status, item.upperUid]),
    [['A', 'pending', 3], ['B', 'failed', null], ['C', 'pending', 1]]);
  assert.equal(f.searches.length, 0, 'never scan against a partially frozen scope');
  assert.throws(() => f.service.applyPreview(1, rule, preview.id, f.context()), { statusCode: 409 });
  for (const name of ['A', 'C']) { f.boxes[name].messages.push(msg(10)); f.boxes[name].next = 11; }
  f.boxes.D = { validity: '100', next: 2, messages: [msg(1)] };
  unavailable = false;
  await f.restart();
  assert.equal(f.service.get(1, preview.id).resumable, true);
  f.visits.length = 0;
  await f.service.resume(1, preview.id, f.context());
  const result = await f.finish(preview.id);
  assert.equal(result.status, 'completed'); assert.equal(result.matched, 5);
  assert.deepEqual(f.visits.map(visit => [visit.folder, visit.searches]),
    [['B', 0], ['A', 1], ['B', 1], ['C', 1], ['A', 0], ['B', 0], ['C', 0]],
    'only B is frozen again; all three are independently checked before application');
  const apply = await f.finish(f.service.applyPreview(1, rule, preview.id, f.context()).id);
  assert.equal(apply.updated, 5);
  assert.deepEqual(f.writes.map(write => [write.folder, write.uids]), [['A', [3, 2, 1]], ['B', [1]], ['C', [1]]]);
});

test('sparse rule checkpoints survive a failed second scan and restart; apply reads only completed frozen blocks', async t => {
  let fail = true;
  let searchesA = 0;
  const f = fixture(t, 0, { esearch: true, failSearch(folder) { return folder === 'A' && fail && ++searchesA > 128; } });
  const originals = Array.from({ length: 65 }, (_, i) => (i + 1) * 5000);
  f.boxes.A.messages = originals.map(msg);
  f.boxes.A.next = 325001;
  f.boxes.B = { validity: '88', next: 2, messages: [msg(1)] };
  const rule = f.rule();
  const preview = f.service.createPreview(1, rule, f.context());
  const partial = await f.finish(preview.id);
  assert.equal(partial.status, 'partial'); assert.equal(partial.resumable, true); assert.equal(partial.matched, 65);
  assert.deepEqual(f.visits.filter(visit => visit.folder === 'A').map(visit => visit.searches), [0, 129],
    'the first request of batch 2 failed on the same selected mailbox');
  assert.throws(() => f.service.applyPreview(1, rule, preview.id, f.context()), { statusCode: 409 });
  const old = f.db.prepare('SELECT before_uid,uids_json,matched_count FROM mail_task_folders WHERE task_id=? AND folder=?').get(preview.id, 'A');
  assert.equal(old.matched_count, 64); assert.equal(old.uids_json, '[]'); assert.ok(old.before_uid < 325001);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mail_task_uid_blocks WHERE task_id=? AND folder=?').get(preview.id, 'A').n, 1);
  f.boxes.A.messages.push(msg(330000)); f.boxes.A.next = 330001;
  fail = false; await f.restart();
  assert.equal((await f.service.resume(1, preview.id, f.context())).status, 'queued');
  const complete = await f.finish(preview.id);
  assert.equal(complete.status, 'completed'); assert.equal(complete.matched, 66);
  assert.equal(f.db.prepare('SELECT status FROM mail_tasks WHERE id=?').get(preview.id).status, 'snapshot_ready');
  const snapshot = f.db.prepare('SELECT uids_json FROM mail_task_uid_blocks WHERE task_id=? AND folder=? ORDER BY position').all(preview.id, 'A').flatMap(block => JSON.parse(block.uids_json));
  assert.deepEqual(snapshot, [...originals].reverse());
  const result = await f.finish(f.service.applyPreview(1, rule, preview.id, f.context()).id);
  assert.equal(result.updated, 66);
  assert.deepEqual(f.writes.filter(write => write.folder === 'A').flatMap(write => write.uids), [...originals].reverse());
  assert.ok(!f.boxes.A.messages.at(-1).flags.has('\\Flagged'));
});


test('large previews persist bounded UID blocks and apply exact 5k, 25k and 50k sets', async t => {
  for (const n of [5000, 25000, 50000]) {
    await t.test(`${n} matches`, async t => {
      const f = fixture(t, n, { fast: true });
      const rule = f.rule('star', 'folder');
      const preview = f.service.createPreview(1, rule, f.context());
      assert.equal((await f.finish(preview.id)).matched, n);
      const blocks = f.db.prepare('SELECT position,uids_json FROM mail_task_uid_blocks WHERE task_id=? ORDER BY position').all(preview.id);
      assert.equal(blocks.length, Math.ceil(n / 200));
      assert.equal(f.visits.length, 2 + Math.ceil(blocks.length / 4),
        'at most four scan batches per opening, plus independent initial and final checks');
      assert.equal(f.visits[0].searches, 0); assert.equal(f.visits.at(-1).searches, 0);
      assert.ok(f.visits.slice(1, -1).every(visit => visit.readOnly && visit.timeoutMs === 45_000 && visit.searches <= 4));
      for (const [i, block] of blocks.entries()) {
        const ids = JSON.parse(block.uids_json);
        assert.equal(block.position, i * 200); assert.ok(ids.length <= 200);
        assert.equal(ids[0], n - i * 200);
      }
      const applied = await f.finish(f.service.applyPreview(1, rule, preview.id, f.context()).id);
      assert.equal(applied.status, 'completed'); assert.equal(applied.updated, n);
      assert.deepEqual(f.writes.flatMap(write => write.uids), Array.from({ length: n }, (_, i) => n - i));
    });
  }
});


test('preview rotates at the soft deadline and independently verifies the completed folder', async t => {
  const f = fixture(t, 701, { onSearch() { f.advanceMonotonic(125); } });
  const rule = f.rule('star', 'folder');
  const preview = f.service.createPreview(1, rule, f.context());
  const result = await f.finish(preview.id);
  assert.equal(result.status, 'completed'); assert.equal(result.matched, 701);
  assert.deepEqual(f.visits.map(visit => visit.searches), [0, 2, 2, 0]);
});

test('a reused preview connection rechecks cancellation, folder access and live mailbox identity', async t => {
  for (const mode of ['cancel', 'revoke', 'UIDVALIDITY', 'reselect']) await t.test(mode, async t => {
    let preview;
    const f = fixture(t, 450, {
      onFetch() { if (mode === 'revoke') setImmediate(() => f.deny('A')); },
      onSearch(_, visit, client) {
        if (visit.searches !== 2) return;
        if (mode === 'cancel') f.service.cancel(1, preview.id);
        if (mode === 'UIDVALIDITY') client.mailbox = { ...client.mailbox, uidValidity: '99' };
        if (mode === 'reselect') client.mailbox = { ...client.mailbox, path: 'B' };
      },
    });
    const rule = f.rule('star', 'folder');
    preview = f.service.createPreview(1, rule, f.context());
    const result = await f.finish(preview.id);
    assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'interrupted');
    assert.equal(result.resumable, false);
    assert.deepEqual(f.visits.map(visit => visit.searches), [0, mode === 'revoke' ? 1 : 2]);
    const saved = f.db.prepare('SELECT scan_batches,matched_count,before_uid FROM mail_task_folders WHERE task_id=?').get(preview.id);
    assert.deepEqual({ ...saved }, { scan_batches: 1, matched_count: 200, before_uid: 251 });
    const blocks = f.db.prepare('SELECT position,uids_json FROM mail_task_uid_blocks WHERE task_id=?').all(preview.id);
    assert.equal(blocks.length, 1); assert.equal(blocks[0].position, 0);
    assert.deepEqual(JSON.parse(blocks[0].uids_json), Array.from({ length: 200 }, (_, i) => 450 - i));
    assert.throws(() => f.service.applyPreview(1, rule, preview.id, f.context()), { statusCode: 409 });
    assert.deepEqual(f.writes, []);
  });
});

test('rule samples are bounded, header-only and removed from responses after scope is revoked', async t => {
  const operations = [];
  const f = fixture(t, 430, { fast: true, onFetch(folder, uids, _, fields) { operations.push({ folder, uids, fields }); } });
  for (const message of f.boxes.A.messages) {
    message.envelope = { subject: `Sample ${message.uid}\x00${'字'.repeat(256)}` };
    message.internalDate = new Date('2026-02-04T03:02:01Z');
  }
  f.boxes.B = { validity: '88', next: 2, messages: [{ ...msg(1), envelope: { subject: 'other folder' } }] };
  const rule = f.rule();
  const task = f.service.createPreview(1, rule, f.context());
  const finished = await f.finish(task.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.results[0].samples, undefined, 'internal callers cannot read persisted samples');
  assert.deepEqual(operations.map(({ folder, uids }) => [folder, uids]), [['A', [430, 429, 428]], ['B', [1]]]);
  assert.ok(operations.every(({ fields }) => JSON.stringify(fields) === '{"uid":true,"envelope":true,"internalDate":true}'));
  assert.ok(f.visits.every(visit => visit.readOnly));
  assert.equal(f.writes.length, 0);
  const result = f.service.get(1, task.id, f.context());
  assert.equal(result.results[0].matched, 430);
  assert.equal(result.results[0].samples.length, 3);
  assert.ok(result.results[0].samples.every(sample => Buffer.byteLength(sample.subject) <= 192 && !sample.subject.includes('\x00') && sample.date === '2026-02-04T03:02:01.000Z'));
  f.deny('A');
  assert.deepEqual(f.service.get(1, task.id, f.context()).results.map(folder => folder.folder), ['B']);
  assert.throws(() => f.service.applyPreview(1, rule, task.id, f.context()), { statusCode: 404 });
});

test('sample failure is reported separately and never hides an incomplete matching scan', async t => {
  const f = fixture(t, 3, { onFetch() { throw Error('synthetic sample failure'); }, failSearch: folder => folder === 'B' });
  f.boxes.B = { validity: '88', next: 2, messages: [msg(1)] };
  const rule = f.rule();
  const task = f.service.createPreview(1, rule, f.context());
  await f.finish(task.id);
  const result = f.service.get(1, task.id, f.context());
  assert.equal(result.status, 'partial');
  assert.equal(result.results[0].matched, 3);
  assert.equal(result.results[0].sampleReason, 'unavailable');
  assert.equal(result.results[1].reason, 'scan_failed');
  assert.throws(() => f.service.applyPreview(1, rule, task.id, f.context()), { statusCode: 409 });
});
