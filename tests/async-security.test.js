'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const express = require('express');
const session = require('express-session');
const { DatabaseSync } = require('node:sqlite');
const stateLock = require('../server/state-lock');

function load(name, dependencies) {
  const file = path.join(__dirname, '../server', name), module = { exports: {} };
  const fallback = createRequire(file);
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', '__filename', '__dirname'], { filename: file })(
    key => Object.hasOwn(dependencies, key) ? dependencies[key] : fallback(key), module, module.exports, file, path.dirname(file));
  return module.exports;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function finishedTask(f, id, headers = f.member) {
  for (let i = 0; i < 300; i++) {
    const response = await f.request(`/api/mail/tasks/${id}`, headers); assert.equal(response.status, 200);
    const task = await response.json(); if (!['queued','running','cancelling'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Task did not finish');
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-security-'));
  const old = process.env.MAIL_AGG_DATA_DIR; process.env.MAIL_AGG_DATA_DIR = root;
  let database;
  try {
    database = load('db.js', { 'better-sqlite3': function Database(file) {
      const db = new DatabaseSync(file); db.pragma = sql => db.exec(`PRAGMA ${sql}`);
      db.transaction = fn => (...args) => { db.exec('BEGIN'); try { const result = fn(...args); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
      return db;
    } });
  } finally { if (old === undefined) delete process.env.MAIL_AGG_DATA_DIR; else process.env.MAIL_AGG_DATA_DIR = old; }
  const { db } = database;
  const isolatedLocks = { ...stateLock, stateRoute: (handler, options) => stateLock.asyncRoute((req, res, next) =>
    stateLock.withStateLock(root, () => handler(req, res, next), options)) };
  const dependencies = { './db': database, './state-lock': isolatedLocks, './password-hasher': { passwordHasher: { compare: async () => true } } };
  const auth = load('auth.js', dependencies);
  const Store = load('sessionStore.js', dependencies);
  const users = load('users.js', { ...dependencies, './auth': auth });
  db.exec("INSERT INTO admin_users(id,username,password_hash,role,mail_access_all) VALUES(1,'primary','hash','admin',1),(2,'member','hash','user',0)");
  db.exec("INSERT INTO accounts(id,name,provider,host,username,auth_type,owner_user_id,destination_mode,mailbox_folder,destination_folder) VALUES(7,'Fixture','gmail','imap.gmail.com','fixture@example.invalid','oauth2',2,'subfolder','U2-A7','Fixture')");
  const state = { flags: new Set(), writes: 0, saves: 0, exchangeCalls: 0, baseUrl: 'https://fixture.invalid', client: { clientId: 'fixture-client', clientSecret: 'fixture-secret' } };
  const mail = load('mail-reader.js', { './db': database, './auth': auth,
    './config': { localDovecot: () => ({ user: 'mailuser', host: '127.0.0.1', port: 143 }) } });
  const oauthCore = require('../server/oauth-core');
  const oauth = load('oauth-router.js', { './db': database, './auth': auth, './state-lock': isolatedLocks,
    './oauth-core': { ...oauthCore, exchangeAuthorizationCode: async () => {
      state.exchangeCalls++; state.exchangeEntered?.resolve(); await state.exchangeGate?.promise; return { accessToken: 'fictional-token' };
    } },
    './oauth-store': { publicBaseUrl: () => state.baseUrl, getOAuthClient: () => ({ ...state.client }) },
    './credentials': { saveOAuthTokens: () => { state.saves++; }, oauthAuthorizationGeneration: () => null },
  });
  const app = express(); app.use(express.json());
  const store = new Store(db);
  app.use(session({ secret: 'isolated-fixture-session-secret', resave: false, saveUninitialized: false, store,
    cookie: { maxAge: 3600000 } }));
  app.use('/api/auth', auth.router);
  app.use('/api/users', auth.requireAuth, auth.requireCsrf, auth.requireAdmin, users);
  app.use('/api/oauth', auth.requireAuth, auth.requireCsrf, oauth);
  app.get('/late-set', auth.requireAuth, async (req, res) => {
    state.lateEntered.resolve(); await state.lateGate.promise; req.session.extra = 'late-data'; res.json({ ok: true });
  });
  const mailRouter = mail.createMailRouter({
    createClient: () => ({
      async connect() {}, async logout() {}, close() {},
      async list() { state.listEntered?.resolve(); await state.listGate?.promise; return [{ path: 'U2-A7.INBOX', name: 'INBOX', flags: new Set() }]; },
      async mailboxOpen() { state.openEntered?.resolve(); await state.openGate?.promise; return { uidValidity: '77', uidNext: 8, exists: 1 }; },
      async search(query) {
        const [low, high] = query.uid.split(':').map(Number);
        return low <= 7 && high >= 7 && (query.seen === undefined || query.seen === state.flags.has('\\Seen')) && (query.flagged === undefined || query.flagged === state.flags.has('\\Flagged')) ? [7] : [];
      },
      async fetchAll(uids) { return uids.includes(7) ? [{ uid: 7, flags: new Set(state.flags) }] : []; },
      async fetchOne() { return { uid: 7, flags: new Set(state.flags) }; },
      async messageFlagsAdd(_, flags) { state.writes++; flags.forEach(flag => state.flags.add(flag)); state.writeEntered?.resolve(); await state.writeGate?.promise; return true; },
      async messageFlagsRemove(_, flags) { state.writes++; flags.forEach(flag => state.flags.delete(flag)); return true; },
    }),
  });
  const tasks = mailRouter.mailTasks;
  app.use('/api/mail', auth.requireAuth, auth.requireCsrf, mailRouter);
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { state.listGate?.resolve(); state.openGate?.resolve(); state.exchangeGate?.resolve(); state.lateGate?.resolve(); state.writeGate?.resolve(); await tasks.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function login(username) {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'fixture-password' }) });
    assert.equal(response.status, 200); const data = await response.json();
    return { cookie: response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': data.csrfToken };
  }
  const member = await login('member'), admin = await login('primary');
  const request = (url, headers = member, method = 'GET', body) => fetch(base + url, { method, redirect: 'manual', headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  async function startOAuth(id = 7) {
    const response = await request(`/api/oauth/accounts/${id}/start`, member, 'POST', {}); assert.equal(response.status, 200);
    const flow = new URL((await response.json()).authorizationUrl).searchParams.get('state');
    return `/api/oauth/callback/google?state=${flow}&code=fictional-code`;
  }
  return { root, db, store, state, tasks, request, login, member, admin, startOAuth };
}

test('real Express sessions cannot be resurrected by a late touch or modified-session save after logout', async t => {
  for (const modified of [false, true]) await t.test(modified ? 'set' : 'touch', async t => {
    const f = await fixture(t), entered = deferred(), gate = deferred();
    if (modified) { f.state.lateEntered = entered; f.state.lateGate = gate; }
    else { f.state.listEntered = entered; f.state.listGate = gate; }
    const revokedBefore = f.db.prepare('SELECT COUNT(*) n FROM session_revocations').get().n;
    const pending = f.request(modified ? '/late-set' : '/api/mail/folders');
    await entered.promise;
    assert.equal((await f.request('/api/auth/logout', f.member, 'POST', {})).status, 200);
    assert.equal((await f.request('/api/auth/me')).status, 401);
    gate.resolve(); const response = await pending;
    assert.equal(response.status, modified ? 200 : 401); await response.arrayBuffer();
    assert.equal((await f.request('/api/auth/me')).status, 401);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM session_revocations').get().n, revokedBefore + 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1, 'only administrator session remains');
  });
});

test('mail rule and task HTTP APIs enforce CSRF, owner isolation, preview completeness and duplicate application', async t => {
  const f = await fixture(t);
  const payload = { name: 'Fixture rule', scope: 'folder', folder: 'U2-A7.INBOX', filters: { seen: 'unread' }, action: 'star' };
  assert.equal((await f.request('/api/mail/rules', {}, 'POST', payload)).status, 401);
  assert.equal((await f.request('/api/mail/rules', { cookie: f.member.cookie }, 'POST', payload)).status, 403);
  assert.equal((await f.request('/api/mail/rules', f.member, 'POST', { ...payload, folder: 'U1-A1.INBOX' })).status, 404);
  assert.equal((await f.request('/api/mail/rules', f.member, 'POST', { ...payload, action: 'delete' })).status, 400);
  let response = await f.request('/api/mail/rules', f.member, 'POST', payload); assert.equal(response.status, 201);
  const rule = await response.json();
  assert.equal((await f.request(`/api/mail/rules/${rule.id}`, f.admin, 'PUT', payload)).status, 404);
  assert.equal((await f.request('/api/mail/rules', f.admin).then(r => r.json())).rules.length, 0);
  const preview = await f.request(`/api/mail/rules/${rule.id}/previews`, f.member, 'POST', {}).then(r => r.json());
  assert.equal((await finishedTask(f, preview.id)).matched, 1); assert.equal(f.state.writes, 0);
  assert.equal((await f.request(`/api/mail/tasks/${preview.id}`, f.admin)).status, 404);
  assert.equal((await f.request(`/api/mail/tasks/${preview.id}/cancel`, f.admin, 'POST', {})).status, 404);
  response = await f.request(`/api/mail/rules/${rule.id}/previews/${preview.id}/apply`, f.member, 'POST', {}); assert.equal(response.status, 202);
  const applied = await response.json();
  const duplicate = await f.request(`/api/mail/rules/${rule.id}/previews/${preview.id}/apply`, f.member, 'POST', {}).then(r => r.json());
  assert.equal(duplicate.id, applied.id);
  const result = await finishedTask(f, applied.id); assert.equal(result.updated, 1); assert.equal(result.status, 'completed');
  assert.equal(f.state.writes, 1); assert.equal(f.state.flags.has('\\Flagged'), true);
  const list = await f.request('/api/mail/tasks?page=1.5&pageSize=2.5').then(r => r.json()); assert.equal(list.pagination.page, 1); assert.equal(list.pagination.pageSize, 2);
  response = await f.request(`/api/mail/rules/${rule.id}`, f.member, 'PUT', { ...payload, action: 'unstar' }); assert.equal(response.status, 200);
  const updated = await response.json(); assert.equal(updated.revision, 2);
  const obsolete = await f.request(`/api/mail/rules/${rule.id}/previews`, f.member, 'POST', {}).then(r => r.json()); await finishedTask(f, obsolete.id);
  await f.request(`/api/mail/rules/${rule.id}`, f.member, 'PUT', { ...payload, action: 'unseen' });
  assert.equal((await f.request(`/api/mail/rules/${rule.id}/previews/${obsolete.id}/apply`, f.member, 'POST', {})).status, 409);
  assert.equal((await f.request(`/api/mail/rules/${rule.id}`, f.member, 'DELETE')).status, 200);
});

test('logout remains available while a configuration snapshot holds the state lock', async t => {
  const f = await fixture(t);
  await stateLock.withStateLock(f.root, async () => {
    assert.equal((await f.request('/api/auth/logout', f.member, 'POST', {})).status, 200);
    assert.equal((await f.request('/api/auth/me', f.member)).status, 401);
  });
});

test('mail rules cap concurrent creates at fifty and user deletion cascades rule and task history', async t => {
  const f = await fixture(t);
  const payload = { name: 'Fixture', scope: 'folder', folder: 'U2-A7.INBOX', filters: {}, action: 'seen' };
  const responses = await Promise.all(Array.from({ length: 60 }, (_, i) => f.request('/api/mail/rules', f.member, 'POST', { ...payload, name: `Rule ${i}` })));
  assert.equal(responses.filter(response => response.status === 201).length, 50);
  assert.equal(responses.filter(response => response.status === 409).length, 10);
  f.db.prepare("INSERT INTO mail_tasks(id,owner_user_id,kind,status,spec_json,created_at) VALUES('history',2,'seen_all','completed','{}',1)").run();
  f.db.prepare('DELETE FROM accounts WHERE owner_user_id=2').run();
  assert.equal((await f.request('/api/users/2', f.admin, 'DELETE')).status, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mail_rules WHERE owner_user_id=2').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mail_tasks WHERE owner_user_id=2').get().n, 0);
});

test('logout interrupts durable writes, retains uncertain progress and requires a fresh authenticated resume', async t => {
  const f = await fixture(t); f.state.writeEntered = deferred(); f.state.writeGate = deferred();
  const response = await f.request('/api/mail/seen-jobs', f.member, 'POST', { folders: ['U2-A7.INBOX'] });
  assert.equal(response.status, 202); const task = await response.json(); await f.state.writeEntered.promise;
  assert.equal((await f.request('/api/auth/logout', f.member, 'POST', {})).status, 200);
  for (let i = 0; i < 100 && ['queued','running','cancelling'].includes(f.tasks.get(2, task.id).status); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const interrupted = f.tasks.get(2, task.id); assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.uncertain, 1); assert.equal(interrupted.updated, 0);
  assert.equal((await f.request(`/api/mail/tasks/${task.id}/resume`, f.member, 'POST', {})).status, 401);
  f.state.writeGate.resolve(); const fresh = await f.login('member');
  assert.equal((await f.request(`/api/mail/tasks/${task.id}/resume`, fresh, 'POST', {})).status, 202);
  const resumed = await finishedTask(f, task.id, fresh); assert.equal(resumed.status, 'completed'); assert.equal(resumed.updated, 1); assert.equal(f.state.writes, 1);
});

test('disabling an ordinary mailbox owner through the administrator API prevents pending IMAP writes', async t => {
  const f = await fixture(t); f.state.openEntered = deferred(); f.state.openGate = deferred();
  const pending = f.request('/api/mail/messages/7/seen?folder=U2-A7.INBOX&uidValidity=77', f.member, 'PUT', { seen: true });
  await f.state.openEntered.promise;
  assert.equal((await f.request('/api/users/2', f.admin, 'PUT', { enabled: false, role: 'user' })).status, 200);
  f.state.openGate.resolve(); assert.equal((await pending).status, 401); assert.equal(f.state.writes, 0);
});

test('OAuth exchange releases the global state lock, consumes its flow once, and cannot commit after logout', async t => {
  const f = await fixture(t), url = await f.startOAuth(); f.state.exchangeEntered = deferred(); f.state.exchangeGate = deferred();
  const pending = f.request(url); await f.state.exchangeEntered.promise;
  assert.equal((await f.request(url)).status, 400, 'replayed callback is rejected without a second exchange');
  assert.equal(f.state.exchangeCalls, 1);
  assert.equal((await f.request('/api/auth/logout', f.member, 'POST', {})).status, 200);
  f.state.exchangeGate.resolve(); const response = await pending;
  assert.match(response.headers.get('location'), /oauth=error/); assert.equal(f.state.saves, 0);
  assert.equal((await f.request('/api/auth/me')).status, 401);
});

test('OAuth commit rejects account, client, base URL or sync-state changes during exchange', async t => {
  for (const mutation of ['account', 'client', 'base', 'sync']) await t.test(mutation, async t => {
    const f = await fixture(t), url = await f.startOAuth(); f.state.exchangeEntered = deferred(); f.state.exchangeGate = deferred();
    const pending = f.request(url); await f.state.exchangeEntered.promise;
    if (mutation === 'account') f.db.prepare("UPDATE accounts SET username='different@example.invalid' WHERE id=7").run();
    if (mutation === 'client') f.state.client.clientId = 'changed-client';
    if (mutation === 'base') f.state.baseUrl = 'https://changed.invalid';
    if (mutation === 'sync') f.db.exec("INSERT INTO sync_jobs(account_id,started_at,status) VALUES(7,datetime('now'),'queued')");
    f.state.exchangeGate.resolve(); const response = await pending;
    assert.match(response.headers.get('location'), /oauth=error/); assert.equal(f.state.saves, 0);
  });
});

test('OAuth succeeds once with stable account and configuration', async t => {
  const f = await fixture(t), url = await f.startOAuth();
  assert.match((await f.request(url)).headers.get('location'), /oauth=success/);
  assert.equal(f.state.saves, 1); await f.request(url); assert.equal(f.state.saves, 1);
});

test('saved searches enforce session, CSRF, ownership, strict filter validation and unavailable folder behavior', async t => {
  const f = await fixture(t);
  const value = { name: '<img src=x onerror=alert(1)>', scope: 'all', filters: { flagged: 'starred', subject: '  invoice  ', seen: 'all' } };
  assert.equal((await f.request('/api/mail/saved-searches', { cookie: f.member.cookie }, 'POST', value)).status, 403);
  let response = await f.request('/api/mail/saved-searches', f.member, 'POST', value);
  assert.equal(response.status, 201); const saved = await response.json();
  assert.deepEqual(saved.filters, { subject: 'invoice', flagged: 'starred' });
  assert.deepEqual((await (await f.request('/api/mail/saved-searches', f.admin)).json()).searches, []);
  assert.equal((await f.request(`/api/mail/saved-searches/${saved.id}`, f.admin, 'DELETE')).status, 404);
  assert.equal((await f.request(`/api/mail/saved-searches/${saved.id}`, f.admin, 'PUT', value)).status, 404);
  for (const invalid of [{ ...value, uid: 7 }, { ...value, filters: { page: '1' } }, { ...value, filters: { flagged: true } },
    { ...value, filters: {} }, { ...value, filters: { flagged: 'invalid' } }, { ...value, filters: { since: '2026-02-30' } },
    { ...value, scope: 'folder', folder: 'U1-A1.INBOX' }]) {
    response = await f.request('/api/mail/saved-searches', f.member, 'POST', invalid); assert.ok([400, 404].includes(response.status));
  }
  response = await f.request(`/api/mail/saved-searches/${saved.id}`, f.member, 'PUT', { name: 'Folder search', scope: 'folder', folder: 'U2-A7.INBOX', filters: { seen: 'unread' } });
  assert.equal(response.status, 200);
  f.db.exec('UPDATE accounts SET owner_user_id=1 WHERE id=7');
  const unavailable = (await (await f.request('/api/mail/saved-searches')).json()).searches[0];
  assert.equal(unavailable.available, false); assert.equal(unavailable.folder, 'U2-A7.INBOX');
  assert.equal((await f.request('/api/mail/messages?folder=U2-A7.INBOX')).status, 404);
  assert.equal((await f.request(`/api/mail/saved-searches/${saved.id}`, f.member, 'DELETE')).status, 200);
});

test('saved-search limit stays at fifty under simultaneous creates and user deletion cascades', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 51 }, (_, i) => f.request('/api/mail/saved-searches', f.member, 'POST', {
    name: `Search ${i}`, scope: 'all', filters: { flagged: 'starred' },
  })));
  assert.equal(responses.filter(response => response.status === 201).length, 50);
  assert.equal(responses.filter(response => response.status === 409).length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saved_searches WHERE owner_user_id=2').get().n, 50);
  f.db.exec('DELETE FROM accounts WHERE owner_user_id=2; DELETE FROM admin_users WHERE id=2');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saved_searches').get().n, 0);
});

test('saved-search mutations respect the backup/restore state lock while reads remain available', async t => {
  const f = await fixture(t), gate = deferred();
  const locked = stateLock.withStateLock(f.root, () => gate.promise);
  try {
    assert.equal((await f.request('/api/mail/saved-searches', f.member, 'POST', { name: 'Busy', scope: 'all', filters: { seen: 'unread' } })).status, 409);
    assert.equal((await f.request('/api/mail/saved-searches')).status, 200);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saved_searches').get().n, 0);
  } finally { gate.resolve(); await locked; }
});

test('session store only touches live sessions and caps stale saves at the revocation lifetime', async t => {
  const f = await fixture(t), week = 7 * 24 * 60 * 60 * 1000;
  const call = (method, ...args) => new Promise((resolve, reject) => f.store[method](...args, error => error ? reject(error) : resolve()));
  await call('touch', 'missing', { cookie: { maxAge: week } });
  assert.equal(f.db.prepare("SELECT 1 FROM sessions WHERE sid='missing'").get(), undefined);
  f.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('expired', '{}', Date.now() - 100);
  await call('touch', 'expired', { cookie: { maxAge: week } });
  assert.ok(f.db.prepare("SELECT expires FROM sessions WHERE sid='expired'").get().expires < Date.now());
  const before = Date.now(); await call('set', 'capped', { userId: 2, cookie: { maxAge: week * 2 } });
  assert.ok(f.db.prepare("SELECT expires FROM sessions WHERE sid='capped'").get().expires <= before + week + 100);
  await call('destroy', 'capped'); await call('set', 'capped', { userId: 2, cookie: { maxAge: week } });
  await call('touch', 'capped', { cookie: { maxAge: week } });
  assert.equal(f.db.prepare("SELECT 1 FROM sessions WHERE sid='capped'").get(), undefined);
});

test('device controls list only own sessions and revoke a selected login without dropping the current browser', async t => {
  const f = await fixture(t);
  const second = await f.login('member');
  const list = await f.request('/api/auth/devices');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const { devices } = await list.json();
  assert.equal(devices.length, 2);
  assert.equal(devices.filter(device => device.current).length, 1);
  const selected = devices.find(device => !device.current);
  assert.deepEqual(Object.keys(selected).sort(), ['browser','current','expiresAt','id','lastSeenAt','loginAt']);
  const url = `/api/auth/devices/${selected.id}`;
  assert.equal((await f.request(url, f.admin, 'DELETE')).status, 404);
  assert.equal((await f.request(url, { cookie: f.member.cookie }, 'DELETE')).status, 403);
  assert.equal((await f.request(url, f.member, 'DELETE')).status, 200);
  assert.equal((await f.request('/api/auth/devices', second)).status, 401);
  assert.equal((await f.request('/api/auth/devices', f.member)).status, 200);
  assert.equal((await f.request('/api/auth/devices', f.admin)).status, 200);
  const third = await f.login('member');
  const fourth = await f.login('member');
  const bulk = await f.request('/api/auth/devices/revoke-others', f.member, 'POST');
  assert.equal(bulk.status, 200);
  assert.equal((await bulk.json()).revoked, 2);
  assert.equal((await f.request('/api/auth/devices', third)).status, 401);
  assert.equal((await f.request('/api/auth/devices', fourth)).status, 401);
  assert.equal((await f.request('/api/auth/devices', f.member)).status, 200);
});

test('OAuth callbacks isolate two tabs and a cancelled flow is consumed exactly once', async t => {
  const f = await fixture(t);
  f.db.exec("INSERT INTO accounts(id,name,provider,host,username,auth_type,owner_user_id) VALUES(8,'Second','gmail','imap.gmail.com','second@example.invalid','oauth2',2)");
  const [first, second] = await Promise.all([f.startOAuth(7),f.startOAuth(8)]);
  assert.notEqual(first, second);
  assert.equal((await f.request(first, f.admin)).status, 400, 'another session cannot consume the flow');
  const cancelled = await f.request(second.replace('code=fictional-code','error=access_denied'));
  assert.match(cancelled.headers.get('location'), /id=8&oauth=error/);
  assert.equal((await f.request(second)).status, 400);
  assert.match((await f.request(first)).headers.get('location'), /id=7&oauth=success/);
  assert.equal(f.state.exchangeCalls, 1);
});

test('failed logout retains the browser cookie and session until revocation can be retried', async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER block_logout BEFORE INSERT ON session_revocations BEGIN SELECT RAISE(ABORT,'injected write error'); END");
  const failed = await f.request('/api/auth/logout', f.member, 'POST', {});
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('set-cookie'), null);
  assert.equal((await f.request('/api/auth/me')).status, 200);
  f.db.exec('DROP TRIGGER block_logout');
  const success = await f.request('/api/auth/logout', f.member, 'POST', {});
  assert.equal(success.status, 200);
  assert.match(success.headers.get('set-cookie'), /connect\.sid=;/);
  assert.equal((await f.request('/api/auth/me')).status, 401);
});
