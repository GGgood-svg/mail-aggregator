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
const security = require('../server/totp-security');

function load(name, dependencies) {
  const file = path.join(__dirname, '../server', name), module = { exports: {} };
  const fallback = createRequire(file);
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', '__filename', '__dirname'], { filename: file })(
    key => Object.hasOwn(dependencies, key) ? dependencies[key] : fallback(key), module, module.exports, file, path.dirname(file));
  return module.exports;
}
function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-totp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function decode(seed) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let rest = 0, bits = 0;
  const data = [];
  for (const char of seed) {
    rest = (rest << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; data.push((rest >> bits) & 255); }
  }
  return Buffer.from(data);
}
const user = { id: 1, username: 'fixture', role: 'admin', mail_access_all: 1, enabled: 1, session_version: 0 };
const SECOND = 30_000;
const START = 1_785_000_000_000;
const codeAt = (seed, time) => security.hotp(decode(seed), Math.floor(time / SECOND));

class TestDatabase {
  constructor(file, options = {}) {
    const db = new DatabaseSync(file, { readOnly: options.readonly === true });
    db.pragma = sql => db.exec(`PRAGMA ${sql}`);
    db.transaction = fn => (...args) => {
      db.exec('BEGIN');
      try { const result = fn(...args); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    return db;
  }
}

test('RFC 6238 SHA-1 vectors and one adjacent step work without accepting a consumed step', () => {
  const secret = Buffer.from('12345678901234567890');
  for (const [time, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(security.hotp(secret, Math.floor(time / 30), 8), expected);
  }
  const previous = security.hotp(secret, 9), current = security.hotp(secret, 10), future = security.hotp(secret, 11);
  assert.equal(security.matchingStep(secret, previous, 10 * SECOND), 9);
  assert.equal(security.matchingStep(secret, previous, 10 * SECOND, 9), null);
  assert.equal(security.matchingStep(secret, current, 10 * SECOND, 10), null);
  assert.equal(security.matchingStep(secret, future, 10 * SECOND, 10), 11);
  assert.equal(security.matchingStep(secret, security.hotp(secret, 12), 10 * SECOND), null);
  assert.deepEqual(decode(security.base32(secret)), secret);
});

test('encrypted store keeps replay markers and consumed recovery codes across reload; invalid state fails closed', t => {
  const root = folder(t);
  let now = START;
  let totp = security.createTotpSecurity(root, () => now);
  assert.equal(totp.status(user).enabled, false);
  assert.deepEqual(fs.readdirSync(root), []);
  const { seed } = totp.begin(user, 'device');
  const { codes, generation } = totp.enable(user, 'device', codeAt(seed, now));
  const statePath = path.join(root, '.web-security', 'state.json');
  const state = fs.readFileSync(statePath, 'utf8');
  assert.ok(!state.includes(seed) && !codes.some(code => state.includes(code)));
  assert.equal(codes.length, 10);
  totp.beginLogin(user, 'browser', 'localhost');
  assert.throws(() => totp.finishLogin(user, 'browser', 'localhost', codeAt(seed, now)), { code: 'totp_invalid_code' });
  assert.equal(totp.finishLogin(user, 'browser', 'localhost', codes[0]), generation);
  totp = security.createTotpSecurity(root, () => now);
  assert.equal(totp.status(user).remainingCodes, 9);
  totp.beginLogin(user, 'another', 'localhost');
  assert.throws(() => totp.finishLogin(user, 'another', 'localhost', codes[0]), { code: 'totp_invalid_code' });
  assert.throws(() => totp.finishLogin(user, 'another', 'different', codes[1]), { code: 'totp_login_expired' });
  now += SECOND;
  assert.equal(totp.finishLogin(user, 'another', 'localhost', codeAt(seed, now)), generation);
  const corrupted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  corrupted.payload = JSON.stringify({ version: 1, factors: {} });
  fs.writeFileSync(statePath, JSON.stringify(corrupted));
  assert.throws(() => security.createTotpSecurity(root).status(user), { code: 'totp_state_unavailable' });
  fs.renameSync(path.join(root, '.web-security'), path.join(root, 'lost'));
  assert.throws(() => security.createTotpSecurity(root).status(user), { code: 'totp_state_unavailable' });
});

test('attempt limits survive new sessions and reload, and code changes revoke challenges', t => {
  const root = folder(t);
  let now = START;
  let totp = security.createTotpSecurity(root, () => now);
  const { seed } = totp.begin(user, 'setup');
  const old = totp.enable(user, 'setup', codeAt(seed, now));
  now += SECOND;
  for (let i = 0; i < 5; i++) {
    const sid = `attempt-${i}`;
    totp.beginLogin(user, sid, 'localhost');
    assert.throws(() => totp.finishLogin(user, sid, 'localhost', 'bad-code'), { code: i === 4 ? 'totp_rate_limited' : 'totp_invalid_code' });
  }
  totp = security.createTotpSecurity(root, () => now);
  assert.throws(() => totp.beginLogin(user, 'retry', 'localhost'), { code: 'totp_rate_limited' });
  now += 300_001;
  totp.beginLogin(user, 'retry', 'localhost');
  const rotated = totp.change(user, codeAt(seed, now));
  assert.notEqual(rotated.generation, old.generation);
  assert.throws(() => totp.finishLogin(user, 'retry', 'localhost', rotated.codes[0]), { code: 'totp_login_expired' });
  totp.beginLogin(user, 'new-session', 'localhost');
  assert.throws(() => totp.finishLogin(user, 'new-session', 'localhost', old.codes[0]), { code: 'totp_invalid_code' });
  assert.throws(() => totp.change(user, rotated.codes[0], true), { code: 'totp_invalid_code' });
  now += SECOND;
  const disabled = totp.change(user, codeAt(seed, now), true);
  assert.notEqual(disabled.generation, rotated.generation);
  assert.deepEqual(totp.status(user), { enabled: false, generation: disabled.generation, remainingCodes: 0 });
});

async function http(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-totp-http-')), previous = process.env.MAIL_AGG_DATA_DIR;
  process.env.MAIL_AGG_DATA_DIR = root;
  let database, now = START;
  try { database = load('db.js', { 'better-sqlite3': TestDatabase }); }
  finally { if (previous === undefined) delete process.env.MAIL_AGG_DATA_DIR; else process.env.MAIL_AGG_DATA_DIR = previous; }
  const { db, DIRS } = database;
  db.exec("INSERT INTO admin_users(id,username,password_hash,role,mail_access_all) VALUES(1,'fixture','fixture-password','admin',1),(2,'reader','reader-password','user',0)");
  const auth = load('auth.js', { './db': database,
    './password-hasher': { passwordHasher: { compare: async (value, hash) => value === hash } },
    './totp-security': { ...security, createTotpSecurity: folder => security.createTotpSecurity(folder, () => now) },
  });
  const Store = load('sessionStore.js', { './db': database });
  const app = express(); app.use(express.json());
  app.use(session({ secret: 'fictional-http-signing-key', resave: false, saveUninitialized: false, store: new Store(db), cookie: { maxAge: 3600000 } }));
  app.use('/api/auth', auth.router);
  app.get('/api/mail', auth.requireAuth, (_req, res) => res.json({ ok: true }));
  app.get('/api/settings', auth.requireAuth, auth.requirePrimaryAdmin, (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message, code: error.code }));
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections(); await closed; db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await once(server, 'listening');
  async function request(route, { browser, body, headers = {}, noCsrf } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(12_000), headers: {
      // This test checks authorization and simultaneous requests; latency is measured separately.
      Connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}), ...(browser?.cookie ? { cookie: browser.cookie } : {}),
      ...(browser?.csrfToken && !noCsrf ? { 'X-CSRF-Token': browser.csrfToken } : {}), ...headers,
    }, body: body && JSON.stringify(body) });
    const json = await response.json();
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    return { status: response.status, json, cache: response.headers.get('cache-control'), browser: { cookie: cookie || browser?.cookie, csrfToken: json.csrfToken || browser?.csrfToken } };
  }
  const login = () => request('/auth/login', { body: { username: user.username, password: 'fixture-password' } });
  async function enroll(browser) {
    const begin = await request('/auth/totp/begin', { browser, body: { currentPassword: 'fixture-password' } });
    assert.equal(begin.status, 200);
    assert.match(begin.json.seed, /^[A-Z2-7]{32}$/);
    assert.equal(begin.cache, 'no-store');
    assert.ok(begin.json.qr.every(row => row.length === begin.json.qr.length && /^[01]+$/.test(row)));
    const finish = await request('/auth/totp/enable', { browser, body: { currentPassword: 'fixture-password', code: codeAt(begin.json.seed, now) } });
    assert.equal(finish.status, 200); assert.equal(finish.json.codes.length, 10);
    assert.equal(finish.cache, 'no-store');
    return { ...finish, seed: begin.json.seed };
  }
  return { request, login, enroll, DIRS, db, root, time: () => now, tick: () => { now += SECOND; } };
}

test('real HTTP requires protected transport, CSRF and the second factor; one recovery code wins a race', async t => {
  const h = await http(t);
  const oldDevice = await h.login(), admin = await h.login();
  assert.equal(admin.status, 200);
  assert.deepEqual((await h.request('/auth/totp', { browser: admin.browser })).json, { enabled: false, remainingCodes: 0, secure: true });
  const member = await h.request('/auth/login', { body: { username: 'reader', password: 'reader-password' } });
  assert.equal((await h.request('/auth/totp', { browser: member.browser })).status, 403);
  const current = { currentPassword: 'fixture-password' };
  assert.equal((await h.request('/auth/totp/begin', { browser: admin.browser, body: current, noCsrf: true })).status, 403);
  assert.equal((await h.request('/auth/totp/begin', { browser: admin.browser, body: current, headers: { 'X-Forwarded-For': '203.0.113.1' } })).json.code, 'totp_secure_transport');
  assert.equal((await h.request('/auth/totp/begin', { browser: admin.browser, body: { currentPassword: 'not-correct' } })).status, 401);
  const enrolled = await h.enroll(admin.browser);
  assert.notEqual(enrolled.browser.cookie, admin.browser.cookie);
  assert.equal((await h.request('/auth/me', { browser: oldDevice.browser })).status, 401);
  assert.equal((await h.request('/auth/me', { browser: enrolled.browser })).status, 200);
  assert.equal((await h.request('/auth/devices', { browser: enrolled.browser })).json.devices.length, 1);
  const [first, second] = await Promise.all([h.login(), h.login()]);
  for (const pending of [first, second]) {
    assert.equal(pending.status, 202); assert.equal(pending.json.requiresTotp, true);
    assert.equal((await h.request('/auth/me', { browser: pending.browser })).status, 401);
    assert.equal((await h.request('/mail', { browser: pending.browser })).status, 401);
    assert.equal((await h.request('/settings', { browser: pending.browser })).status, 401);
  }
  const recoveryCode = { code: enrolled.json.codes[0] };
  assert.equal((await h.request('/auth/login/totp', { browser: first.browser, body: recoveryCode, noCsrf: true })).status, 403);
  assert.equal((await h.request('/auth/login/totp', { browser: first.browser, body: recoveryCode, headers: { 'X-Forwarded-Proto': 'http' } })).status, 403);
  const races = await Promise.all([first, second].map(({ browser }) => h.request('/auth/login/totp', { browser, body: recoveryCode })));
  assert.deepEqual(races.map(result => result.status).sort(), [200, 401]);
  const winner = races.find(result => result.status === 200), before = winner === races[0] ? first : second;
  assert.notEqual(winner.browser.cookie, before.browser.cookie);
  assert.equal((await h.request('/auth/me', { browser: winner.browser })).status, 200);
  assert.equal((await h.request('/auth/me', { browser: before.browser })).status, 401);
  assert.equal((await h.request('/auth/totp', { browser: winner.browser })).json.remainingCodes, 9);
  const [third, fourth] = await Promise.all([h.login(), h.login()]);
  h.tick(); const freshCode = { code: codeAt(enrolled.seed, h.time()) };
  const tokenRace = await Promise.all([third, fourth].map(({ browser }) => h.request('/auth/login/totp', { browser, body: freshCode })));
  assert.deepEqual(tokenRace.map(result => result.status).sort(), [200, 401]);
});

test('application restore preserves live two-step requirements and consumed codes', async t => {
  const h = await http(t);
  const live = await h.login();
  const archive = path.join(h.root, 'older-app.db');
  const earlier = new TestDatabase(archive);
  const schema = h.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  for (const item of schema) earlier.exec(item.sql);
  earlier.exec("INSERT INTO admin_users(id,username,password_hash,role,mail_access_all) VALUES(1,'fixture','old-password','admin',1)");
  earlier.close();
  const enrolled = await h.enroll(live.browser);
  const step = await h.login(), used = { code: enrolled.json.codes[0] };
  const loggedIn = await h.request('/auth/login/totp', { browser: step.browser, body: used });
  assert.equal(loggedIn.status, 200);
  const state = path.join(h.root, '.web-security', 'state.json');
  const saved = fs.readFileSync(state);
  const backupSecrets = path.join(h.root, 'older-secrets'), workDir = path.join(h.root, 'restore-work');
  fs.mkdirSync(backupSecrets); fs.mkdirSync(workDir);
  const { restoreApplicationState } = require('../server/restore');
  restoreApplicationState({ Database: TestDatabase, currentDb: h.db, backupDbPath: archive,
    currentSecretsDir: h.DIRS.secrets, backupSecretsDir: backupSecrets, workDir });
  assert.deepEqual(fs.readFileSync(state), saved);
  assert.equal((await h.request('/auth/totp', { browser: loggedIn.browser })).json.remainingCodes, 9);
  const second = await h.login();
  assert.equal(second.status, 202);
  assert.equal((await h.request('/auth/login/totp', { browser: second.browser, body: used })).status, 401);
  assert.equal((await h.request('/auth/login/totp', { browser: second.browser, body: { code: enrolled.json.codes[1] } })).status, 200);
});

test('Linux offline command refuses live Web and disables the factor only once after Web stops',
  { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, t => {
    const Database = require('better-sqlite3');
    const { spawnSync } = require('node:child_process');
    const { acquireDataProcessLock } = require('../server/data-process');
    const root = folder(t);
    const directory = path.join(root, 'db'), hostLock = path.join(root, 'maintenance');
    fs.mkdirSync(directory);
    fs.writeFileSync(hostLock, '', { mode: 0o600 });
    const db = new Database(path.join(directory, 'mail-aggregator.db'));
    db.exec("CREATE TABLE admin_users (id INTEGER, username TEXT, enabled INTEGER, role TEXT, mail_access_all INTEGER); INSERT INTO admin_users VALUES (1, 'fixture', 1, 'admin', 1)");
    db.close();
    const totp = security.createTotpSecurity(root, () => START);
    const { seed } = totp.begin(user, 'setup');
    const enrolled = totp.enable(user, 'setup', codeAt(seed, START));
    const recover = (username = user.username) => spawnSync(process.execPath, [path.join(__dirname, '../server/cli-totp-recovery.js'), '--confirm-disable-totp', username],
      { env: { ...process.env, MAIL_AGG_DATA_DIR: root, MAIL_AGG_HOST_MAINTENANCE_LOCK: hostLock }, encoding: 'utf8', timeout: 8_000 });
    const release = acquireDataProcessLock(root);
    try {
      const refused = recover();
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /先停止该进程/);
      assert.equal(security.createTotpSecurity(root).status(user).enabled, true);
    } finally { release(); }
    assert.equal(recover('unrelated-user').status, 1);
    const recovery = recover();
    assert.equal(recovery.status, 0, recovery.stderr);
    const status = security.createTotpSecurity(root).status(user);
    assert.equal(status.enabled, false);
    assert.equal(status.remainingCodes, 0);
    assert.notEqual(status.generation, enrolled.generation);
    assert.equal(recover().status, 1);
  });
