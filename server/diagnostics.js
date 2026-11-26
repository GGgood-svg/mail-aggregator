'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runBounded } = require('./bounded-process');
const { hasLegacyRecovery, journalPresent, readRestoreJournal, lastRestoreResult } = require('./restore-journal');
const { lockPath } = require('./state-lock');
const { version: application } = require('../package.json');

const STATUSES = ['ok', 'low', 'busy', 'unavailable'];
const OUTCOMES = ['committed', 'recovered_committed', 'rolled_back'];
const MOUNT_FAILURES = new Set(['read_only', 'mount_changed', 'mount_required']);
const PROBE_TTL = 10_000;

function createProbeCache({ key, probe, now = Date.now, ttl = PROBE_TTL }) {
  let cached, active, generation = 0;
  const current = item => item.generation === generation && item.key === key();

  return {
    invalidate() { generation++; cached = null; },
    async get() {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (cached && current(cached) && now() - cached.at < ttl) return cached.value;
        if (!active) {
          const sampled = { generation, key: key() };
          sampled.result = Promise.resolve().then(probe).then(value => {
            if (current(sampled)) cached = { ...sampled, value, at: now() };
            return value;
          }).finally(() => { active = null; });
          active = sampled;
        }
        const sampled = active;
        try {
          const value = await sampled.result;
          if (current(sampled)) return value;
        } catch (error) { if (current(sampled)) throw error; }
      }
      throw Object.assign(new Error('诊断目标正在变化，请稍后重试'), { statusCode: 503 });
    },
  };
}

function cleanVersion(value) {
  return /^v?(\d{1,3}(?:\.\d{1,6}){1,2})$/.exec(String(value || ''))?.[1] || null;
}

async function programVersion(command) {
  try {
    // The Perl program loads its dependencies even for --version on low-power hosts.
    const imapsync = command === 'imapsync';
    const args = imapsync ? ['--noreleasecheck', '--version'] : ['--version'];
    const { stdout } = await runBounded(command, args, { timeout: imapsync ? 15_000 : 3000, maxBuffer: 4096 });
    const version = String(stdout).trim().match(/^(?:imapsync\s+)?(\d{1,3}(?:\.\d{1,6}){1,2})\b/i);
    return cleanVersion(version?.[1]);
  } catch (_) { return null; }
}

function platformInfo() {
  let release = null;
  if (process.platform === 'linux') {
    try { release = cleanVersion(fs.readFileSync('/etc/alpine-release', 'utf8').trim()); } catch (_) {}
  }
  return { os: release ? 'alpine' : process.platform, release, arch: process.arch };
}

function versions(dovecot, imapsync) {
  return { application: cleanVersion(application), node: cleanVersion(process.version),
    dovecot: cleanVersion(dovecot), imapsync: cleanVersion(imapsync) };
}

function installationProfile(platform, installed) {
  if (!installed.dovecot) return 'unknown';
  if (installed.dovecot.startsWith('2.3.')) return 'legacy_2_3';
  if (platform.os === 'alpine' && platform.release?.startsWith('3.24.') && platform.arch === 'x64' &&
      installed.dovecot.startsWith('2.4.') && installed.node?.startsWith('24.')) return 'alpine_3_24';
  return 'other';
}

function restoreStatus(dirs, db, { offline = false } = {}) {
  let state = 'ready', last = null;
  try {
    if (hasLegacyRecovery(dirs.tmp)) state = 'legacy_recovery';
    else if (journalPresent(dirs.root)) {
      readRestoreJournal(dirs.root, dirs.secrets);
      state = 'pending_recovery';
    } else if (offline && fs.existsSync(lockPath(dirs.root))) state = 'configuration_locked';
  } catch (_) { state = 'invalid_journal'; }
  try {
    const row = db && lastRestoreResult(db);
    if (row && OUTCOMES.includes(row.outcome) && Number.isFinite(Date.parse(row.recorded_at))) {
      last = { outcome: row.outcome, at: new Date(row.recorded_at).toISOString() };
    }
  } catch (_) { if (state === 'ready') state = 'database_unavailable'; }
  return { state, last };
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function storageSummary(capacity, dirs, mailPath) {
  if (!capacity) return { status: 'unavailable', minimumMb: null, observations: [] };
  const known = new Map([[dirs.root, 'application'], [dirs.db, 'database'], [dirs.secrets, 'credentials'],
    [dirs.cache, 'cache'], [dirs.logs, 'logs'], [dirs.tmp, 'temporary'], [dirs.restorePoints, 'restore_points'], ['Maildir', 'mail']]);
  if (mailPath) known.set(mailPath, 'mail');
  const uses = new Set(known.values());
  const codes = new Set(['low_space', 'low_inodes', 'capacity_unavailable', 'capacity_busy']);
  return { status: STATUSES.includes(capacity.status) ? capacity.status : 'unavailable', minimumMb: count(capacity.minimumMb),
    ...(capacity.failure === 'mount_config_invalid' && { failure: capacity.failure }),
    observations: (capacity.observations || []).filter(item => item.storage && known.has(item.storage)).map(item => ({
      storage: known.get(item.storage), availableMb: count(item.availableMb), availableInodes: count(item.availableInodes),
      ...(Array.isArray(item.uses) && { uses: item.uses.filter(use => uses.has(use)),
        ...(typeof item.mountId === 'string' && /^[a-f0-9]{20}$/.test(item.mountId) && { mountId: item.mountId }),
        code: codes.has(item.code) ? item.code : null,
        ...(MOUNT_FAILURES.has(item.failure) && { failure: item.failure }),
        status: STATUSES.includes(item.status) ? item.status : 'unavailable' }),
    })) };
}

function getDiagnosticReport({ dirs, db, installed, capacity, queues = {}, offline = false, databaseAvailable = true }) {
  const platform = platformInfo();
  const safeVersions = versions(installed?.dovecot, installed?.imapsync);
  const restore = restoreStatus(dirs, db, { offline });
  if (restore.state === 'ready' && !databaseAvailable) restore.state = 'database_unavailable';
  return {
    formatVersion: 1,
    checkedAt: new Date().toISOString(),
    mode: offline ? 'offline' : 'live',
    platform,
    versions: safeVersions,
    installationProfile: installationProfile(platform, safeVersions),
    restore,
    storage: storageSummary(capacity, dirs, process.env.MAIL_AGG_MAIL_STORAGE_PATH),
    queues: {
      mailTasks: selectCounts(queues.mailTasks, ['running', 'queued', 'concurrency', 'maxQueue', 'checkingScope']),
      mailParser: selectCounts(queues.mailParser, ['running', 'queued', 'stopping', 'capacity', 'maxQueue']),
      password: selectCounts(queues.password, ['running', 'queued', 'stopping', 'capacity', 'maxQueue']),
      sync: selectCounts(queues.sync, ['running', 'queued']),
    },
  };
}

function selectCounts(source, fields) {
  return source ? Object.fromEntries(fields.map(field => [field, count(source[field])])) : null;
}

function fileRevision(filename) {
  try {
    const stat = fs.statSync(filename, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`;
  } catch (_) { return ''; }
}

async function offlineDiagnostics(dirs) {
  const [dovecot, imapsync, stats] = await Promise.all([programVersion('dovecot'), programVersion('imapsync'),
    fs.promises.statfs(dirs.root).catch(() => null)]);
  let db, databaseAvailable = false;
  try {
    const Database = require('better-sqlite3');
    db = new Database(path.join(dirs.db, 'mail-aggregator.db'), { readonly: true, fileMustExist: true, timeout: 0 });
    databaseAvailable = Boolean(db.prepare('SELECT 1 AS ready').get()?.ready);
  } catch (_) {}
  try {
    // If the service is down we can measure its root, but cannot infer the health of remote mounts.
    const capacity = stats ? { status: 'unavailable', observations: [{ storage: dirs.root,
      availableMb: Math.floor(Number(stats.bavail) * Number(stats.bsize) / 1048576),
      availableInodes: Number(stats.files) > 0 ? Number(stats.ffree) : null,
    }] } : null;
    return getDiagnosticReport({ dirs, db, installed: versions(dovecot, imapsync), capacity, offline: true, databaseAvailable });
  } finally { db?.close(); }
}

module.exports = { createProbeCache, programVersion, versions, getDiagnosticReport, fileRevision, offlineDiagnostics };
