const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function backupFilename(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `mail-aggregator-${stamp}.tar.gz`;
}

function copySecrets(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(sourceDir)) return;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      copySecrets(source, destination);
    } else if (stat.isFile()) {
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, 0o600);
    }
  }
}

function runTar(stageDir, archivePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', archivePath, '-C', stageDir, '.'], {
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar 退出码 ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function buildFileInventory(rootDir, relativeDir = 'data') {
  const start = path.join(rootDir, relativeDir);
  const files = [];
  async function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
        files.push({
          path: relative,
          size: fs.statSync(absolute).size,
          sha256: await hashFile(absolute),
        });
      }
    }
  }
  if (fs.existsSync(start)) await visit(start);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function cleanupStaleBackupWorkdirs(tmpDir, nowMs = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!fs.existsSync(tmpDir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('web-backup-')) continue;
    const target = path.join(tmpDir, entry.name);
    try {
      if (nowMs - fs.statSync(target).mtimeMs < maxAgeMs) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed++;
    } catch (_) {
      // A concurrent or permission-related failure is non-fatal and can be retried next start.
    }
  }
  return removed;
}

async function createBackupBundle({
  db,
  dirs,
  version,
  now = new Date(),
  archiveRunner = runTar,
}) {
  const workDir = fs.mkdtempSync(path.join(dirs.tmp, 'web-backup-'));
  const stageDir = path.join(workDir, 'stage');
  const databaseDir = path.join(stageDir, 'data', 'db');
  const secretsDir = path.join(stageDir, 'data', 'secrets');
  const filename = backupFilename(now);
  const archivePath = path.join(workDir, filename);

  try {
    fs.mkdirSync(databaseDir, { recursive: true, mode: 0o700 });
    const databasePath = path.join(databaseDir, 'mail-aggregator.db');
    if (!db || typeof db.backup !== 'function') {
      throw new Error('当前 SQLite 驱动不支持在线备份');
    }
    await db.backup(databasePath);
    fs.chmodSync(databasePath, 0o600);
    copySecrets(dirs.secrets, secretsDir);

    const files = await buildFileInventory(stageDir);

    const manifest = {
      formatVersion: 1,
      application: 'mail-aggregator',
      applicationVersion: version,
      createdAt: now.toISOString(),
      includes: ['data/db/mail-aggregator.db', 'data/secrets/'],
      excludes: ['Maildir', 'cache', 'logs', 'tmp', 'restore-points', 'session.secret', 'runtime-config'],
      warning: 'Contains plaintext email credentials. Store offline and encrypted.',
      files,
    };
    fs.writeFileSync(
      path.join(stageDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 }
    );

    await archiveRunner(stageDir, archivePath);
    fs.chmodSync(archivePath, 0o600);
    const sha256 = await hashFile(archivePath);
    let cleaned = false;
    return {
      archivePath,
      filename,
      sha256,
      checksumFilename: `${filename}.sha256`,
      checksumText: `${sha256}  ${filename}\n`,
      manifest,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        fs.rmSync(workDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  backupFilename,
  copySecrets,
  runTar,
  hashFile,
  buildFileInventory,
  cleanupStaleBackupWorkdirs,
  createBackupBundle,
};
