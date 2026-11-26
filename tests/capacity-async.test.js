'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCapacityChecker } = require('../server/resource-limits');
const dirs = { root: '/app', cache: '/app/cache', tmp: '/app/tmp' };
const local = { host: '127.0.0.1', port: 143, user: 'fixture' };
const statfs = async () => ({ bavail: 2048, bsize: 1024 * 1024, files: 100, ffree: 50 });
function settings() {
  const state = { minimum: 512 };
  state.db = { prepare: () => ({ get: () => ({ value: String(state.minimum) }) }) };
  return state;
}

test('capacity probes coalesce concurrent callers and re-evaluate reserve settings after an await and on cache hits', async () => {
  const state = settings();
  let release, calls = 0, now = 1000;
  const check = createCapacityChecker({ statfs, env: {}, now: () => now,
    run: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const first = check(state.db, dirs, local), second = check(state.db, dirs, local);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  state.minimum = 1600;
  release({ stdout: '1048576 50\n' });
  assert.equal((await first).ok, false);
  assert.equal((await second).availableMb, 1024);
  state.minimum = 512;
  assert.equal((await check(state.db, dirs, local)).ok, true);
  assert.equal(calls, 1);
  now += 1001;
  const refreshed = check(state.db, dirs, local);
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  release({ stdout: '0 50\n' });
  assert.equal((await refreshed).ok, false, 'expired positive must not hide low storage');
});

test('expired capacity successes are discarded when helper fails or returns invalid values', async () => {
  const state = settings();
  let now = 1000, output = '1048576 50';
  const check = createCapacityChecker({ statfs, env: {}, now: () => now, run: async () => {
    if (output instanceof Error) throw output;
    return output;
  } });
  assert.equal((await check(state.db, dirs, local)).ok, true);
  for (const bad of [Error('fixture'), 'Infinity 50', '9999999999999999999999 50', '1048576 50 extra']) {
    output = bad; now += 1001;
    assert.equal((await check(state.db, dirs, local)).availableMb, null);
  }
});

test('capacity timeout fails closed, caps distinct active probes and retains slots for unfinished OS work', async () => {
  const state = settings();
  let calls = 0;
  const releases = [];
  const check = createCapacityChecker({ statfs, env: {}, timeoutMs: 25, maxConcurrent: 1,
    run: () => { calls++; return new Promise(resolve => releases.push(resolve)); } });
  const first = check(state.db, dirs, local);
  await new Promise(setImmediate);
  assert.equal((await check(state.db, dirs, { ...local, user: 'second' })).ok, false);
  assert.equal(calls, 1);
  assert.equal((await first).availableMb, null);
  assert.equal((await check(state.db, dirs, { ...local, user: 'third' })).ok, false);
  assert.equal(calls, 1, 'timed-out helper still occupies a slot');
  releases[0]('1048576 50');
  await new Promise(setImmediate);
  const next = check(state.db, dirs, { ...local, user: 'fourth' });
  await new Promise(setImmediate);
  releases[1]('1048576 50');
  assert.equal((await next).ok, true);
});

test('mounted mail storage and application inodes are checked asynchronously without invoking helper', async () => {
  const state = settings();
  const seen = [];
  const check = createCapacityChecker({ env: { MAIL_AGG_MAIL_STORAGE_PATH: '/mail' },
    statfs: async directory => { seen.push(directory); return { bavail: 2048, bsize: 1024 * 1024, files: 100, ffree: directory === '/mail' ? 0 : 20 }; },
    run: () => assert.fail('mounted storage must not invoke sudo') });
  const result = await check(state.db, dirs, { ...local, host: 'remote.example' });
  assert.equal(result.ok, false);
  assert.equal(result.storage, '/mail');
  assert.equal(result.availableInodes, 0);
  assert.deepEqual(seen, ['/app', '/app/cache', '/app/tmp', '/mail']);
});

test('distinct capacity probes queue by priority, coalesce waiters and report saturation as busy', async () => {
  const state = settings(), started = [], releases = [];
  const check = createCapacityChecker({ statfs, env: {}, maxConcurrent: 1, maxQueue: 3,
    run: (_file, args) => { started.push(args.at(-2)); return new Promise(resolve => releases.push(resolve)); } });
  const call = (user, priority) => check(state.db, dirs, { ...local, user }, { priority });
  const first = call('active', 1); await new Promise(setImmediate);
  const health = call('health', 0), admission = call('admission', 1), running = call('running', 2);
  const coalesced = call('admission', 2);
  assert.equal((await call('overflow', 1)).status, 'busy');
  releases[0]('1048576 50'); assert.equal((await first).status, 'ok'); await new Promise(setImmediate);
  assert.equal(started[1], 'admission', 'a coalesced running caller promotes the queued target');
  releases[1]('1048576 50'); assert.equal((await admission).ok, true); assert.equal((await coalesced).ok, true); await new Promise(setImmediate);
  assert.equal(started[2], 'running'); releases[2]('1048576 50'); await running; await new Promise(setImmediate);
  assert.equal(started[3], 'health'); releases[3]('1048576 50'); await health;
  assert.equal(started.length, 4);
});

test('queue deadline reports busy without starting work or reusing an expired capacity observation', async () => {
  const state = settings(); let release, calls = 0;
  const check = createCapacityChecker({ statfs, env: {}, timeoutMs: 30, maxConcurrent: 1,
    run: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const active = check(state.db, dirs, local); await new Promise(setImmediate);
  const waiting = check(state.db, dirs, { ...local, user: 'waiting' });
  assert.equal((await waiting).status, 'busy'); assert.equal((await active).status, 'unavailable'); assert.equal(calls, 1);
  release('1048576 50'); await new Promise(setImmediate);
});

test('separate log filesystems block sync with the specific reason and co-mounted uses appear once', async () => {
  const f = { root: '/app', db: '/app/db', secrets: '/app/secrets', logs: '/app/logs', tmp: '/app/tmp', restorePoints: '/app/restore' };
  const state = settings();
  const stat = async directory => ({ dev: directory === '/app/logs' ? 2n : directory === '/app/restore' ? 3n : 1n });
  for (const [available, expected] of [[{ bavail: 0, ffree: 50 }, 'low_space'], [{ bavail: 4096, ffree: 0 }, 'low_inodes']]) {
    const check = createCapacityChecker({ stat, env: {}, statfs: async directory => ({ bsize: 1048576, bavail: 4096, files: 500,
      ffree: 50, ...(directory === f.logs && available) }), run: async () => '4194304 50 dev:1' });
    const result = await check(state.db, f, local);
    assert.equal(result.code, expected);
    assert.equal(result.scope, 'global');
    assert.equal(result.storage, f.logs);
    assert.match(result.mountId, /^[a-f0-9]{20}$/);
    assert.deepEqual(result.observations.find(item => item.uses.includes('application')).uses,
      ['application','database','credentials','temporary','mail']);
    assert.equal(result.observations.length, 3);
  }
});

test('a separate restore-volume failure is reported but does not block unrelated synchronization', async () => {
  const f = { root: '/app', restorePoints: '/app/restore', logs: '/app/logs' };
  const state = settings();
  const check = createCapacityChecker({ env: {}, statfs: async directory => {
    if (directory === f.restorePoints) throw new Error('missing');
    return { bavail: 4096, bsize: 1048576, files: 0 };
  }, run: async () => '4194304 -' });
  const sync = await check(state.db, f, local);
  assert.equal(sync.status, 'ok');
  assert.equal(sync.observations.find(item => item.uses.includes('logs')).inodeStatus, 'unknown');
  const diag = await check(state.db, f, local, { operation: 'all', priority: 0 });
  assert.equal(diag.status, 'unavailable');
  assert.equal(diag.observations.filter(item => item.ok).length, 3);
});


const { parseMountInfo } = require('../server/linux-mounts');
const rootMount = '1 0 8:1 / / rw - ext4 /dev/main rw';
const logsMount = '2 1 8:2 / /app/logs rw - ext4 /dev/log rw';
const mailMount = '3 1 8:3 / /mail rw - ext4 /dev/mail rw';
const mountTable = (...lines) => parseMountInfo([rootMount, ...lines].join('\n'));
const fixtureDirs = { root: '/app', logs: '/app/logs', restorePoints: '/app/restore' };

function mountFixture(records = {}, required, all = fixtureDirs) {
  const state = settings();
  let at = 0;
  const check = createCapacityChecker({ statfs, env: { MAIL_AGG_REQUIRED_MOUNTS: required }, now: () => at,
    identifyDirectory: async directory => ({ stats: await statfs(), device: records.dirs?.get(directory)?.device ?? 1n,
      mount: records.dirs?.get(directory)?.mount ?? '1' }),
    readMounts: async () => {
      if (records.error) throw records.error;
      return records.table || mountTable();
    },
    run: async (_file, args) => {
      assert.deepEqual(args.slice(-3), ['fixture','--include-device','--include-mount']);
      return records.helper ?? '4194304 50 dev:1 mnt:1';
    } });
  return { advance: () => { at += 1001; }, probe: options => check(state.db, all, local, options) };
}

test('mountinfo recognizes read-only mount and superblock flags and unescapes the actual mount point', () => {
  const info = mountTable('2 1 8:1 /log /app/space\\040here ro,nosuid shared:5 - ext4 /dev/main rw',
    '3 1 8:2 / /app/logs rw,nosuid - ext4 /dev/log ro,errors=remount-ro');
  assert.equal(info.get('1').readOnly, false);
  assert.equal(info.get('2').point, '/app/space here');
  assert.equal(info.get('2').readOnly, true);
  assert.equal(info.get('3').readOnly, true);
  assert.throws(() => parseMountInfo('1 0 8:1 / / rw - ext4'), /Invalid Linux mount info/);
});

test('readonly bind on the root device only blocks operations that depend on its path', async () => {
  const records = { dirs: new Map([['/app/restore', { mount: '2', device: 1n }]]),
    table: mountTable('2 1 8:1 /snapshot /app/restore ro - ext4 /dev/main rw') };
  const { probe, advance } = mountFixture(records);
  const sync = await probe();
  assert.equal(sync.ok, true);
  assert.equal(sync.observations.find(x => x.storage === '/app/restore').failure, 'read_only');
  assert.equal(sync.observations.find(x => x.uses.includes('application')).failure, undefined);
  const all = await probe({ operation: 'all' });
  assert.equal(all.code, 'capacity_unavailable');
  assert.equal(all.failure, 'read_only');
  assert.equal(all.availableMb, null);
  advance(); records.table = mountTable(logsMount.replace('/app/logs rw - ext4 /dev/log rw', '/app/logs rw - ext4 /dev/log ro'));
  records.dirs = new Map([['/app/logs', { mount: '2', device: 2n }]]);
  assert.equal((await probe()).failure, 'read_only');
  assert.equal((await probe()).scope, 'global');
});

test('fresh pre-transfer probes catch an independent log volume falling back to root and recover on the same remount', async () => {
  const records = { table: mountTable(logsMount), dirs: new Map([['/app/logs', { mount: '2', device: 2n }]]) };
  const { probe, advance } = mountFixture(records);
  assert.equal((await probe()).ok, true);
  records.table = mountTable();
  records.dirs.clear();
  assert.equal((await probe()).ok, true, 'dashboard may reuse a short-lived observation');
  const blocked = await probe({ fresh: true });
  assert.equal(blocked.storage, '/app/logs');
  assert.equal(blocked.failure, 'mount_changed');
  assert.equal(blocked.code, 'capacity_unavailable');
  assert.equal(blocked.availableMb, null, 'do not publish capacity from the root fallback as log volume capacity');

  records.dirs.set('/app/logs', { mount: '5', device: 5n });
  records.table = mountTable('5 1 8:5 / /app/logs rw - ext4 /dev/replacement rw');
  advance(); assert.equal((await probe()).failure, 'mount_changed', 'do not silently accept a replacement volume');
  records.error = new Error('mount table unavailable');
  advance(); assert.equal((await probe()).failure, 'mount_changed', 'loss of identity cannot clear a known binding');
  records.error = null;
  records.dirs.set('/app/logs', { mount: '4', device: 2n });
  records.table = mountTable(logsMount.replace(/^2 /, '4 '));
  advance(); assert.equal((await probe()).ok, true, 'same volume may return with a different mount ID');
});

test('cold start tolerates ordinary root storage but enforces an explicitly required mount point', async () => {
  assert.equal((await mountFixture().probe()).ok, true);
  const records = {};
  const { probe, advance } = mountFixture(records, JSON.stringify({ logs: '/app/logs' }));
  const missing = await probe();
  assert.equal(missing.failure, 'mount_required');
  assert.equal(missing.storage, '/app/logs');
  records.table = mountTable(logsMount);
  records.dirs = new Map([['/app/logs', { mount: '2', device: 2n }]]);
  advance(); assert.equal((await probe()).ok, true);
  assert.equal((await mountFixture({}, '{"logs":"/"}').probe()).failure, 'mount_config_invalid');
});

test('helper target reports read-only and lost mount as account-scoped and retains compatibility with old helpers', async () => {
  const records = { table: mountTable(mailMount), helper: '4194304 50 dev:3 mnt:3' };
  const { probe, advance } = mountFixture(records);
  assert.equal((await probe()).ok, true);
  records.table = mountTable(mailMount.replace('/mail rw -', '/mail ro -'));
  advance(); let capacity = await probe();
  assert.equal(capacity.failure, 'read_only'); assert.equal(capacity.scope, 'account');
  records.table = mountTable(); records.helper = '4194304 50 dev:1 mnt:1';
  advance(); capacity = await probe();
  assert.equal(capacity.failure, 'mount_changed'); assert.equal(capacity.scope, 'account');
  assert.equal((await mountFixture({ helper: '4194304 50 dev:1' }).probe()).ok, true);
  assert.equal((await mountFixture({ helper: '4194304 50 dev:1' }, '{"mail":"/mail"}').probe()).failure, 'mount_required');
});
