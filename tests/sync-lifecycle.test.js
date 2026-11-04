const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function fixture({ dns, cacheFailure = false, queued = false, commitFailure = false, queueReadFailure = false } = {}) {
  const filename = path.join(__dirname, '../server/sync.js');
  const realRequire = createRequire(filename);
  const spawned = [], logs = [];
  const account = { id: 7, owner_user_id: 2, host: 'mail.example', port: 993, ssl: 1, username: 'fixture', auth_type: 'password', local_user: 'mailuser', destination_mode: 'subfolder', mailbox_folder: 'U2-A7' };
  let jobStatus = queued ? 'queued' : null;
  const credentials = { resolveTargetPassPath: () => '/data/target.pass', sourcePassPath: () => '/data/source.pass', hasSourceSecret: () => true, hasOAuthTokens: () => true };
  const dependencies = {
    './db': { DIRS: { root: '/data', cache: '/cache', logs: '/logs', tmp: '/tmp' }, db: { prepare(sql) {
      return { get: () => sql.includes('FROM accounts') ? account : { value: '1', mail_access_all: 0 },
        run: (...args) => {
          if (sql.includes("status='running'")) jobStatus = 'running';
          if (sql.includes('finished_at =')) { if (commitFailure) throw Error('db write failed'); jobStatus = args[0]; }
          return {};
        }, all: () => [] };
    } } },
    './job-store': { hasActiveJob: () => !!jobStatus && ['queued', 'running'].includes(jobStatus), findNextQueuedJob: () => {
      if (queueReadFailure) throw new Error('database unavailable');
      return jobStatus === 'queued' ? { id: 9, account_id: 7 } : null;
    } },
    './credentials': credentials,
    './imapsync-auth': { applySourceAuthentication: (args, a) => realRequire('./imapsync-auth').applySourceAuthentication(args, a, { credentials }) },
    './resource-limits': { syncDiskCapacity: () => ({ ok: true }) },
    './notifications': { notifySyncFailure: async () => {} },
    './network-policy': { assertSecureAccountEndpoint: () => {}, assertPublicImapHost: dns || (async () => [{ address: '93.184.216.34', family: 4 }]) },
    './providers': { getProvider: () => ({}) },
    './config': { localDovecot: () => ({ host: '127.0.0.1', port: 143, user: 'mailuser' }) },
    './maintenance-lock': { current: () => null },
    './state-lock': { stateWritesBlocked: () => false },
    './capped-log': { createCappedLog: () => { const stream = new EventEmitter(); stream.write = () => {}; stream.end = () => { stream.closed = true; stream.emit('close'); }; return stream; } },
    fs: { existsSync: () => !cacheFailure, mkdirSync: () => { throw Error('EACCES'); } },
    child_process: { spawn: (command, args, options) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 123;
      child.signals = []; child.kill = signal => { child.signals.push(signal); return true; };
      spawned.push({ command, args, options, child }); return child;
    } },
  };
  const context = { require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : realRequire(name), module: { exports: {} },
    process, Buffer, __dirname: path.dirname(filename), setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    console: { log() {}, warn() {}, error: (...items) => logs.push(items.join(' ')) } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { sync: context.module.exports, spawned, logs, status: () => jobStatus };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('connection tests reserve capacity before DNS, pin its result, and propagate data directory', async () => {
  let resolveDns;
  const f = fixture({ dns: () => new Promise(resolve => { resolveDns = resolve; }) });
  const first = f.sync.testConnection(7);
  assert.equal(f.sync.currentConnectionTestCount(), 1);
  assert.equal((await f.sync.testConnection(7)).category, 'busy');
  resolveDns([{ address: '93.184.216.34', family: 4 }]); await tick();
  assert.equal(f.spawned.length, 1);
  const { args, options, child } = f.spawned[0];
  assert.equal(args[args.indexOf('--host1') + 1], '93.184.216.34');
  assert.ok(args.includes('SSL_verifycn_name=mail.example'));
  assert.equal(options.env.MAIL_AGG_DATA_DIR, path.resolve('/data'));
  child.emit('close', 0); assert.equal((await first).ok, true);
});

test('shutdown waits for test exit and prevents a DNS-pending test from spawning', async () => {
  const running = fixture(); const result = running.sync.testConnection(7); await tick();
  let finished = false;
  const stopped = running.sync.shutdownGracefully().then(() => { finished = true; });
  await tick(); assert.equal(finished, false);
  assert.ok(running.spawned[0].child.signals.includes('SIGTERM'));
  running.spawned[0].child.emit('close', 0); await stopped;
  assert.equal((await result).ok, false);
  let resolveDns;
  const pending = fixture({ dns: () => new Promise(resolve => { resolveDns = resolve; }) });
  const pendingResult = pending.sync.testConnection(7); const pendingStop = pending.sync.shutdownGracefully();
  resolveDns([{ address: '93.184.216.34', family: 4 }]);
  await pendingStop; assert.equal((await pendingResult).ok, false); assert.equal(pending.spawned.length, 0);
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
