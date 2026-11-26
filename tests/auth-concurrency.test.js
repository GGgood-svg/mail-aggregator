'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { withStateLock } = require('../server/state-lock');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) {}
const integrationTest = DatabaseSync ? test : test.skip;

async function fixture(work) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-concurrency-'));
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE admin_users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT,
    role TEXT DEFAULT 'user',enabled INTEGER DEFAULT 1,session_version INTEGER DEFAULT 0,mail_access_all INTEGER DEFAULT 0);
    CREATE TABLE login_attempts(ip TEXT PRIMARY KEY,fail_count INTEGER,locked_until INTEGER,window_started INTEGER);`);
  db.exec('CREATE TABLE sessions(sid TEXT PRIMARY KEY,sess TEXT,expires INTEGER)');
  const jobs = [];
  const hasher = {};
  for (const operation of ['compare', 'hash']) hasher[operation] = (...args) => new Promise((resolve, reject) => {
    jobs.push({ operation, args, resolve, reject });
  });
  function load(name, dependencies) {
    const filename = path.join(__dirname, '../server', name);
    const realRequire = createRequire(filename), context = { module: { exports: {} },
      require: key => Object.hasOwn(dependencies, key) ? dependencies[key] : realRequire(key) };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return context.module.exports;
  }
  const dependencies = { './db': { db, DIRS: { root } }, './password-hasher': { passwordHasher: hasher } };
  const auth = load('auth.js', dependencies);
  const users = load('users.js', { ...dependencies, './auth': auth });
  const addUser = (username = 'fixture-user', role = 'user', primary = 0) => Number(db.prepare(
    'INSERT INTO admin_users(username,password_hash,role,mail_access_all) VALUES(?,?,?,?)').run(username, 'original-hash', role, primary).lastInsertRowid);
  function request(id, body = {}, ip = '203.0.113.77') {
    const user = id ? db.prepare('SELECT * FROM admin_users WHERE id=?').get(id) : null;
    const req = { body, ip, user, app: { get: () => false }, get: () => '',
      session: { ...(user ? { userId: id, sessionVersion: user.session_version } : {}) } };
    req.session.regenerate = callback => { req.session = {}; callback(); };
    return req;
  }
  function invoke(router, route, req, method = 'post') {
    const layer = router.stack.find(item => item.route?.path === route && item.route.methods[method]);
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    const completion = Promise.resolve(layer.route.stack.at(-1).handle(req, res, error => {
      res.statusCode = error.statusCode || 500; res.body = { error: error.message };
    })).then(() => res);
    return { completion, res };
  }
  try { await work({ db, root, jobs, auth, users, addUser, request, invoke }); }
  finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

integrationTest('parallel first-admin setup hashes outside state lock and only one administrator is created', async () => {
  await fixture(async f => {
    const first = f.invoke(f.auth.router, '/setup', f.request(null, { username: 'first-admin', password: 'fictional-password' }));
    const second = f.invoke(f.auth.router, '/setup', f.request(null, { username: 'second-admin', password: 'fictional-password' }));
    assert.equal(f.jobs.length, 2);
    assert.equal(withStateLock(f.root, () => 'available'), 'available');
    f.jobs[0].resolve('hash-one'); f.jobs[1].resolve('hash-two');
    assert.equal((await first.completion).statusCode, 200);
    assert.equal((await second.completion).statusCode, 409);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM admin_users').get().n, 1);
  });
});

integrationTest('parallel login reservations prevent failure-limit bypass and release on worker rejection', async () => {
  await fixture(async f => {
    f.addUser();
    const attempts = Array.from({ length: 5 }, () => f.invoke(f.auth.router, '/login', f.request(null,
      { username: 'fixture-user', password: 'wrong-password' })));
    assert.equal(f.jobs.length, 5);
    const extra = await f.invoke(f.auth.router, '/login', f.request(null, { username: 'fixture-user', password: 'wrong-password' })).completion;
    assert.equal(extra.statusCode, 429);
    f.jobs.forEach(job => job.resolve(false));
    assert.ok((await Promise.all(attempts.map(item => item.completion))).every(res => res.statusCode === 401));
    assert.equal((await f.invoke(f.auth.router, '/login', f.request(null, { username: 'fixture-user' })).completion).statusCode, 429);
    f.db.prepare('DELETE FROM login_attempts').run();
    const failing = f.invoke(f.auth.router, '/login', f.request(null, { username: 'fixture-user', password: 'fixture' }));
    f.jobs.at(-1).reject(Object.assign(Error('worker unavailable'), { statusCode: 503 }));
    assert.equal((await failing.completion).statusCode, 503);
    const retry = f.invoke(f.auth.router, '/login', f.request(null, { username: 'fixture-user', password: 'fixture' }));
    f.jobs.at(-1).resolve(true);
    assert.equal((await retry.completion).statusCode, 200);
  });
});

integrationTest('login denies a stale hash or disabled user and still hashes unknown usernames', async () => {
  await fixture(async f => {
    const id = f.addUser();
    for (const update of ['password_hash=\'changed-hash\'', 'enabled=0']) {
      const req = f.request(null, { username: 'fixture-user', password: 'fixture' });
      const pending = f.invoke(f.auth.router, '/login', req);
      f.db.prepare(`UPDATE admin_users SET ${update} WHERE id=?`).run(id);
      f.jobs.at(-1).resolve(true);
      assert.equal((await pending.completion).statusCode, 401);
      assert.equal(req.session.userId, undefined);
    }
    const unknown = f.invoke(f.auth.router, '/login', f.request(null, { username: 'unknown', password: 'fixture' }));
    assert.match(f.jobs.at(-1).args[1], /^\$2a\$12\$/);
    f.jobs.at(-1).resolve(false);
    assert.equal((await unknown.completion).statusCode, 401);
  });
});

integrationTest('concurrent password changes cannot overwrite a newer password or act on a disabled account', async () => {
  await fixture(async f => {
    const id = f.addUser();
    const req = f.request(id, { currentPassword: 'old-password', newPassword: 'new-fictional-password' });
    const pending = f.invoke(f.auth.router, '/change-password', req);
    f.jobs[0].resolve(true);
    await new Promise(setImmediate);
    assert.equal(f.jobs[1].operation, 'hash');
    assert.equal(fs.existsSync(path.join(f.root, '.state-write.lock')), false);
    f.db.prepare('UPDATE admin_users SET password_hash=?,session_version=session_version+1 WHERE id=?').run('newer-password', id);
    f.jobs[1].resolve('stale-new-hash');
    assert.equal((await pending.completion).statusCode, 401);
    assert.equal(f.db.prepare('SELECT password_hash FROM admin_users WHERE id=?').get(id).password_hash, 'newer-password');
    const verify = f.auth.verifyCurrentPassword(f.request(id), 'fixture');
    f.db.prepare('UPDATE admin_users SET enabled=0 WHERE id=?').run(id);
    f.jobs.at(-1).resolve(true);
    await assert.rejects(verify, { statusCode: 401 });
  });
});

integrationTest('user creation revalidates administrator privileges after hashing and does not hold the state lock', async () => {
  await fixture(async f => {
    const id = f.addUser('admin-fixture', 'admin', 1);
    const pending = f.invoke(f.users, '/', f.request(id, { username: 'new-member', password: 'fictional-password', role: 'user' }));
    assert.equal(withStateLock(f.root, () => true), true);
    f.db.prepare("UPDATE admin_users SET role='user',session_version=session_version+1 WHERE id=?").run(id);
    f.jobs[0].resolve('member-hash');
    assert.equal((await pending.completion).statusCode, 401);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM admin_users').get().n, 1);
  });
});

integrationTest('late login session regeneration cannot bypass a newly reached lockout', async () => {
  await fixture(async f => {
    f.addUser();
    const req = f.request(null, { username: 'fixture-user', password: 'correct-fixture' });
    let regenerate;
    req.session.regenerate = callback => { req.session = {}; regenerate = callback; };
    const successful = f.invoke(f.auth.router, '/login', req);
    f.jobs[0].resolve(true);
    await successful.completion;
    const failures = Array.from({ length: 5 }, () => f.invoke(f.auth.router, '/login', f.request(null,
      { username: 'fixture-user', password: 'wrong-fixture' })));
    f.jobs.slice(1).forEach(job => job.resolve(false));
    await Promise.all(failures.map(item => item.completion));
    regenerate();
    assert.equal(successful.res.statusCode, 429);
    assert.equal(req.session.userId, undefined);
  });
});

integrationTest('state-lock contention after hashing refuses setup without losing the external lock', async () => {
  await fixture(async f => {
    const pending = f.invoke(f.auth.router, '/setup', f.request(null, { username: 'first-admin', password: 'fictional-password' }));
    let unlock;
    const held = withStateLock(f.root, () => new Promise(resolve => { unlock = resolve; }));
    try {
      f.jobs[0].resolve('fixture-hash');
      assert.equal((await pending.completion).statusCode, 409);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM admin_users').get().n, 0);
      assert.equal(fs.existsSync(path.join(f.root, '.state-write.lock')), true);
    } finally { unlock(); await held; }
  });
});

integrationTest('logout during password verification revokes the pending action without reviving the session', async () => {
  await fixture(async f => {
    const id = f.addUser();
    const req = f.request(id);
    req.sessionID = 'fixture-session';
    f.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(req.sessionID, JSON.stringify(req.session), Date.now() + 60000);
    const pending = f.auth.verifyCurrentPassword(req, 'fixture');
    f.db.prepare('DELETE FROM sessions WHERE sid=?').run(req.sessionID);
    f.jobs[0].resolve(true);
    await assert.rejects(pending, { statusCode: 401 });
    assert.equal(req.session, null);
  });
});
