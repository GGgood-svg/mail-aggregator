'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const release = require('../scripts/updater/release');
const policy = require('../scripts/updater/policy');
const { extract } = require('../scripts/updater/archive');
const { transaction, json, writeJson, remove } = require('../scripts/updater/transaction');
const { createUpdateGate } = require('../server/update-gate');
const { track } = require('../server/update-activity');

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-app-update-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const assets = Object.values(release.ASSETS).map(name => ({ name, state: 'uploaded' }));
const item = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: tag_name.includes('-'), assets, ...extra });
const options = fetchImpl => ({ fetchImpl });
const key = crypto.generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
const tag = 'v0.1.7';
const commit = 'a'.repeat(40);
const payload = Buffer.from('package signed by a temporary test key');
const meta = { protocol: release.PROTOCOL, repository: release.REPO, platform: release.PLATFORM, tag, commit,
  bundle: release.ASSETS.bundle, nodeAbi: +process.versions.modules, bytes: payload.length,
  sha256: crypto.createHash('sha256').update(payload).digest('hex'), automatic: true, from: ['v0.1.6'] };
const document = Buffer.from(JSON.stringify(meta));
const signature = crypto.sign(null, document, key.privateKey);

test('version and channel rules never downgrade or expose drafts', () => {
  const list = [item('v0.1.7-rc.2'), item('v0.1.7-beta.10'), item('v0.1.7'), item('v0.1.8', { draft: true }),
    item('v0.1.8-beta.1', { prerelease: false }), item('main'), item('v0.1.6'), item('v00.1.8')];
  assert.deepEqual(release.releaseCandidates(list, '0.1.6', 'preview').map(x => x.tag_name), ['v0.1.7', 'v0.1.7-rc.2', 'v0.1.7-beta.10']);
  assert.deepEqual(release.releaseCandidates(list, '0.1.7-rc.2', 'stable').map(x => x.tag_name), ['v0.1.7']);
  assert.deepEqual(release.releaseCandidates(list, '0.1.8-beta.0', 'stable'), []);
  assert.ok(release.compare('v0.1.7-beta.10', 'v0.1.7-beta.9') > 0);
  assert.ok(release.compare('v0.1.7-rc.0', 'v0.1.7-rc') > 0);
  assert.ok(release.compare('v0.1.7-rc', 'v0.1.7-beta.20') > 0);
});
test('cross-midnight and DST windows use the administrator timezone', () => {
  const local = policy.settings({ mode: 'auto', channel: 'preview', start: '23:30', end: '01:00', timezone: 'Asia/Shanghai' });
  const time = value => Date.parse(value);
  assert.equal(policy.within(local, time('2026-11-24T15:29:59Z')), false);
  assert.equal(policy.within(local, time('2026-11-24T16:59:59Z')), true);
  assert.equal(policy.within(local, time('2026-11-24T17:00:00Z')), false);
  assert.equal(policy.nextWindow(local, time('2026-11-24T17:00:00Z')), time('2026-11-25T15:30:00Z'));
  const ny = { ...local, start: '02:15', end: '02:45', timezone: 'America/New_York' };
  assert.equal(policy.nextWindow(ny, time('2026-03-08T05:00:00Z')), time('2026-03-09T06:15:00Z'));
  const repeated = { ...ny, start: '01:15', end: '01:45' };
  assert.equal(policy.within(repeated, time('2026-11-01T05:25:00Z')), true);
  assert.equal(policy.within(repeated, time('2026-11-01T06:25:00Z')), true);
  assert.throws(() => policy.settings({ ...local, timezone: 'Wrong/Zone' }), { code: 'invalid_timezone' });
  assert.throws(() => policy.settings({ ...local, end: local.start }), { code: 'invalid_settings' });
});
test('manifest requires Ed25519, exact repository, release tag, and tested source', () => {
  assert.deepEqual(release.decodeManifest(document, signature, publicKey, tag), meta);
  assert.throws(() => release.decodeManifest(document, Buffer.alloc(64), publicKey, tag), { code: 'invalid_signature' });
  assert.throws(() => release.decodeManifest(document, signature, publicKey, 'v0.1.8'), { code: 'invalid_manifest' });
  for (const changed of [{ repository: 'not-the/requested-project' }, { from: [] }, { from: [tag] }, { from: ['v0.1.6','v0.1.6'] }, { platform: 'debian' }]) {
    const bytes = Buffer.from(JSON.stringify({ ...meta, ...changed }));
    assert.throws(() => release.decodeManifest(bytes, crypto.sign(null, bytes, key.privateKey), publicKey, tag), { code: 'invalid_manifest' });
  }
});
function apiFixture(commitForTag = commit) {
  return async target => {
    if (target.pathname.endsWith('/releases')) return Response.json([item(tag, { body: 'Short release notes' })]);
    if (target.pathname.endsWith(release.ASSETS.manifest)) return new Response(document);
    if (target.pathname.endsWith(release.ASSETS.signature)) return new Response(signature);
    if (target.pathname.endsWith(`/ref/tags/${tag}`)) return Response.json({ ref: `refs/tags/${tag}`, object: { type: 'tag', sha: 'b'.repeat(40) } });
    if (target.pathname.endsWith(`/tags/${'b'.repeat(40)}`)) return Response.json({ object: { type: 'commit', sha: commitForTag } });
    throw new Error('unexpected URL');
  };
}
test('discovery and signed metadata resolve annotated tags to the signed commit', async () => {
  const found = await release.discover('0.1.6', 'stable', options(apiFixture()));
  assert.equal(release.publicRelease(found).notes, 'Short release notes');
  assert.deepEqual(await release.readManifest(found, publicKey, options(apiFixture())), meta);
  await assert.rejects(release.readManifest(found, publicKey, options(apiFixture('c'.repeat(40)))), { code: 'release_changed' });
  await assert.rejects(release.readManifest(item(tag, { assets: {} }), publicKey, options(apiFixture())), { code: 'manual_upgrade' });
});
test('GitHub timeout, throttling and oversized discovery responses are distinguished', async () => {
  await assert.rejects(release.discover('0.1.6', 'stable', options(async () => new Response('', { status: 429 }))), { code: 'github_rate_limit' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15);
  try { await assert.rejects(release.discover('0.1.6', 'stable', { signal: controller.signal, fetchImpl: async (_url, { signal }) => {
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('['));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
  } }), { code: 'github_timeout' }); } finally { clearTimeout(timeout); }
  await assert.rejects(release.discover('0.1.6', 'stable', options(async () => new Response(Buffer.alloc(2 * release.MiB + 1)))), { code: 'response_too_large' });
});
test('binary downloads accept only approved HTTPS redirects and verify hash and size', async t => {
  const dir = await tmp(t), output = path.join(dir, 'bundle');
  const fetchAsset = async url => url.hostname === 'github.com'
    ? new Response('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/test-fixture' } }) : new Response(payload);
  await release.download(meta, output, options(fetchAsset));
  assert.deepEqual(await fs.readFile(output), payload);
  await assert.rejects(release.download(meta, output, options(fetchAsset)), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(output), payload, 'a failed duplicate must not remove an existing file');
  for (const [response, error] of [[Buffer.from(payload).fill(25), 'bad_package_hash'], [payload.subarray(1), 'bad_package_hash'], [Buffer.concat([payload, payload]), 'bad_package_size']]) {
    const name = path.join(dir, crypto.randomUUID());
    await assert.rejects(release.download(meta, name, options(async () => new Response(response))), { code: error });
    await assert.rejects(fs.stat(name), { code: 'ENOENT' });
  }
  const forbidden = async () => new Response('', { status: 302, headers: { location: 'https://example.invalid/package' } });
  await assert.rejects(release.download(meta, path.join(dir, 'forbidden'), options(forbidden)), { code: 'unexpected_download_host' });
});
test('reads an actual USTAR archive and rejects a truncated copy', async t => {
  const { ustarFixture } = require('./fixtures/ustar.cjs');
  const dir = await tmp(t), archive = path.join(dir, 'bundle.tar.gz');
  await fs.writeFile(archive, ustarFixture({ 'package.json':'{}', 'package-lock.json':'{}', 'server/app.js':'server/app.js',
    'web/index.html':'', 'node_modules/better-sqlite3/package.json':'{}' }));
  await extract(archive, path.join(dir, 'unpacked'));
  assert.equal(await fs.readFile(path.join(dir, 'unpacked/server/app.js'), 'utf8'), 'server/app.js');
  const bad = path.join(dir, 'bad.tar.gz');
  const raw = await fs.readFile(archive);
  await fs.writeFile(bad, raw.subarray(0, raw.length - 12));
  await assert.rejects(extract(bad, path.join(dir, 'bad')));
});
test('a disconnected write remains busy only until its handler finishes', async () => {
  let paused = false, background = false;
  const gate = createUpdateGate({ journal: 'mock', pending: () => paused, busy: () => background, pause() {}, resume() {} });
  const req = {}, res = new EventEmitter();
  let releaseWrite;
  const write = new Promise(resolve => { releaseWrite = resolve; });
  let tracked;
  gate.middleware(req, res, () => { tracked = track(() => write)(req, res); });
  res.emit('close');
  paused = true;
  assert.equal(gate.isIdle(), false);
  releaseWrite();
  await tracked;
  assert.equal(gate.isIdle(), true);
  assert.equal(track(() => assert.fail('late write'))(req, res), undefined);
  background = true;
  assert.equal(gate.isIdle(), false);
});

async function harness(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-update-db-'));
  const journal = path.join(root, 'journal.json'), filename = path.join(root, 'app.db'), snapshot = path.join(root, 'old.db');
  let db;
  t.after(async () => { if (db?.open) db.close(); await fs.rm(root, { recursive: true, force: true }); });
  db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec("CREATE TABLE items(value TEXT); INSERT INTO items VALUES('before')");
  assert.ok((await fs.stat(`${filename}-wal`)).size > 0);
  let tree = '0.1.6', running = true, events = [], failRecord = options.failRecord;
  const read = () => json(journal);
  const tx = () => transaction({
    read, publish: value => writeJson(journal, value), clear: () => remove(journal),
    idle: async () => { assert.equal((await read()).phase, 'draining'); return options.idle !== false; },
    stop: async ({ boot } = {}) => { events.push(boot ? 'stopped-at-boot' : 'stop'); running = false; },
    snapshot: async () => { assert.equal(running, false); await db.backup(snapshot); events.push('snapshot'); },
    swap: async () => { tree = '0.1.7'; events.push('switch'); if (options.failSwap) throw new Error('interruption after rename'); },
    restore: async () => {
      if (options.failRollback) throw new Error('unavailable rollback store');
      const copy = new Database(snapshot, { readonly: true });
      try { db.prepare('DELETE FROM items').run(); for (const row of copy.prepare('SELECT value FROM items').all()) db.prepare('INSERT INTO items VALUES(?)').run(row.value); }
      finally { copy.close(); }
      tree = '0.1.6'; events.push('restore');
    },
    startAndProbe: async version => {
      assert.equal(version, tree); running = true;
      if (version === '0.1.7') {
        db.prepare('INSERT INTO items VALUES(?)').run('migration');
        if (options.failReady) throw new release.UpdateError('readiness_failed');
      }
      events.push(`ready:${version}`);
    },
    record: async outcome => { if (failRecord) throw new Error('status write failed'); events.push(outcome); },
  });
  async function put(phase) {
    await db.backup(snapshot);
    await writeJson(journal, { ...input, phase });
  }
  return { db, events, tx, read, put, allowRecord: () => { failRecord = false; }, data: () => db.prepare('SELECT value FROM items').pluck().all() };
}
const input = { from: '0.1.6', to: '0.1.7', running: true };
test('busy or expired-window updates never stop the service or consume a snapshot', async t => {
  const busy = await harness(t, { idle: false });
  await assert.rejects(busy.tx().apply(input), { code: 'busy' });
  assert.equal(await busy.read(), null);
  assert.deepEqual(busy.events, ['deferred']);
  const late = await harness(t);
  await assert.rejects(late.tx().apply({ ...input, allowed: () => false }), { code: 'outside_window' });
  assert.deepEqual(late.events, ['deferred']);
});
test('readiness failure reinstates the SQLite contents and probes the old version', async t => {
  const h = await harness(t, { failReady: true });
  await assert.rejects(h.tx().apply(input), { code: 'readiness_failed' });
  assert.equal(await h.read(), null);
  assert.deepEqual(h.data(), ['before']);
  assert.deepEqual(h.events, ['stop', 'snapshot', 'switch', 'stop', 'restore', 'ready:0.1.6', 'rolled_back']);
});
test('a failed rollback leaves a durable stop marker for explicit recovery', async t => {
  const h = await harness(t, { failSwap: true, failRollback: true });
  await assert.rejects(h.tx().apply(input), { code: 'rollback_failed' });
  const record = await h.read();
  assert.equal(record.phase, 'switching');
  assert.equal(record.recoveryFailed, true);
  const observed = h.events.slice();
  await assert.rejects(h.tx().recover(record, { boot: true }), { code: 'rollback_failed' });
  assert.deepEqual(h.events, observed);
});
test('boot recovery restores SQLite before the service manager starts Web', async t => {
  const h = await harness(t);
  await h.put('testing');
  h.db.prepare('INSERT INTO items VALUES(?)').run('unconfirmed migration');
  assert.equal(await h.tx().recover(await h.read(), { boot: true }), 'rolled_back');
  assert.equal(await h.read(), null);
  assert.deepEqual(h.data(), ['before']);
  assert.deepEqual(h.events, ['stopped-at-boot', 'restore', 'rolled_back']);
});
test('a committed upgrade never restores an old snapshot, including after finalization failure', async t => {
  const h = await harness(t, { failRecord: true });
  await assert.rejects(h.tx().apply(input), { code: 'finalization_failed' });
  const record = await h.read();
  assert.equal(record.phase, 'committed');
  h.db.prepare('INSERT INTO items VALUES(?)').run('user write');
  h.allowRecord();
  assert.equal(await h.tx().recover(record, { boot: true }), 'installed');
  assert.equal(await h.read(), null);
  assert.deepEqual(h.data(), ['before', 'migration', 'user write']);
  assert.deepEqual(h.events, ['stop', 'snapshot', 'switch', 'ready:0.1.7', 'installed']);
});

test('held auto updates resume only in a maintenance window and exact skip does not pin newer releases', () => {
  const now = Date.parse('2026-11-24T15:00:00Z'); // 23:00 Beijing time.
  const initial = policy.settings({ ...policy.defaults, mode: 'auto', timezone: 'Asia/Shanghai', start: '23:00', end: '01:00' });
  const target = 'v0.2.0';
  const held = policy.patchSettings(initial, { holdUntil: Date.parse('2026-11-24T18:30:00Z') }, target, now);
  assert.equal(policy.allowAutomatic(held, target, now), false);
  assert.deepEqual(policy.autoStatus(held, target, now), { reason: 'auto_paused', at: Date.parse('2026-11-25T15:00:00Z') });
  assert.equal(policy.allowAutomatic(held, target, Date.parse('2026-11-25T15:00:00Z')), true);
  const skipped = policy.patchSettings(initial, { skipTag: target }, target, now);
  assert.equal(policy.allowAutomatic(skipped, target, now), false);
  assert.equal(policy.allowAutomatic(skipped, 'v0.2.1', now), true);
  assert.deepEqual(policy.autoStatus(skipped, target, now), { reason: 'version_skipped', at: null });
  assert.equal(policy.patchSettings(skipped, { mode: 'check' }, target, now).skipTag, target);
  assert.throws(() => policy.patchSettings(initial, { holdUntil: now }, target, now), { code: 'invalid_hold_time' });
  assert.throws(() => policy.patchSettings(initial, { skipTag: 'v0.3.0' }, target, now), { code: 'invalid_skip_version' });
  assert.equal(policy.patchSettings(held, { holdUntil: null }, target, now).holdUntil, null);
});

test('bounded update history persists stable operation IDs across journal replay without recording duplicate outcomes', async t => {
  const { historyEntry } = require('../scripts/updater/transaction');
  const id = '12345678-1234-1234-1234-123456789abc';
  const record = { from: '0.1.6', to: '0.2.0', operationId: id, source: 'manual', startedAt: 50 };
  const row = historyEntry([], record, 'rolled_back', { now: 100 });
  assert.equal(row[0].operationId, id);
  assert.equal(row[0].source, 'manual');
  assert.deepEqual(historyEntry(row, record, 'rolled_back', { now: 200 })[0], row[0]);
  const explained = historyEntry(row, record, 'rolled_back', { reason: 'readiness_failed', now: 300 });
  assert.equal(explained.length, 1);
  assert.equal(explained[0].at, 100);
  assert.equal(explained[0].reason, 'readiness_failed');
  assert.equal(historyEntry(explained, record, 'rollback_verified', { now: 500 }).length, 2);
  let history = [];
  for (let i = 0; i <= 70; i++) history = historyEntry(history, { from: '0.1.6', to: `0.2.${i}` }, 'installed');
  assert.equal(history.length, 60);
  assert.equal(history[0].to, '0.2.70');
});
