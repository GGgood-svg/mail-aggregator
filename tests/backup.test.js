const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  backupFilename,
  hashFile,
  cleanupStaleBackupWorkdirs,
  createBackupBundle,
} = require('../server/backup');

function createDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-backup-test-'));
  const dirs = {
    root,
    tmp: path.join(root, 'tmp'),
    secrets: path.join(root, 'secrets'),
    logs: path.join(root, 'logs'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return { root, dirs };
}

test('backup filename is deterministic and filesystem-safe', () => {
  assert.equal(
    backupFilename(new Date('2026-09-02T03:04:05.000Z')),
    'mail-aggregator-20260902-030405.tar.gz'
  );
});

test('file hashing returns the standard SHA-256 digest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-hash-test-'));
  try {
    const file = path.join(root, 'value.txt');
    fs.writeFileSync(file, 'abc');
    assert.equal(
      await hashFile(file),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('backup bundle uses an online database snapshot and copies only backup payload', async () => {
  const { root, dirs } = createDirs();
  let bundle;
  try {
    fs.writeFileSync(path.join(dirs.secrets, 'local-target.pass'), 'local-secret');
    fs.mkdirSync(path.join(dirs.secrets, '7'));
    fs.writeFileSync(path.join(dirs.secrets, '7', 'source.pass'), 'source-secret');
    fs.writeFileSync(path.join(dirs.logs, 'job-1.log'), 'must not be included');
    let backupCalls = 0;
    const db = {
      async backup(destination) {
        backupCalls++;
        fs.writeFileSync(destination, 'consistent-snapshot');
      },
    };
    const archiveRunner = async (stageDir, archivePath) => {
      assert.equal(fs.readFileSync(path.join(stageDir, 'data', 'db', 'mail-aggregator.db'), 'utf8'), 'consistent-snapshot');
      assert.equal(fs.readFileSync(path.join(stageDir, 'data', 'secrets', 'local-target.pass'), 'utf8'), 'local-secret');
      assert.equal(fs.readFileSync(path.join(stageDir, 'data', 'secrets', '7', 'source.pass'), 'utf8'), 'source-secret');
      assert.equal(fs.existsSync(path.join(stageDir, 'data', 'logs')), false);
      const manifest = JSON.parse(fs.readFileSync(path.join(stageDir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.formatVersion, 1);
      assert.equal(manifest.applicationVersion, '0.1.6');
      assert.ok(manifest.excludes.includes('Maildir'));
      assert.deepEqual(manifest.files.map((file) => file.path), [
        'data/db/mail-aggregator.db',
        'data/secrets/7/source.pass',
        'data/secrets/local-target.pass',
      ]);
      for (const file of manifest.files) {
        assert.match(file.sha256, /^[a-f0-9]{64}$/);
        assert.ok(file.size > 0);
      }
      fs.writeFileSync(archivePath, 'fake archive');
    };

    bundle = await createBackupBundle({
      db,
      dirs,
      version: '0.1.6',
      now: new Date('2026-09-02T03:04:05.000Z'),
      archiveRunner,
    });
    assert.equal(backupCalls, 1);
    assert.equal(bundle.filename, 'mail-aggregator-20260902-030405.tar.gz');
    assert.match(bundle.sha256, /^[a-f0-9]{64}$/);
    assert.equal(bundle.checksumFilename, `${bundle.filename}.sha256`);
    assert.equal(bundle.checksumText, `${bundle.sha256}  ${bundle.filename}\n`);
    assert.equal(fs.existsSync(bundle.archivePath), true);
    const workDir = path.dirname(bundle.archivePath);
    bundle.cleanup();
    bundle.cleanup();
    assert.equal(fs.existsSync(workDir), false);
  } finally {
    if (bundle) bundle.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('backup failure removes its temporary work directory', async () => {
  const { root, dirs } = createDirs();
  let capturedWorkDir = null;
  try {
    await assert.rejects(
      createBackupBundle({
        db: { async backup(destination) { fs.writeFileSync(destination, 'snapshot'); } },
        dirs,
        version: '0.1.6',
        archiveRunner: async (stageDir) => {
          capturedWorkDir = path.dirname(stageDir);
          throw new Error('archive failed');
        },
      }),
      /archive failed/
    );
    assert.ok(capturedWorkDir);
    assert.equal(fs.existsSync(capturedWorkDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale backup cleanup touches only old web-backup directories', () => {
  const { root, dirs } = createDirs();
  try {
    const oldBackup = path.join(dirs.tmp, 'web-backup-old');
    const recentBackup = path.join(dirs.tmp, 'web-backup-recent');
    const unrelated = path.join(dirs.tmp, 'other-work');
    fs.mkdirSync(oldBackup); fs.mkdirSync(recentBackup); fs.mkdirSync(unrelated);
    const old = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(oldBackup, old, old);
    assert.equal(
      cleanupStaleBackupWorkdirs(dirs.tmp, Date.parse('2026-01-03T00:00:00Z')),
      1
    );
    assert.equal(fs.existsSync(oldBackup), false);
    assert.equal(fs.existsSync(recentBackup), true);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
