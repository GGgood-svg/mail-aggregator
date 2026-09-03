const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { createBackupBundle, runTar } = require('../server/backup');
const { normalizeEntryPath, verifyBackupArchive } = require('../server/backup-verifier');

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-verify-test-'));
  const dirs = { tmp: path.join(root, 'tmp'), secrets: path.join(root, 'secrets') };
  fs.mkdirSync(dirs.tmp); fs.mkdirSync(dirs.secrets);
  return { root, dirs };
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('path normalization rejects traversal and absolute paths', () => {
  assert.equal(normalizeEntryPath('./data/db/mail-aggregator.db'), 'data/db/mail-aggregator.db');
  assert.throws(() => normalizeEntryPath('../outside'), /不安全路径/);
  assert.throws(() => normalizeEntryPath('/etc/passwd'), /绝对路径/);
  assert.throws(() => normalizeEntryPath('C:/Windows/file'), /绝对路径/);
});

test('verifier accepts a generated Web backup and its archive checksum', async () => {
  const { root, dirs } = tempRoot();
  let bundle;
  try {
    fs.writeFileSync(path.join(dirs.secrets, 'local-target.pass'), 'secret');
    bundle = await createBackupBundle({
      db: { async backup(destination) { fs.writeFileSync(destination, 'sqlite snapshot'); } },
      dirs,
      version: '0.1.6',
      now: new Date('2026-09-02T03:04:05.000Z'),
    });
    const result = await verifyBackupArchive(bundle.archivePath, bundle.sha256);
    assert.equal(result.ok, true);
    assert.equal(result.archiveSha256, bundle.sha256);
    assert.equal(result.applicationVersion, '0.1.6');
    assert.equal(result.fileCount, 2);
    const checksumPath = `${bundle.archivePath}.sha256`;
    fs.writeFileSync(checksumPath, bundle.checksumText);
    const cli = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'server', 'cli-verify-backup.js'), bundle.archivePath, checksumPath],
      { encoding: 'utf8' }
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /备份验证通过/);
    assert.match(cli.stdout, new RegExp(bundle.sha256));
    await assert.rejects(
      verifyBackupArchive(bundle.archivePath, '0'.repeat(64)),
      /压缩包SHA-256/
    );
  } finally {
    if (bundle) bundle.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifier rejects an archive whose payload does not match the manifest', async () => {
  const { root } = tempRoot();
  try {
    const stage = path.join(root, 'stage');
    const dbDir = path.join(stage, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'mail-aggregator.db'), 'changed database');
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
      formatVersion: 1,
      application: 'mail-aggregator',
      applicationVersion: '0.1.6',
      files: [{
        path: 'data/db/mail-aggregator.db',
        size: Buffer.byteLength('original database'),
        sha256: digest('original database'),
      }],
    }));
    const archive = path.join(root, 'mismatch.tar.gz');
    await runTar(stage, archive);
    await assert.rejects(verifyBackupArchive(archive), /文件校验失败/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifier rejects archive content outside the Web-backup allowlist', async () => {
  const { root } = tempRoot();
  try {
    const stage = path.join(root, 'stage');
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'evil.txt'), 'not allowed');
    const archive = path.join(root, 'unexpected.tar.gz');
    await runTar(stage, archive);
    await assert.rejects(verifyBackupArchive(archive), /非白名单路径/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
