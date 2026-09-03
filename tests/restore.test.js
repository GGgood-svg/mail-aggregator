const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) {}

const {
  inspectRestoreDatabase,
  prepareRestoredSecrets,
  restoreApplicationState,
  cleanupOldRestorePoints,
  cleanupStaleRestoreWorkdirs,
} = require('../server/restore');

const integrationTest = DatabaseSync ? test : test.skip;

function TestDatabase(filename) {
  const database = new DatabaseSync(filename);
  database.pragma = (statement) => database.exec(`PRAGMA ${statement}`);
  database.transaction = (fn) => () => {
    database.exec('BEGIN');
    try {
      const result = fn();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
  return database;
}

function createSchema(database) {
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE admin_users(id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
    CREATE TABLE sessions(sid TEXT PRIMARY KEY, sess TEXT, expires INTEGER);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE accounts(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'custom',
      host TEXT NOT NULL DEFAULT 'imap.test', port INTEGER NOT NULL DEFAULT 993,
      ssl INTEGER NOT NULL DEFAULT 1, username TEXT NOT NULL,
      local_user TEXT NOT NULL DEFAULT 'mailuser', destination_mode TEXT NOT NULL DEFAULT 'flat',
      destination_folder TEXT
    );
    CREATE TABLE sync_jobs(
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, pid INTEGER
    );
    CREATE TABLE notification_events(
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      last_notified_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX unique_folder ON accounts(local_user, destination_folder)
      WHERE destination_mode='subfolder';
  `);
}

function tempEnvironment() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-restore-test-'));
  const currentPath = path.join(root, 'current.db');
  const sourcePath = path.join(root, 'source.db');
  const current = TestDatabase(currentPath);
  const source = TestDatabase(sourcePath);
  createSchema(current);
  createSchema(source);
  const currentSecrets = path.join(root, 'current-secrets');
  const backupSecrets = path.join(root, 'backup-secrets');
  const workDir = path.join(root, 'work');
  fs.mkdirSync(currentSecrets); fs.mkdirSync(backupSecrets); fs.mkdirSync(workDir);
  return { root, currentPath, sourcePath, current, source, currentSecrets, backupSecrets, workDir };
}

integrationTest('restore database inspection verifies integrity and reports safe counts', () => {
  const env = tempEnvironment();
  try {
    env.source.prepare("INSERT INTO settings VALUES('app_name','Backup')").run();
    env.source.prepare("INSERT INTO accounts(id,name,username) VALUES(1,'one','one@test')").run();
    env.source.prepare("INSERT INTO sync_jobs VALUES(1,1,'2026-01-01',NULL,'success',NULL)").run();
    assert.deepEqual(inspectRestoreDatabase(TestDatabase, env.sourcePath), {
      accountCount: 1,
      jobCount: 1,
      settingCount: 1,
    });
  } finally {
    env.current.close(); env.source.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('restored secrets retain the live Dovecot password and drop account target overrides', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-secret-restore-'));
  try {
    const current = path.join(root, 'current');
    const backup = path.join(root, 'backup');
    const prepared = path.join(root, 'prepared');
    fs.mkdirSync(path.join(current, 'accounts', '1'), { recursive: true });
    fs.mkdirSync(path.join(backup, 'accounts', '1'), { recursive: true });
    fs.writeFileSync(path.join(current, 'local-target.pass'), 'current-local');
    fs.writeFileSync(path.join(backup, 'local-target.pass'), 'old-local');
    fs.writeFileSync(path.join(backup, 'accounts', '1', 'source.pass'), 'source-secret');
    fs.writeFileSync(path.join(backup, 'accounts', '1', 'target.pass'), 'old-target');
    const result = prepareRestoredSecrets(backup, current, prepared);
    assert.equal(fs.readFileSync(path.join(prepared, 'local-target.pass'), 'utf8'), 'current-local');
    assert.equal(fs.readFileSync(path.join(prepared, 'accounts', '1', 'source.pass'), 'utf8'), 'source-secret');
    assert.equal(fs.existsSync(path.join(prepared, 'accounts', '1', 'target.pass')), false);
    assert.equal(result.skippedTargetOverrides, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

integrationTest('online restore preserves access and deployment settings while replacing app state', () => {
  const env = tempEnvironment();
  try {
    env.current.exec(`
      INSERT INTO admin_users VALUES(1,'current-admin','hash');
      INSERT INTO sessions VALUES('live','{}',9999999999);
      INSERT INTO settings VALUES('dovecot_user','liveuser');
      INSERT INTO settings VALUES('web_port','8080');
      INSERT INTO settings VALUES('app_name','Current');
      INSERT INTO accounts(id,name,username,local_user) VALUES(9,'current','current@test','liveuser');
    `);
    env.source.exec(`
      INSERT INTO admin_users VALUES(2,'old-admin','old-hash');
      INSERT INTO settings VALUES('dovecot_user','backupuser');
      INSERT INTO settings VALUES('web_port','9999');
      INSERT INTO settings VALUES('app_name','Restored');
      INSERT INTO accounts(id,name,username,local_user) VALUES(1,'restored','restored@test','backupuser');
      INSERT INTO sync_jobs VALUES(2,1,'2026-01-01',NULL,'running',1234);
    `);
    fs.writeFileSync(path.join(env.currentSecrets, 'local-target.pass'), 'live-local');
    fs.mkdirSync(path.join(env.backupSecrets, 'accounts', '1'), { recursive: true });
    fs.writeFileSync(path.join(env.backupSecrets, 'local-target.pass'), 'backup-local');
    fs.writeFileSync(path.join(env.backupSecrets, 'accounts', '1', 'source.pass'), 'backup-source');

    const result = restoreApplicationState({
      Database: TestDatabase,
      currentDb: env.current,
      backupDbPath: env.sourcePath,
      currentSecretsDir: env.currentSecrets,
      backupSecretsDir: env.backupSecrets,
      workDir: env.workDir,
    });
    assert.equal(result.accounts, 1);
    assert.equal(env.current.prepare('SELECT username,local_user FROM accounts').get().username, 'restored@test');
    assert.equal(env.current.prepare('SELECT local_user FROM accounts').get().local_user, 'liveuser');
    assert.equal(env.current.prepare('SELECT status,pid FROM sync_jobs').get().status, 'interrupted');
    assert.equal(env.current.prepare('SELECT status,pid FROM sync_jobs').get().pid, null);
    assert.equal(env.current.prepare("SELECT value FROM settings WHERE key='app_name'").get().value, 'Restored');
    assert.equal(env.current.prepare("SELECT value FROM settings WHERE key='web_port'").get().value, '8080');
    assert.equal(env.current.prepare('SELECT username FROM admin_users').get().username, 'current-admin');
    assert.equal(env.current.prepare('SELECT sid FROM sessions').get().sid, 'live');
    assert.equal(fs.readFileSync(path.join(env.currentSecrets, 'local-target.pass'), 'utf8'), 'live-local');
    assert.equal(fs.readFileSync(path.join(env.currentSecrets, 'accounts', '1', 'source.pass'), 'utf8'), 'backup-source');
  } finally {
    env.current.close(); env.source.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

integrationTest('database commit failure rolls back both database rows and swapped secrets', () => {
  const env = tempEnvironment();
  try {
    env.current.exec(`
      INSERT INTO settings VALUES('dovecot_user','liveuser');
      INSERT INTO accounts(id,name,username,local_user) VALUES(9,'current','current@test','liveuser');
    `);
    env.source.exec(`
      INSERT INTO settings VALUES('app_name','Backup');
      INSERT INTO accounts(id,name,username,local_user) VALUES(1,'restored','restored@test','backupuser');
    `);
    fs.writeFileSync(path.join(env.currentSecrets, 'local-target.pass'), 'live-local');
    fs.writeFileSync(path.join(env.currentSecrets, 'marker'), 'current-secret-tree');
    fs.writeFileSync(path.join(env.backupSecrets, 'source.pass'), 'backup-secret-tree');

    env.current.transaction = (fn) => () => {
      env.current.exec('BEGIN');
      try {
        fn();
        throw new Error('simulated commit failure');
      } catch (error) {
        env.current.exec('ROLLBACK');
        throw error;
      }
    };

    assert.throws(() => restoreApplicationState({
      Database: TestDatabase,
      currentDb: env.current,
      backupDbPath: env.sourcePath,
      currentSecretsDir: env.currentSecrets,
      backupSecretsDir: env.backupSecrets,
      workDir: env.workDir,
    }), /simulated commit failure/);
    assert.equal(env.current.prepare('SELECT username FROM accounts').get().username, 'current@test');
    assert.equal(fs.readFileSync(path.join(env.currentSecrets, 'marker'), 'utf8'), 'current-secret-tree');
    assert.equal(fs.existsSync(path.join(env.currentSecrets, 'source.pass')), false);
  } finally {
    env.current.close(); env.source.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('restore cleanup removes only expired restore artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-restore-cleanup-'));
  try {
    const points = path.join(root, 'points');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(points); fs.mkdirSync(tmp);
    const oldPoint = path.join(points, 'pre-restore-old.tar.gz');
    const keepPoint = path.join(points, 'manual-backup.tar.gz');
    const oldWork = path.join(tmp, 'web-restore-old');
    const keepWork = path.join(tmp, 'other-work');
    fs.writeFileSync(oldPoint, 'x'); fs.writeFileSync(keepPoint, 'x');
    fs.mkdirSync(oldWork); fs.mkdirSync(keepWork);
    const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPoint, old, old); fs.utimesSync(oldWork, old, old);
    assert.equal(cleanupOldRestorePoints(points), 1);
    assert.equal(cleanupStaleRestoreWorkdirs(tmp), 1);
    assert.equal(fs.existsSync(keepPoint), true);
    assert.equal(fs.existsSync(keepWork), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
