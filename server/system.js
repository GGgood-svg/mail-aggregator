const os = require('os');
const net = require('net');
const { execFile } = require('child_process');
const { db } = require('./db');
const { summarizeScheduler } = require('./scheduler-status');

function checkTcpPort(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function findImapsyncVersion() {
  return new Promise((resolve) => {
    execFile('imapsync', ['--version'], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ available: false, version: null });
        return;
      }
      const out = (stdout || stderr || '').trim();
      const match = out.match(/imapsync\s+([\d.]+)/i);
      resolve({ available: true, version: match ? match[1] : out.split('\n')[0] });
    });
  });
}

function getDiskUsage(mountPoint = '/') {
  return new Promise((resolve) => {
    execFile('df', ['-k', mountPoint], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) {
        resolve(null);
        return;
      }
      const parts = lines[1].split(/\s+/);
      // Filesystem 1K-blocks Used Available Use% Mounted
      const totalKb = parseInt(parts[1], 10);
      const usedKb = parseInt(parts[2], 10);
      const availKb = parseInt(parts[3], 10);
      resolve({
        totalMb: Math.round(totalKb / 1024),
        usedMb: Math.round(usedKb / 1024),
        availMb: Math.round(availKb / 1024),
        usePercent: parts[4],
      });
    });
  });
}

async function getSystemStatus(localImapHost, localImapPort, schedulerStatus) {
  const [dovecotUp, imapsync, disk] = await Promise.all([
    checkTcpPort(localImapHost, localImapPort),
    findImapsyncVersion(),
    getDiskUsage('/'),
  ]);

  const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
  const load = os.loadavg();

  return {
    dovecot: {
      ok: dovecotUp,
      host: localImapHost,
      port: localImapPort,
    },
    imapsync,
    scheduler: summarizeScheduler(schedulerStatus),
    disk,
    memory: {
      totalMb: totalMemMb,
      freeMb: freeMemMb,
      usedMb: totalMemMb - freeMemMb,
    },
    cpu: {
      cores: os.cpus().length,
      loadavg1: load[0].toFixed(2),
      loadavg5: load[1].toFixed(2),
    },
  };
}

function getAccountStats() {
  const total = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
  const ok = db
    .prepare("SELECT COUNT(*) c FROM accounts WHERE last_sync_status = 'success'")
    .get().c;
  const failed = db
    .prepare("SELECT COUNT(*) c FROM accounts WHERE last_sync_status IN ('failed', 'timed_out')")
    .get().c;
  const running = db
    .prepare(
      `SELECT COUNT(*) c FROM sync_jobs WHERE status = 'running'`
    )
    .get().c;
  const queued = db
    .prepare(
      `SELECT COUNT(*) c FROM sync_jobs WHERE status = 'queued'`
    )
    .get().c;
  return { total, ok, failed, running, queued };
}

function findDovecotVersion() {
  return new Promise((resolve) => {
    execFile('dovecot', ['--version'], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ available: false, version: null });
        return;
      }
      const out = (stdout || stderr || '').trim().split('\n')[0];
      resolve({ available: true, version: out });
    });
  });
}

function compatibilityForDovecot(version) {
  const match = String(version || '').match(/(\d+)\.(\d+)/);
  if (!match) return { code: 'unknown', label: 'Unknown', automaticUpgrade: false };
  const major = `${match[1]}.${match[2]}`;
  if (major === '2.3') return { code: 'supported', label: 'Supported', automaticUpgrade: true, adapter: '2.3' };
  if (major === '2.4') return { code: 'major_migration', label: 'Major Migration', automaticUpgrade: false };
  return { code: 'unknown', label: 'Unknown', automaticUpgrade: false };
}

function packageCandidate(command, args, pattern) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const match = String(stdout).match(pattern);
      resolve(match ? match[1].trim() : null);
    });
  });
}

async function getUpdateStatus() {
  const [dovecot, imapsync] = await Promise.all([findDovecotVersion(), findImapsyncVersion()]);
  const isAlpine = fsExists('/etc/alpine-release');
  const [dovecotRepo, imapsyncRepo] = isAlpine
    ? await Promise.all([
        packageCandidate('apk', ['policy', 'dovecot'], /dovecot-([^\s]+)/),
        packageCandidate('apk', ['policy', 'imapsync'], /imapsync-([^\s]+)/),
      ])
    : await Promise.all([
        packageCandidate('apt-cache', ['policy', 'dovecot-imapd'], /Candidate:\s*([^\s]+)/),
        packageCandidate('apt-cache', ['policy', 'imapsync'], /Candidate:\s*([^\s]+)/),
      ]);
  return {
    checkedAt: new Date().toISOString(),
    dovecot: { installed: dovecot.version, repository: dovecotRepo, official: null, compatibility: compatibilityForDovecot(dovecot.version) },
    imapsync: { installed: imapsync.version, repository: imapsyncRepo, official: null, minimum: '2.290' },
    officialCheck: { available: false, message: '官方版本检查尚未配置；本地系统仓库状态仍可用。' },
  };
}

function fsExists(file) {
  try { return require('fs').existsSync(file); } catch (_) { return false; }
}

function findNpmVersion() {
  return new Promise((resolve) => {
    execFile('npm', ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function getAlpineVersion() {
  try {
    const fs = require('fs');
    if (fs.existsSync('/etc/alpine-release')) {
      return fs.readFileSync('/etc/alpine-release', 'utf8').trim();
    }
  } catch (e) {
    // 不是Alpine,或者没权限读,不当致命错误
  }
  return null;
}

async function getExtendedSystemInfo(localImapHost, localImapPort) {
  const [dovecotVersion, npmVersion, imapsync, dovecotReachable] = await Promise.all([
    findDovecotVersion(),
    findNpmVersion(),
    findImapsyncVersion(),
    checkTcpPort(localImapHost, localImapPort),
  ]);

  let runningUser = 'unknown';
  try {
    runningUser = os.userInfo().username;
  } catch (e) {
    // 部分受限环境下userInfo可能拿不到,不当致命错误
  }

  return {
    alpineVersion: getAlpineVersion(),
    kernel: os.release(),
    arch: os.arch(),
    nodeVersion: process.version,
    npmVersion,
    imapsync,
    dovecot: { ...dovecotVersion, reachable: dovecotReachable, host: localImapHost, port: localImapPort },
    runningUser,
    memory: {
      totalMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMb: Math.round(os.freemem() / 1024 / 1024),
    },
    cpu: { cores: os.cpus().length, loadavg: os.loadavg().map((n) => n.toFixed(2)) },
  };
}

module.exports = {
  getSystemStatus,
  getAccountStats,
  checkTcpPort,
  findImapsyncVersion,
  findDovecotVersion,
  getExtendedSystemInfo,
  getUpdateStatus,
  compatibilityForDovecot,
};
