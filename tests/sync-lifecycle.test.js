const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function fixture({ dns, probe, capacity = async () => ({ ok: true, availableMb: 2048, minimumMb: 512 }),
  captureIntervals = false, cacheFailure = false, queued = false, commitFailure = false, queueReadFailure = false, platform = process.platform, startWriteFailure = false } = {}) {
  const filename = path.join(__dirname, '../server/sync.js');
  const realRequire = createRequire(filename);
  const spawned = [], logs = [], writes = [], intervals = [];
  const state = { minimum: 512, blocked: false, enqueued: 0, openedLogs: 0 };
  const local = { host: '127.0.0.1', port: 143, user: 'mailuser' };
  const account = { id: 7, owner_user_id: 2, host: 'mail.example', port: 993, ssl: 1, username: 'fixture', auth_type: 'password', local_user: 'mailuser', destination_mode: 'subfolder', mailbox_folder: 'U2-A7' };
  let jobStatus = queued ? 'queued' : null, nextAttemptAt = null;
  let transferStarted = null;
  const credentials = { resolveTargetPassPath: () => '/data/target.pass', sourcePassPath: () => '/data/source.pass', hasSourceSecret: () => true, hasOAuthTokens: () => true };
  const dependencies = {
    './db': { DIRS: { root: '/data', cache: '/cache', logs: '/logs', tmp: '/tmp' }, db: { transaction: fn => fn, prepare(sql) {
      return { get: () => sql.includes('FROM accounts') ? account : sql.includes('FROM sync_jobs')
        ? { id: 9, account_id: 7, status: jobStatus, transfer_started_at: transferStarted } : { value: '1', mail_access_all: 0 },
        run: (...args) => {
          writes.push({ sql, args });
          if (sql.includes("status='running'")) jobStatus = 'running';
          if (sql.includes('finished_at=?')) { if (commitFailure) throw Error('db write failed'); jobStatus = args[0]; }
          if (sql.includes('transfer_started_at=?')) {
            if (startWriteFailure) throw Error('start write failed');
            transferStarted = args[3];
          }
          if (sql.includes("stage='blocked'")) { jobStatus = 'queued'; nextAttemptAt = args[0]; }
          return { changes: 1 };
        }, all: () => [] };
    } } },
    './job-store': { hasActiveJob: () => !!jobStatus && ['queued', 'running'].includes(jobStatus), findNextQueuedJob: () => {
      if (queueReadFailure) throw new Error('database unavailable');
      return jobStatus === 'queued' && !nextAttemptAt ? { id: 9, account_id: 7 } : null;
    }, getJobForAccount: () => jobStatus ? { id: 9, account_id: 7, status: jobStatus } : null,
      enqueueJob: () => { if (jobStatus) return { ok: false, reason: 'already_running' }; state.enqueued++; jobStatus = 'queued'; return { ok: true, jobId: 9 }; } },
    './account-imap-probe': { ...realRequire('./account-imap-probe'), runAccountImapProbe: probe || (async () => ({ ok: true })) },
    './credentials': credentials,
    './imapsync-auth': { applySourceAuthentication: (args, a) => realRequire('./imapsync-auth').applySourceAuthentication(args, a, { credentials }) },
    './resource-limits': { syncDiskCapacity: capacity, integerSetting: () => state.minimum },
    './notifications': { notifySyncFailure: async () => {}, notifySyncRecovery: async () => {} },
    './network-policy': { assertSecureAccountEndpoint: () => {}, assertPublicImapHost: dns || (async () => [{ address: '93.184.216.34', family: 4 }]) },
    './providers': { getProvider: () => ({}) },
    './config': { localDovecot: () => ({ ...local }) },
    './maintenance-lock': { current: () => null },
    './state-lock': { stateWritesBlocked: () => state.blocked, withStateLock: (_root, work) => work() },
    './capped-log': { createCappedLog: () => { state.openedLogs++; const stream = new EventEmitter(); stream.write = () => {}; stream.end = () => { stream.closed = true; stream.emit('close'); }; return stream; } },
    fs: { existsSync: () => !cacheFailure, mkdirSync: () => { throw Error('EACCES'); } },
    child_process: { spawn: (command, args, options) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 123;
      child.stdin = Object.assign(new EventEmitter(), { end(data) { child.gate = data; }, destroy() { child.gateDestroyed = true; } });
      child.signals = []; child.kill = signal => { child.signals.push(signal); return true; };
      spawned.push({ command, args, options, child }); return child;
    } },
  };
  const context = { require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : realRequire(name), module: { exports: {} },
    process: { ...process, platform }, Buffer, AbortController, AbortSignal, __dirname: path.dirname(filename), setTimeout, clearTimeout,
    Date: class extends Date { static now() { return state.nowMilliseconds ?? Date.now(); } },
    setInterval: captureIntervals ? callback => { intervals.push(callback); return { unref() {} }; } : setInterval,
    clearInterval: captureIntervals ? () => {} : clearInterval, setImmediate,
    console: { log() {}, warn() {}, error: (...items) => logs.push(items.join(' ')) } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { sync: context.module.exports, spawned, logs, writes, intervals, account, local, state, status: () => jobStatus };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('read-only probe reserves a shared slot before network work and never starts imapsync', async () => {
  let complete;
  const f = fixture({ probe: (account, { mode }) => new Promise(resolve => {
    assert.equal(account.id, 7); assert.equal(mode, 'plan'); complete = resolve;
  }) });
  const first = f.sync.testConnection(7, { mode: 'plan' });
  assert.equal(f.sync.currentConnectionTestCount(), 1);
  assert.equal((await f.sync.testConnection(7)).category, 'busy');
  complete({ ok: true }); assert.equal((await first).ok, true);
  assert.equal(f.sync.currentConnectionTestCount(), 0);
  assert.equal(f.spawned.length, 0);
});

test('shutdown aborts the read-only probe and waits for its cleanup', async () => {
  let release, aborted = false;
  const f = fixture({ probe: (_account, { signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; release = () => resolve({ ok: false }); }, { once: true });
  }) });
  const result = f.sync.testConnection(7);
  let finished = false;
  const stopped = f.sync.shutdownGracefully().then(() => { finished = true; });
  await tick(); assert.equal(finished, false); assert.equal(aborted, true);
  release(); await stopped;
  assert.equal((await result).ok, false);
  assert.equal(f.sync.currentConnectionTestCount(), 0);
  assert.equal(f.spawned.length, 0);
});

test('cache failure marks a queued sync failed and releases its account lock', async () => {
  const f = fixture({ cacheFailure: true, queued: true });
  f.sync.drainQueue(); await tick(); await tick();
  assert.equal(f.status(), 'failed'); assert.equal(f.sync.isAccountLocked(7), false); assert.equal(f.spawned.length, 0);
});

test('database failure after process exit releases shutdown waiters without throwing', async () => {
  const f = fixture({ queued: true, commitFailure: true }); f.sync.drainQueue(); await tick();
  const stopped = f.sync.shutdownGracefully();
  f.spawned[0].child.emit('close', 0); await stopped;
  assert.equal(f.sync.currentRunningCount(), 0);
  assert.ok(f.logs.some(line => line.includes('任务结果写入失败')));
});

test('queue read failure from a background drain is contained and pauses new work', () => {
  const f = fixture({ queueReadFailure: true });
  assert.doesNotThrow(() => f.sync.drainQueue());
  assert.ok(f.logs.some(line => line.includes('队列读取失败')));
  const count = f.logs.length;
  f.sync.drainQueue(); assert.equal(f.logs.length, count);
});

test('an actual imapsync authentication failure is persisted as a retry category', async () => {
  const f = fixture({ queued: true }); f.sync.drainQueue(); await tick();
  f.spawned[0].child.stderr.emit('data', Buffer.from('AUTHENTICATIONFAILED invalid credentials\n'));
  f.spawned[0].child.emit('close', 1); await tick();
  const update = f.writes.find(item => item.sql.includes('last_sync_category=?'));
  assert.ok(update); assert.equal(update.args[1], 'failed'); assert.equal(update.args[3], 'auth_failed');
});

test('capacity-pending sync reserves concurrency, supports cancellation and cannot spawn after shutdown', async () => {
  let release;
  const cancelled = fixture({ queued: true, capacity: () => new Promise(resolve => { release = resolve; }) });
  cancelled.sync.drainQueue(); cancelled.sync.drainQueue();
  assert.equal(cancelled.sync.currentRunningCount(), 1);
  assert.equal((await cancelled.sync.testConnection(7)).category, 'busy');
  assert.equal(cancelled.sync.cancelJob(9, 7).ok, true);
  release({ ok: true, availableMb: 2048 });
  await tick(); await tick();
  assert.equal(cancelled.status(), 'cancelled');
  assert.equal(cancelled.spawned.length, 0);
  const closing = fixture({ queued: true, capacity: () => new Promise(resolve => { release = resolve; }) });
  closing.sync.drainQueue();
  const stopped = closing.sync.shutdownGracefully();
  release({ ok: true, availableMb: 2048 });
  await stopped;
  assert.equal(closing.spawned.length, 0);
  assert.equal(closing.sync.currentRunningCount(), 0);
});

test('sync admission rechecks authorization, account/target changes and current reserve after capacity completes', async () => {
  for (const change of ['account', 'target', 'reserve', 'authorization']) {
    let release;
    const f = fixture({ capacity: () => new Promise(resolve => { release = resolve; }) });
    let allowed = true;
    const pending = f.sync.triggerSync(7, { authorize: () => { if (!allowed) throw Object.assign(Error('revoked'), { statusCode: 401 }); } });
    if (change === 'account') f.account.owner_user_id = 99;
    if (change === 'target') f.local.port = 1993;
    if (change === 'reserve') f.state.minimum = 4096;
    if (change === 'authorization') allowed = false;
    release({ ok: true, availableMb: 2048 });
    if (change === 'authorization') await assert.rejects(pending, { statusCode: 401 });
    else assert.equal((await pending).reason, change === 'reserve' ? 'low_disk' : 'configuration_changed');
    assert.equal(f.state.enqueued, 0);
    assert.equal(f.spawned.length, 0);
  }
});

test('simultaneous sync admissions create a single job after awaiting capacity', async () => {
  const releases = [];
  let calls = 0;
  const f = fixture({ capacity: () => ++calls <= 2 ? new Promise(resolve => releases.push(resolve)) : Promise.resolve({ ok: true, availableMb: 2048 }) });
  const first = f.sync.triggerSync(7), second = f.sync.triggerSync(7);
  releases.forEach(resolve => resolve({ ok: true, availableMb: 2048 }));
  const outcomes = await Promise.all([first, second]);
  assert.equal(outcomes.filter(item => item.ok).length, 1);
  assert.equal(f.state.enqueued, 1);
  await tick();
  const stopped = f.sync.shutdownGracefully();
  if (f.spawned[0]) f.spawned[0].child.emit('close', 0);
  await stopped;
});

test('running disk checks do not overlap and ignore a late failure after the job exits', async () => {
  let calls = 0, release;
  const f = fixture({ queued: true, captureIntervals: true,
    capacity: async () => ++calls <= 2 ? { ok: true, availableMb: 2048 } : new Promise(resolve => { release = resolve; }) });
  f.sync.drainQueue(); await tick();
  const checking = f.intervals[0]();
  await f.intervals[0]();
  assert.equal(calls, 3);
  f.spawned[0].child.emit('close', 0);
  release({ ok: false, availableMb: null });
  await checking; await tick();
  assert.equal(f.spawned[0].child.signals.length, 0);
  assert.equal(f.sync.currentRunningCount(), 0);
});

test('running sync retries temporarily busy capacity checks but terminates on confirmed failure', async () => {
  let calls = 0, priority;
  const f = fixture({ queued: true, captureIntervals: true,
    capacity: async (_db, _dirs, _local, options) => {
      priority = options.priority;
      return ++calls <= 2 ? { ok: true, availableMb: 2048 } : calls <= 4
        ? { ok: false, status: 'busy', availableMb: null } : { ok: false, status: 'unavailable', availableMb: null };
    } });
  f.sync.drainQueue(); await tick();
  await f.intervals[0](); await f.intervals[0]();
  assert.equal(priority, 2); assert.equal(f.spawned[0].child.signals.length, 0);
  await f.intervals[0](); assert.ok(f.spawned[0].child.signals.includes('SIGTERM'));
  f.spawned[0].child.emit('close', 1); await f.sync.shutdownGracefully();
});

test('a running sync stops after fifteen seconds without capacity confirmation even if probes remain busy', async () => {
  let calls = 0;
  const f = fixture({ queued: true, captureIntervals: true, capacity: async () => ++calls <= 2
    ? { ok: true, availableMb: 2048 } : { ok: false, status: 'busy', availableMb: null } });
  f.state.nowMilliseconds = Date.now(); f.sync.drainQueue(); await tick();
  f.state.nowMilliseconds += 14000; await f.intervals[0](); assert.equal(f.spawned[0].child.signals.length, 0);
  f.state.nowMilliseconds += 1001; await f.intervals[0](); assert.ok(f.spawned[0].child.signals.includes('SIGTERM'));
  f.spawned[0].child.emit('close', 1); await f.sync.shutdownGracefully();
});


test('a pause saved during async admission stops the scheduler and keeps manual syncing available', async () => {
  let release;
  let first = true;
  const f = fixture({ capacity: () => first ? (first = false, new Promise(resolve => { release = resolve; }))
    : Promise.resolve({ ok: true, availableMb: 2048 }) });
  f.account.enabled = 1;
  const pending = f.sync.triggerSync(7, { enabledOnly: true });
  const pausedUntil = new Date(Date.now() + 60_000).toISOString();
  f.account.sync_paused_until = pausedUntil;
  release({ ok: true, availableMb: 2048 });
  const deferred = await pending;
  assert.equal(deferred.block.code, 'account_paused');
  assert.equal(deferred.nextRetryAt, pausedUntil);
  assert.equal(f.state.enqueued, 0);
  assert.equal((await f.sync.triggerSync(7)).ok, true);
  await tick();
  assert.equal(f.spawned.length, 1);
  f.spawned[0].child.emit('close', 0);
});

test('an unknown mirror transfer requires an explicit confirmation before manual admission', async () => {
  const f = fixture();
  f.account.enabled = 1;
  f.account.deletion_mode = 'mirror_messages';
  f.account.sync_result_unknown = 1;
  assert.equal((await f.sync.triggerSync(7, { enabledOnly: true })).reason, 'confirm_unknown_result');
  assert.equal((await f.sync.triggerSync(7)).reason, 'confirm_unknown_result');
  assert.equal(f.state.enqueued, 0);
  assert.equal((await f.sync.triggerSync(7, { confirmUnknown: true })).ok, true);
  await tick();
  assert.equal(f.spawned.length, 1);
  f.spawned[0].child.emit('close', 0);
});


test('Linux grants an imapsync launch only after durable process registration', async () => {
  const healthy = fixture({ queued: true, platform: 'linux' });
  healthy.sync.drainQueue(); await tick();
  const started = healthy.spawned[0];
  assert.equal(started.command, '/bin/sh');
  assert.match(started.args[1], /read -r gate.*exec imapsync/);
  assert.equal(started.child.gate, 'start\n');
  started.child.emit('close', 0);
  const fault = fixture({ queued: true, platform: 'linux', startWriteFailure: true });
  fault.sync.drainQueue(); await tick();
  const waiting = fault.spawned[0].child;
  assert.equal(waiting.gate, undefined);
  assert.equal(waiting.gateDestroyed, true);
  assert.deepEqual(waiting.signals, ['SIGTERM']);
  assert.equal(fault.sync.syncQueueHealth().degraded, true);
  waiting.emit('close', 1);
  await fault.sync.shutdownGracefully();
});


test('sync rechecks the mount after DNS and defers without opening a log or starting imapsync', async () => {
  const probes = [];
  const f = fixture({ queued: true, capacity: async (_db, _dirs, _local, opts) => {
    probes.push(opts.fresh);
    return opts.fresh ? { ok: false, code: 'capacity_unavailable', failure: 'mount_changed', availableMb: null, scope: 'global' }
      : { ok: true, availableMb: 4096, minimumMb: 512 };
  } });
  f.sync.drainQueue(); await tick(); await tick();
  assert.deepEqual(probes, [false, true]);
  assert.equal(f.status(), 'queued');
  assert.equal(f.state.openedLogs, 0);
  assert.equal(f.spawned.length, 0);
  const block = f.writes.find(item => item.sql.includes("stage='blocked'"));
  assert.equal(block.args[1], 'capacity_unavailable');
  assert.equal(f.sync.isAccountLocked(7), false);
});
