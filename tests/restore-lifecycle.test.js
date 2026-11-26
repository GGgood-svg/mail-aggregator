'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const express = require('express');
const { withStateLock } = require('../server/state-lock');
const maintenance = require('../server/maintenance-lock');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-restore-lifecycle-'));
  const dirs = Object.fromEntries(['tmp','secrets','cache','restorePoints'].map(name => [name,path.join(root,name)])); dirs.root = root;
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { recursive: true });
  const state = { commits: 0, stoppedTasks: 0, starts: 0, revoked: new Set() };
  const restore = require('../server/restore');
  const dependencies = {
    'better-sqlite3': class {},
    './auth': { assertCurrentUser(req) { if (state.revoked.has(req.sessionID)) throw Object.assign(Error('revoked session'), { statusCode: 401 }); return req.user; } },
    './restore-preflight': {
      async prepareRestoreArchive({ stageDir }) {
        fs.mkdirSync(stageDir, { recursive: true });
        return { verified: { archiveSha256: 'b'.repeat(64), uncompressedBytes: 4, fileCount: 1 },
          database: { accountCount: 0 }, databasePath: path.join(stageDir, 'data/db/mail-aggregator.db'), secretsDir: path.join(stageDir, 'data/secrets') };
      }, checkTarget() {},
    },
    './backup': { createBackupBundle: async options => {
      state.backupSignal = options.signal; state.snapshotEntered?.resolve(); await state.snapshotGate?.promise;
      const work = fs.mkdtempSync(path.join(dirs.tmp, 'bundle-')), archivePath = path.join(work, 'fixture.tar.gz'); fs.writeFileSync(archivePath, 'fixture');
      return { filename: 'mail-aggregator-fixture.tar.gz', archivePath, sha256: 'a'.repeat(64), cleanup() { fs.rmSync(work, { recursive: true, force: true }); } };
    } },
    './restore': { ...restore,
      receiveArchive(...args) { state.uploadEntered?.resolve(); return restore.receiveArchive(...args); },
      async extractVerifiedArchive(_, target) { fs.mkdirSync(target, { recursive: true }); },
      inspectRestoreDatabase: () => ({ accountCount: 0 }),
      restoreApplicationState: ({ beforeCommit }) => withStateLock(root, () => {
        beforeCommit();
        state.commits++;
        return { rules: 0 };
      }, { allowDuringRestore: true }),
    },
  };
  const file = path.join(__dirname, '../server/restore-router.js'), module = { exports: {} }, fallback = createRequire(file);
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require','module','exports'], { filename: file })(
    key => Object.hasOwn(dependencies, key) ? dependencies[key] : fallback(key), module, module.exports);
  const app = express(); app.use(express.json());
  app.use((req, _, next) => { req.user = { id: 1 }; req.sessionID = req.get('x-session') || 'sid-A'; next(); });
  app.post('/revoke', (req, res) => { withStateLock(root, () => state.revoked.add(req.sessionID), { allowDuringRestore: true }); res.json({ ok: true }); });
  app.use('/restore', module.exports.createRestoreRouter({ db: { prepare: () => ({ get: () => ({ count: 0 }) }) }, dirs, version: 'fixture',
    scheduler: { stop() {}, start() { state.starts++; } }, hasRunningSyncs: () => false, passwordGuard: (_, __, next) => next(),
    stopMailTasks: async () => { state.stoppedTasks++; } }));
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { state.snapshotGate?.resolve(); maintenance.release('restore'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function request(url, body, sid = 'sid-A') {
    return fetch(base + url, { method: 'POST', headers: { 'content-type': Buffer.isBuffer(body) ? 'application/gzip' : 'application/json', 'x-session': sid },
      body: Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  }
  return { root, state, request, base };
}

test('slow restore upload uses its own global admission slot and leaves configuration writes available', async t => {
  const f = await fixture(t); f.state.uploadEntered = deferred();
  const upload = http.request(`${f.base}/restore/inspect`, { method: 'POST', headers: { 'content-type': 'application/gzip' } });
  const response = new Promise((resolve, reject) => { upload.once('error', reject); upload.once('response', res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) })); }); });
  upload.write('a'); await f.state.uploadEntered.promise;
  try {
    assert.equal(withStateLock(f.root, () => 'available'), 'available');
    assert.equal((await f.request('/restore/inspect', Buffer.from('second'))).status, 409);
    upload.end('b'); const result = await response; assert.equal(result.status, 200); assert.equal(result.data.uploadBytes, 2);
    assert.equal(withStateLock(f.root, () => 'still available'), 'still available');
  } finally { upload.destroy(); }
});

test('restore checks session and preflight ownership again after safety compression, with revocation allowed', async t => {
  const f = await fixture(t);
  const inspected = await f.request('/restore/inspect', Buffer.from('fixture')).then(r => r.json());
  const body = { restoreId: inspected.restoreId, confirmation: 'RESTORE' };
  assert.equal((await f.request('/restore/apply', body, 'sid-B')).status, 404);
  f.state.snapshotEntered = deferred(); f.state.snapshotGate = deferred();
  const applying = f.request('/restore/apply', body); await f.state.snapshotEntered.promise;
  assert.equal(f.state.stoppedTasks, 1); assert.equal(maintenance.current(), 'restore');
  assert.throws(() => withStateLock(f.root, () => {}), { statusCode: 409 });
  assert.equal((await f.request('/revoke', {})).status, 200);
  f.state.snapshotGate.resolve(); assert.equal((await applying).status, 401);
  assert.equal(f.state.commits, 0); assert.equal(maintenance.current(), null); assert.equal(f.state.starts, 1);
  assert.equal(fs.existsSync(path.join(f.root, '.state-write.lock')), false);
});

test('successful restore stops mail work and commits once under the short state lock', async t => {
  const f = await fixture(t);
  const inspected = await f.request('/restore/inspect', Buffer.from('fixture')).then(r => r.json());
  const response = await f.request('/restore/apply', { restoreId: inspected.restoreId, confirmation: 'RESTORE' });
  assert.equal(response.status, 200); assert.equal(f.state.commits, 1); assert.equal(f.state.stoppedTasks, 1);
  assert.equal((await f.request('/restore/apply', { restoreId: inspected.restoreId, confirmation: 'RESTORE' })).status, 404);
  assert.equal(maintenance.current(), null); assert.equal(fs.existsSync(path.join(f.root, '.state-write.lock')), false);
});
