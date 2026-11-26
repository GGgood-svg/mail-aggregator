'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { runBounded } = require('./bounded-process');
const { isLocalTarget } = require('./target-transport');
const { configuredMounts, readLinuxMountInfo, readLinuxDirectory } = require('./linux-mounts');

function integerSetting(db, key, fallback, min, max) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  const value = Number(row && row.value);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function accountLimit(db, ownerUserId) {
  const maximum = integerSetting(db, 'max_accounts_per_user', 20, 1, 1000);
  const row = db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE owner_user_id=?').get(ownerUserId);
  return { maximum, count: Number(row && row.count || 0) };
}

const SYNC_USES = new Set(['application', 'database', 'credentials', 'logs', 'cache', 'temporary', 'mail']);
const mountIdFor = value => createHash('sha256').update(`mail-aggregator:volume:${value}`).digest('hex').slice(0, 20);

function capacityResult(db, records, operation = 'sync') {
  const minimumMb = integerSetting(db, 'min_free_disk_mb', 512, 64, 1048576);
  const relevant = record => operation !== 'sync' || record.uses.some(use => SYNC_USES.has(use));
  // Group only positively identified devices. A probe failure remains a separate observation.
  const mounts = new Map();
  for (const record of records) {
    // A read-only bind or missing mount can share the device number of a healthy
    // path. Do not spread that failure to operations that do not depend on the path.
    const key = record.protection ? `guard:${record.protection}`
      : record.device == null ? `path:${record.storage}` : `device:${record.device}`;
    const previous = mounts.get(key);
    if (previous) {
      previous.uses.push(...record.uses.filter(use => !previous.uses.includes(use)));
      if (record.availableMb !== null) previous.availableMb = Math.min(previous.availableMb, record.availableMb);
      if (record.availableInodes !== undefined) previous.availableInodes = previous.availableInodes === undefined
        ? record.availableInodes : Math.min(previous.availableInodes, record.availableInodes);
    } else {
      const { device, protection, ...safe } = record;
      mounts.set(key, { ...safe, uses: [...record.uses], mountId: mountIdFor(key) });
    }
  }
  const results = [...mounts.values()].map(record => {
    const scope = record.uses.every(use => use === 'mail') ? 'account' : 'global';
    const code = record.availableMb === null ? 'capacity_unavailable' : record.availableInodes === 0 ? 'low_inodes'
      : record.availableMb < minimumMb ? 'low_space' : null;
    return { ...record, minimumMb, scope, code, inodeStatus: record.availableInodes === undefined ? 'unknown' : 'available',
      status: code === 'capacity_unavailable' ? 'unavailable' : code ? 'low' : 'ok', ok: code === null };
  });
  const considered = results.filter(relevant);
  const limiting = considered.find(result => result.status === 'low') || considered.find(result => !result.ok)
    || considered.reduce((lowest, item) => !lowest || item.availableMb < lowest.availableMb ? item : lowest, null);
  return limiting ? { ...limiting, observations: results } : unavailableCapacity(db);
}

function statRecord(stats, storage, uses = ['application'], device = null) {
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(availableBytes) || availableBytes < 0) throw new Error('invalid statfs result');
  const availableInodes = Number(stats.files) > 0 ? Number(stats.ffree) : undefined;
  if (availableInodes !== undefined && (!Number.isFinite(availableInodes) || availableInodes < 0)) throw new Error('invalid inode count');
  return { storage, uses, device, availableMb: Math.floor(availableBytes / 1024 / 1024),
    ...(availableInodes === undefined ? {} : { availableInodes }) };
}

function unavailableCapacity(db, status = 'unavailable') {
  return { ok: false, status, code: status === 'busy' ? 'capacity_busy' : 'capacity_unavailable', scope: 'global', observations: [],
    minimumMb: integerSetting(db, 'min_free_disk_mb', 512, 64, 1048576), availableMb: null,
    error: '无法检查存储容量，请检查文件系统、Dovecot helper 或邮件存储挂载点' };
}

async function diskCapacity(db, rootDir, statfs = fs.promises.statfs) {
  try {
    return capacityResult(db, [statRecord(await statfs(rootDir), rootDir)]);
  } catch (_) { return unavailableCapacity(db); }
}

// A bounded number of probes, shared by sync admission, running jobs and health.
// Cache raw observations, never policy decisions: the reserve setting is read
// again after every await. Expired successes are never used on probe failure.
function createCapacityChecker({ run = runBounded, statfs = fs.promises.statfs,
  stat = statfs === fs.promises.statfs ? fs.promises.stat : null,
  identifyDirectory = process.platform === 'linux' && statfs === fs.promises.statfs ? readLinuxDirectory : null,
  readMounts = identifyDirectory ? readLinuxMountInfo : null, env = process.env,
  now = () => Date.now(), ttlMs = 1000, timeoutMs = 5000, maxConcurrent = 2, maxQueue = 8, maxEntries = 64 } = {}) {
  const pending = new Map(), cache = new Map(), queue = [], expectedMounts = new Map();
  let required = null, invalidRequired = false;
  try { required = configuredMounts(env.MAIL_AGG_REQUIRED_MOUNTS); }
  catch (_) { invalidRequired = true; }

  function validateMount(record, observed) {
    const prior = expectedMounts.get(record.binding);
    const current = observed?.get(record.mount);
    const requiredMissing = record.uses.some(use => required?.has(use) && required.get(use) !== current?.point);
    // When known, compare the mounted filesystem, not the fallback path's space.
    // Never learn a replacement from an error; the original volume can return.
    const failure = requiredMissing ? 'mount_required'
      : prior && prior !== current?.signature ? 'mount_changed'
      : observed && record.mount && !current ? 'mount_changed'
      : current?.readOnly ? 'read_only' : null;
    if (!requiredMissing && !prior && current?.point && current.point !== '/') {
      expectedMounts.set(record.binding, current.signature);
    }
    const { binding, mount, ...result } = record;
    return failure ? { ...result, availableMb: null, availableInodes: undefined, failure,
      protection: `${prior || current?.signature || binding}:${failure}` } : result;
  }
  let active = 0, bypasses = 0;
  function drain() {
    while (active < maxConcurrent && queue.length) {
      // Keep running transfers responsive without letting new high-priority
      // work continually overtake an older account or health probe.
      let index = 0;
      if (bypasses < 2) {
        for (let i = 1; i < queue.length; i++) if (queue[i].priority > queue[index].priority) index = i;
      }
      bypasses = index === 0 ? 0 : bypasses + 1;
      const [entry] = queue.splice(index, 1); active++; entry.start();
    }
  }
  async function probe(directories, mailPath, local, helper, signal) {
    const records = await Promise.all(directories.map(async ([directory, uses]) => {
      const binding = `path:${directory}`;
      try {
        const mounted = identifyDirectory ? await identifyDirectory(directory).catch(() => null) : null;
        const [stats, identity] = mounted ? [mounted.stats, mounted.device]
          : await Promise.all([statfs(directory), stat && stat(directory, { bigint: true }).then(result => result.dev)]);
        const device = identity != null && String(identity) !== '0' ? String(identity) : null;
        return { ...statRecord(stats, directory, uses, device), binding, mount: mounted?.mount };
      } catch (_) { return { storage: directory, uses, binding, availableMb: null }; }
    }));
    if (signal.aborted) throw new Error('Capacity probe cancelled');
    if (!mailPath) {
      const unknownMail = { storage: 'Maildir', uses: ['mail'], binding: `mail:${local.user}`, availableMb: null };
      try {
        if (!isLocalTarget(local.host)) throw new Error('Remote storage requires a mounted path');
        const output = await run('sudo', ['-n', helper, 'storage-status', local.user, '--include-device', ...(readMounts ? ['--include-mount'] : [])],
          { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4096, windowsHide: true, signal });
        const values = String(typeof output === 'string' ? output : output.stdout).trim().split(/\s+/);
        const [space, inodes, ...details] = values;
        let device, mount;
        if (values.length < 2 || values.length > 4 || !/^\d+$/.test(space) || !Number.isSafeInteger(Number(space))
          || !(inodes === '-' || /^\d+$/.test(inodes) && Number.isSafeInteger(Number(inodes)))) throw new Error('Invalid helper output');
        for (const value of details) {
          if (!device && /^dev:[1-9]\d{0,29}$/.test(value)) device = value.slice(4);
          else if (readMounts && !mount && /^mnt:[1-9]\d{0,29}$/.test(value)) mount = value.slice(4);
          else throw new Error('Invalid helper output');
        }
        records.push({ ...unknownMail, availableMb: Math.floor(Number(space) / 1024),
          ...(inodes !== '-' && { availableInodes: Number(inodes) }), device, mount });
      } catch (_) { records.push(unknownMail); }
    }
    const observed = readMounts ? await readMounts().catch(() => null) : null;
    if (signal.aborted) throw new Error('Capacity probe cancelled');
    return records.map(record => validateMount(record, observed));
  }
  return async function check(db, dirs, local, { priority = 1, operation = 'sync', fresh = false } = {}) {
    if (invalidRequired) return { ...unavailableCapacity(db), failure: 'mount_config_invalid' };
    const mailPath = env.MAIL_AGG_MAIL_STORAGE_PATH || null;
    const helper = env.MAIL_AGG_DOVECOT_HELPER_PATH || '/usr/local/sbin/mail-aggregator-dovecot-helper';
    const byPath = new Map();
    for (const [path, use] of [[dirs.root, 'application'], [dirs.db, 'database'], [dirs.secrets, 'credentials'],
      [dirs.logs, 'logs'], [dirs.cache, 'cache'], [dirs.tmp, 'temporary'], [dirs.restorePoints, 'restore_points'], [mailPath, 'mail']]) {
      if (path) byPath.set(path, [...(byPath.get(path) || []), use]);
    }
    const directories = [...byPath];
    const key = JSON.stringify([directories, mailPath, local.host, local.port, local.user, helper]);
    const cached = cache.get(key);
    if (cached && (!fresh || !readMounts) && now() - cached.started < ttlMs) return capacityResult(db, cached.records, operation);
    cache.delete(key);
    let entry = pending.get(key);
    if (entry) entry.priority = Math.max(entry.priority, priority);
    if (!entry) {
      if (active >= maxConcurrent && queue.length >= maxQueue) return unavailableCapacity(db, 'busy');
      entry = { priority };
      entry.result = new Promise(resolve => { entry.resolve = resolve; });
      entry.waitTimer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index >= 0) { queue.splice(index, 1); pending.delete(key); entry.resolve({ busy: true }); }
      }, timeoutMs);
      entry.start = () => {
        clearTimeout(entry.waitTimer); entry.started = now();
        const controller = new AbortController();
        let finished = false;
        const finish = records => {
          if (finished) return; finished = true; clearTimeout(entry.timer);
          if (records && now() - entry.started < ttlMs) {
            if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
            cache.set(key, { started: entry.started, records });
          }
          entry.resolve(records);
        };
        entry.timer = setTimeout(() => { controller.abort(); finish(null); }, timeoutMs);
        Promise.resolve().then(() => probe(directories, mailPath, { ...local }, helper, controller.signal))
          .then(finish, () => finish(null)).finally(() => {
            // runBounded does not settle until the child actually closes.
            pending.delete(key); active--; drain();
          });
      };
      pending.set(key, entry); queue.push(entry); drain();
    }
    const records = await entry.result;
    return records?.busy ? unavailableCapacity(db, 'busy') : records ? capacityResult(db, records, operation) : unavailableCapacity(db);
  };
}

const checkCapacity = createCapacityChecker();
const incidentObservations = new WeakMap();
async function syncDiskCapacity(db, dirs, local, options) {
  const result = await checkCapacity(db, dirs, local, options);
  const observed = incidentObservations.get(db) || new Map();
  incidentObservations.set(db, observed);
  const now = Date.now();
  const changed = result.observations.filter(item => {
    const prior = observed.get(item.mountId);
    const measured = item.ok || ['low_space','low_inodes'].includes(item.code);
    return (measured && (!prior || prior.code !== item.code))
      || Boolean(prior?.pending && (!item.ok || now >= prior.nextAt));
  });
  if (changed.length && typeof db.transaction === 'function'
    && ![process.env.MAIL_AGG_UPDATE_JOURNAL, process.env.MAIL_AGG_MANUAL_UPDATE_JOURNAL].some(file => file && fs.existsSync(file))
    && !require('./maintenance-lock').current() && !require('./state-lock').stateWritesBlocked(dirs.root)) {
    try {
      const pending = require('./notifications').recordCapacityObservations(db, { observations: changed }, now);
      for (const item of changed) {
        if (observed.size >= 64 && !observed.has(item.mountId)) observed.delete(observed.keys().next().value);
        observed.set(item.mountId, { code: item.code, pending: pending.has(item.mountId), nextAt: now + 60_000 });
      }
    } catch (_) { /* capacity must still be reported if SQLite cannot save the incident */ }
  }
  return result;
}
module.exports = { integerSetting, accountLimit, diskCapacity, syncDiskCapacity, createCapacityChecker };
