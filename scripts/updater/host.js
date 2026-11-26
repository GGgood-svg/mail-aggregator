'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { call } = require('./rpc');
const { readWebConfig } = require('./web-config');
const { withHostLock } = require('./lock');
const { extract, MAX_EXPANDED } = require('./archive');
const { ensure, UpdateError, MiB, MAX_BUNDLE, download, PLATFORM } = require('./release');
const { flushDirectory, writeJson, json, remove, transaction } = require('./transaction');
const exec = promisify(execFile);
const cmd = { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, timeout: 30000, maxBuffer: 65536 };
const paths = {
  installed: '/opt/mail-aggregator', stage: '/opt/mail-aggregator.update-stage', previous: '/opt/mail-aggregator.update-previous',
  state: '/var/lib/mail-aggregator-updater', journal: '/var/lib/mail-aggregator-updater/journal.json',
  manualGate: '/var/lib/mail-aggregator-updater/manual-gate', permit: '/run/mail-aggregator-updater/start-permit',
  snapshot: '/var/lib/mail-aggregator-updater/rollback.db', bundle: '/var/lib/mail-aggregator-updater/staged.tar.gz',
  key: '/etc/mail-aggregator/update-public.pem', enabled: '/etc/mail-aggregator/enable-app-updates',
  socket: '/run/mail-aggregator-updater/rpc.sock', control: '/run/mail-aggregator-update-app/control.sock',
  lock: '/run/mail-aggregator-maintenance/lock', data: '/var/lib/mail-aggregator',
};
function exists(p) { return fsp.lstat(p).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e)); }
async function service(action, unit = 'mail-aggregator') { return exec('/sbin/rc-service', [unit, action], cmd); }
async function running() { return service('status').then(() => true, () => false); }
async function localSupport() {
  const release = await fsp.readFile('/etc/alpine-release', 'utf8').catch(() => '');
  return process.platform === 'linux' && process.arch === 'x64' && process.versions.node.startsWith('24.') && /^3\.24(?:\.|\s|$)/.test(release)
    && await exists('/sbin/rc-service');
}
async function identity() {
  const [uid, gid] = await Promise.all(['-u', '-g'].map(flag => exec('/usr/bin/id', [flag, 'mailadmin'], cmd).then(({ stdout }) => +stdout.trim())));
  ensure(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0, 'invalid_service_identity');
  return { uid, gid };
}
async function childData(action, folder, identity, { input, output, version, config } = {}) {
  const child = spawn('/usr/bin/node', [path.join(__dirname, 'data.js'), action, folder, ...(version ? [version] : [])], {
    ...identity, env: { ...cmd.env, ...(config && { UPDATE_WEB_CONFIG: JSON.stringify(config) }) }, stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'ignore', 'ignore'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), action === 'snapshot' || action === 'restore' ? 180000 : 15000);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new UpdateError(`${action}_failed`)));
  });
  try {
    await Promise.all([done, ...(input ? [pipeline(fs.createReadStream(input), child.stdin)] : []),
      ...(output ? [pipeline(child.stdout, fs.createWriteStream(output, { flags: 'wx', mode: 0o600 }))] : [])]);
  } catch (e) { child.kill('SIGKILL'); await done.catch(() => {}); throw e; }
  finally { clearTimeout(timer); }
}
const maintenance = work => withHostLock(paths.lock, work);
async function capacity({ staging = false } = {}) {
  const db = path.join(paths.data, 'db/mail-aggregator.db');
  const sizes = await Promise.all([db, `${db}-wal`].map(p => fsp.lstat(p, { bigint: true }).catch(e => {
    if (p !== db && e.code === 'ENOENT') return null;
    throw e;
  })));
  ensure(sizes.every(s => !s || s.isFile()), 'invalid_local_config');
  const snapshot = sizes.reduce((sum, item) => sum + (item?.size || 0n), 0n) * 2n + BigInt(64 * MiB);
  const mounts = new Map();
  for (const [dir, bytes, inodes] of [
    ['/opt', staging ? BigInt(MAX_EXPANDED) : 0n, staging ? 40010n : 16n],
    [paths.state, snapshot + (staging ? BigInt(MAX_BUNDLE) : 0n), 16n],
    [paths.data, snapshot, 16n],
    [path.dirname(db), snapshot, 16n],
    ['/var/log', BigInt(16 * MiB), 4n],
  ]) {
    const { dev } = await fsp.stat(dir, { bigint: true });
    const need = mounts.get(dev) || { dir, bytes: 0n, inodes: 0n };
    need.bytes += bytes; need.inodes += inodes;
    mounts.set(dev, need);
  }
  for (const { dir, bytes, inodes } of mounts.values()) {
    const stat = await fsp.statfs(dir, { bigint: true });
    ensure(stat.bavail * stat.bsize >= bytes && stat.ffree >= inodes, 'insufficient_capacity');
  }
}
async function webConfig() {
  try {
    // Native OpenRC overrides are accepted for manual operation, but an
    // automatic cutover cannot assume arbitrary conf.d shell settings.
    if (await exists('/etc/conf.d/mail-aggregator')) throw new Error('OpenRC overrides require manual update');
    return readWebConfig();
  } catch (error) { throw new UpdateError('invalid_local_config'); }
}

async function createHost(record) {
  const user = await identity();
  const bootId = (await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const probe = () => call(paths.control, { op: 'probe' }, 3000);
  async function waitUntil(predicate, ms, code) {
    const limit = Date.now() + ms;
    do {
      try { if (await predicate()) return; } catch (_) { /* starting/stopping */ }
      await new Promise(resolve => setTimeout(resolve, 350));
    } while (Date.now() < limit);
    throw new UpdateError(code);
  }
  async function stop({ boot = false } = {}) {
    // Live recovery must clear a crashed OpenRC instance and its pidfile.
    // Boot recovery runs inside OpenRC before Web may start. It checks the
    // process lock without invoking another service action in that dependency.
    if (!boot) await service('stop');
    const tree = await exists(paths.installed) ? paths.installed : paths.previous;
    await waitUntil(async () => {
      if (!boot && await running()) return false;
      const active = await probe().then(() => true, () => false);
      if (active) return false;
      await childData('stopped', tree, user);
      return true;
    }, 20000, 'stop_failed');
  }
  const tx = transaction({
    read: () => json(paths.journal), publish: state => writeJson(paths.journal, { ...state, bootId: state.bootId || bootId }), clear: () => remove(paths.journal), record,
    async idle(from) {
      const live = await probe().catch(() => null);
      return live?.version === from && live.paused && live.ready && live.idle;
    },
    stop,
    async snapshot() {
      await capacity();
      await remove(paths.snapshot);
      await childData('snapshot', paths.installed, user, { output: paths.snapshot });
      const snap = await fsp.open(paths.snapshot, 'r');
      try { await snap.sync(); } finally { await snap.close(); }
      await flushDirectory(paths.state);
    },
    async swap() {
      // Preserve the last known good tree until the new one has passed probing.
      await fsp.rename(paths.installed, paths.previous);
      await flushDirectory('/opt');
      await fsp.rename(paths.stage, paths.installed);
      await flushDirectory('/opt');
    },
    async restore(record) {
      if (!(await exists(paths.previous))) {
        const meta = await json(path.join(paths.installed, 'package.json'));
        ensure(meta?.version === record.from, 'rollback_tree_missing');
        return;
      }
      if (await exists(paths.installed)) {
        await fsp.rename(paths.installed, paths.stage);
        await flushDirectory('/opt');
      }
      await childData('restore', paths.previous, user, { input: paths.snapshot });
      await fsp.rename(paths.previous, paths.installed);
      await flushDirectory('/opt');
    },
    async startAndProbe(version) {
      if (!(await running())) {
        await exec('/sbin/rc-service', ['--ifcrashed', 'mail-aggregator', 'stop'], cmd);
        await writeJson(paths.permit, { version });
        try { await service('start'); }
        finally { await remove(paths.permit); }
      }
      await waitUntil(async () => {
        const live = await probe();
        return live.version === version && live.ready && live.paused;
      }, 30000, 'readiness_failed');
    },
  });
  return {
    user, tx, bootId, running,
    confirmRunning: version => waitUntil(async () => {
      const live = await probe();
      return live.version === version && live.ready;
    }, 60000, 'readiness_failed'),
    async preflight(manifest) {
      await capacity();
      await childData('preflight', paths.stage, user, { version: manifest.tag.slice(1), config: await webConfig() });
    },
    async prepare(manifest, downloadOptions) {
      await capacity({ staging: true });
      const config = await webConfig();
      // Only retire a previous successful tree before a fresh journal exists.
      await fsp.rm(paths.previous, { recursive: true, force: true });
      await flushDirectory('/opt');
      await remove(paths.bundle);
      await fsp.rm(paths.stage, { recursive: true, force: true });
      await download(manifest, paths.bundle, downloadOptions);
      try {
        await extract(paths.bundle, paths.stage);
        await childData('preflight', paths.stage, user, { version: manifest.tag.slice(1), config });
        await flushDirectory('/opt');
      } finally { await remove(paths.bundle); }
    },
  };
}
module.exports = { paths, exists, localSupport, maintenance, createHost, PLATFORM };
