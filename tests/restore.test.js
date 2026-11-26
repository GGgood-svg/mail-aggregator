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
  restoreSavedSearches,
  cleanupOldRestorePoints,
  cleanupStaleRestoreWorkdirs,
} = require('../server/restore');
const { notificationConfigStore } = require('../server/notification-config');
const { lastRestoreResult } = require('../server/restore-journal');

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

integrationTest('restore retains deleted-account ownership and keeps unknown owners inaccessible', () => {
  const env = tempEnvironment();
  try {
    for (const database of [env.current, env.source]) database.exec(`
      ALTER TABLE admin_users ADD COLUMN mail_access_all INTEGER DEFAULT 0;
      ALTER TABLE accounts ADD COLUMN owner_user_id INTEGER;
      ALTER TABLE accounts ADD COLUMN mailbox_folder TEXT;
      CREATE TABLE mailbox_ownership(local_user TEXT, mailbox_folder TEXT COLLATE NOCASE,
        owner_user_id INTEGER, former_account_id INTEGER, PRIMARY KEY(local_user,mailbox_folder));
    `);
    env.current.exec("INSERT INTO admin_users VALUES(10,'primary','x',1),(20,'alice','x',0)");
    env.source.exec("INSERT INTO admin_users VALUES(2,'alice','x',0)");
    env.source.exec(`INSERT INTO mailbox_ownership VALUES
      ('mailuser','U2-A7',2,7),('mailuser','Deleted-owner',99,9);
      INSERT INTO accounts(id,name,username,local_user,destination_mode,destination_folder,owner_user_id,mailbox_folder)
      VALUES(1,'active','alice@test','mailuser','subfolder','Active',2,'U2-A1');`);
    restoreApplicationState({ Database: TestDatabase, currentDb: env.current, backupDbPath: env.sourcePath,
      currentSecretsDir: env.currentSecrets, backupSecretsDir: env.backupSecrets, workDir: env.workDir });
    assert.equal(env.current.prepare("SELECT owner_user_id FROM mailbox_ownership WHERE mailbox_folder='U2-A7'").get().owner_user_id, 20);
    assert.equal(env.current.prepare("SELECT owner_user_id FROM mailbox_ownership WHERE mailbox_folder='U2-A1'").get().owner_user_id, 20);
    assert.ok(env.current.prepare("SELECT owner_user_id FROM mailbox_ownership WHERE mailbox_folder='Deleted-owner'").get().owner_user_id < 0);
  } finally {
    env.current.close(); env.source.close(); fs.rmSync(env.root, { recursive: true, force: true });
  }
});

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
      savedSearchCount: 0,
      ruleCount: 0,
    });
  } finally {
    env.current.close(); env.source.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

integrationTest('rules restore by username, cap and validate imports; live tasks are retained but cannot resume', () => {
  const { initializeMailTasks } = require('../server/mail-tasks');
  const env = tempEnvironment();
  try {
    for (const database of [env.current, env.source]) initializeMailTasks(database);
    env.current.exec("INSERT INTO admin_users VALUES(10,'primary','x'),(20,'alice','x'),(30,'local-only','x')");
    env.source.exec("INSERT INTO admin_users VALUES(1,'primary','x'),(2,'alice','x'),(99,'unknown','x')");
    env.current.exec(`INSERT INTO mail_rules(owner_user_id,name,scope,folder,filters_json,action) VALUES
      (20,'replace','folder','A','{}','seen'),(30,'keep','folder','B','{}','star');
      UPDATE mail_rules SET auto_after_job_id=0;
      INSERT INTO mail_tasks(id,owner_user_id,kind,status,spec_json,boundary_ready,created_at) VALUES('live-history',20,'seen_all','interrupted','{}',1,1)`);
    const add = env.source.prepare("INSERT INTO mail_rules(owner_user_id,name,scope,folder,filters_json,action) VALUES(2,?,'folder','A','{}','unseen')");
    for (let i = 0; i < 55; i++) add.run(`Rule ${i}`);
    env.source.exec(`INSERT INTO mail_rules(owner_user_id,name,scope,folder,filters_json,action) VALUES
      (1,'invalid','all',NULL,'{}','seen'),(99,'unknown','folder','B','{}','seen');
      INSERT INTO mail_tasks(id,owner_user_id,kind,status,spec_json,created_at) VALUES('backup-queued',2,'seen_all','queued','{}',1)`);
    const result = restoreApplicationState({ Database: TestDatabase, currentDb: env.current, backupDbPath: env.sourcePath,
      currentSecretsDir: env.currentSecrets, backupSecretsDir: env.backupSecrets, workDir: env.workDir });
    assert.equal(result.rules, 50); assert.equal(result.rulesSkipped, 7); assert.equal(result.rulesPreserved, false);
    assert.equal(env.current.prepare('SELECT COUNT(*) AS n FROM mail_rules WHERE owner_user_id=20').get().n, 50);
    assert.equal(env.current.prepare('SELECT name FROM mail_rules WHERE owner_user_id=30').get().name, 'keep');
    assert.equal(env.current.prepare('SELECT COUNT(*) n FROM mail_rules WHERE auto_after_job_id IS NOT NULL').get().n, 0);
    assert.equal(env.current.prepare("SELECT resumable FROM mail_tasks WHERE id='live-history'").get().resumable, 0);
    assert.equal(env.current.prepare("SELECT * FROM mail_tasks WHERE id='backup-queued'").get(), undefined);
    assert.equal(env.current.prepare('SELECT COUNT(*) AS n FROM mail_tasks').get().n, 1);
  } finally { env.current.close(); env.source.close(); fs.rmSync(env.root, { recursive: true, force: true }); }
});

integrationTest('old backup without rule table preserves current rules', () => {
  const { initializeMailTasks } = require('../server/mail-tasks');
  const { restoreRules } = require('../server/restore');
  const current = TestDatabase(':memory:'), source = TestDatabase(':memory:');
  try {
    current.exec('CREATE TABLE admin_users(id INTEGER PRIMARY KEY)'); initializeMailTasks(current);
    current.exec("INSERT INTO admin_users VALUES(1); INSERT INTO mail_rules(owner_user_id,name,scope,folder,filters_json,action) VALUES(1,'Keep','folder','A','{}','seen')");
    const result = restoreRules(current, source, new Map([[1,1]]));
    assert.equal(result.rulesPreserved, true); assert.equal(current.prepare('SELECT name FROM mail_rules').get().name, 'Keep');
  } finally { current.close(); source.close(); }
});

integrationTest('saved-search restore maps owners by username, preserves unmatched live users, validates and caps imports', () => {
  const env = tempEnvironment();
  try {
    for (const database of [env.current, env.source]) database.exec(`CREATE TABLE saved_searches(
      id INTEGER PRIMARY KEY AUTOINCREMENT,owner_user_id INTEGER REFERENCES admin_users(id) ON DELETE CASCADE,
      name TEXT,scope TEXT,folder TEXT,filters_json TEXT)`);
    env.current.exec("INSERT INTO admin_users VALUES(10,'alice','x'),(20,'bob','x'); INSERT INTO saved_searches VALUES(1,20,'Bob private','all',NULL,'{\"flagged\":\"starred\"}'),(2,10,'Alice old','all',NULL,'{\"seen\":\"unread\"}')");
    env.source.exec("INSERT INTO admin_users VALUES(2,'alice','x'),(10,'unknown','x')");
    const insert = env.source.prepare('INSERT INTO saved_searches(owner_user_id,name,scope,folder,filters_json) VALUES(?,?,?,?,?)');
    insert.run(10, 'Unknown user', 'all', null, '{"flagged":"starred"}');
    insert.run(2, 'Invalid', 'all', null, '{"uid":"1"}');
    for (let i = 0; i < 51; i++) insert.run(2, `Alice ${i}`, 'folder', 'DeletedFolder.INBOX', '{"flagged":"starred"}');
    const summary = restoreApplicationState({ Database: TestDatabase, currentDb: env.current, backupDbPath: env.sourcePath,
      currentSecretsDir: env.currentSecrets, backupSecretsDir: env.backupSecrets, workDir: env.workDir });
    assert.equal(summary.savedSearches, 50); assert.equal(summary.savedSearchesSkipped, 3); assert.equal(summary.savedSearchesPreserved, false);
    assert.equal(env.current.prepare('SELECT COUNT(*) n FROM saved_searches WHERE owner_user_id=10').get().n, 50);
    assert.equal(env.current.prepare('SELECT name FROM saved_searches WHERE id=1').get().name, 'Bob private');
    assert.equal(env.current.prepare("SELECT COUNT(*) n FROM saved_searches WHERE folder='DeletedFolder.INBOX'").get().n, 50);
  } finally { env.current.close(); env.source.close(); fs.rmSync(env.root, { recursive: true, force: true }); }
});

integrationTest('old backup without saved-search table preserves all current saved searches', () => {
  const current = TestDatabase(':memory:'), source = TestDatabase(':memory:');
  try {
    current.exec("CREATE TABLE saved_searches(id INTEGER,owner_user_id INTEGER,name TEXT); INSERT INTO saved_searches VALUES(1,7,'Keep')");
    assert.deepEqual(restoreSavedSearches(current, source, new Map([[1, 7]])), { savedSearches: 0, savedSearchesSkipped: 0, savedSearchesPreserved: true });
    assert.equal(current.prepare('SELECT name FROM saved_searches').get().name, 'Keep');
  } finally { current.close(); source.close(); }
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
    fs.writeFileSync(path.join(backup, 'oauth-clients.json'), JSON.stringify({ publicBaseUrl: 'https://old.invalid', google: { clientId: 'imported' } }));
    const liveDb = { prepare: () => ({ get: () => ({ value: 'https://current.invalid' }) }) };
    const result = prepareRestoredSecrets(liveDb, backup, current, prepared);
    const oauth = JSON.parse(fs.readFileSync(path.join(prepared, 'oauth-clients.json'), 'utf8'));
    assert.deepEqual(oauth, { publicBaseUrl: 'https://current.invalid', google: { clientId: 'imported' } });
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
    fs.writeFileSync(path.join(env.backupSecrets, 'notification.json'), JSON.stringify({ enabled:true, provider:'webhook', webhookUrl:'https://notify.invalid/old' }));
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
    assert.equal(fs.existsSync(path.join(env.currentSecrets, 'notification.json')), false);
    const config = notificationConfigStore(env.root, env.currentSecrets);
    config.initialize();
    assert.equal(config.read().enabled, undefined);
    assert.equal(config.read().webhookUrl, undefined);
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

    let requestId;
    assert.throws(() => restoreApplicationState({
      onJournal(id) { requestId = id; },
      Database: TestDatabase,
      currentDb: env.current,
      backupDbPath: env.sourcePath,
      currentSecretsDir: env.currentSecrets,
      backupSecretsDir: env.backupSecrets,
      workDir: env.workDir,
    }), /simulated commit failure/);
    assert.match(requestId, /^[a-f0-9]{32}$/);
    assert.equal(lastRestoreResult(env.current).operation_id, requestId);
    assert.deepEqual(env.current.prepare('SELECT operation_id,outcome FROM restore_notification_source').all().map(row => [row.operation_id,row.outcome]),
      [[requestId,'rolled_back']]);
    assert.equal(env.current.prepare('SELECT username FROM accounts').get().username, 'current@test');
    assert.equal(fs.readFileSync(path.join(env.currentSecrets, 'marker'), 'utf8'), 'current-secret-tree');
    assert.equal(fs.existsSync(path.join(env.currentSecrets, 'source.pass')), false);
  } finally {
    env.current.close(); env.source.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

integrationTest('cross-instance restore maps owners by username and never by coincidental numeric id', () => {
  const env = tempEnvironment();
  try {
    env.current.exec(`
      ALTER TABLE admin_users ADD COLUMN mail_access_all INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE accounts ADD COLUMN owner_user_id INTEGER;
      INSERT INTO admin_users(id,username,password_hash,mail_access_all) VALUES(1,'current-primary','x',1);
      INSERT INTO admin_users(id,username,password_hash,mail_access_all) VALUES(2,'shared-user','x',0);
      INSERT INTO settings VALUES('dovecot_user','mailuser');
    `);
    env.source.exec(`
      ALTER TABLE accounts ADD COLUMN owner_user_id INTEGER;
      INSERT INTO admin_users VALUES(1,'different-person','x');
      INSERT INTO admin_users VALUES(9,'shared-user','x');
      INSERT INTO settings VALUES('app_name','Backup');
      INSERT INTO accounts(id,name,username,owner_user_id) VALUES(11,'foreign','foreign@test',1);
      INSERT INTO accounts(id,name,username,owner_user_id) VALUES(12,'matched','matched@test',9);
    `);
    fs.writeFileSync(path.join(env.currentSecrets, 'local-target.pass'), 'live-local');

    restoreApplicationState({
      Database: TestDatabase,
      currentDb: env.current,
      backupDbPath: env.sourcePath,
      currentSecretsDir: env.currentSecrets,
      backupSecretsDir: env.backupSecrets,
      workDir: env.workDir,
    });
    assert.equal(env.current.prepare('SELECT owner_user_id FROM accounts WHERE id=11').get().owner_user_id, 1);
    assert.equal(env.current.prepare('SELECT owner_user_id FROM accounts WHERE id=12').get().owner_user_id, 2);
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


integrationTest('a running sync in a backup requires mirror review, while an unstarted queued sync does not', () => {
  const env = tempEnvironment();
  try {
    env.current.exec(`ALTER TABLE accounts ADD COLUMN deletion_mode TEXT;
      ALTER TABLE accounts ADD COLUMN sync_result_unknown INTEGER DEFAULT 0;
      ALTER TABLE accounts ADD COLUMN last_sync_at TEXT;
      ALTER TABLE accounts ADD COLUMN last_finished_job_id INTEGER;
      ALTER TABLE accounts ADD COLUMN last_sync_status TEXT;
      ALTER TABLE accounts ADD COLUMN last_sync_category TEXT;
      ALTER TABLE accounts ADD COLUMN last_sync_message TEXT;
      ALTER TABLE sync_jobs ADD COLUMN result_known INTEGER;
      ALTER TABLE sync_jobs ADD COLUMN result_code TEXT;
      ALTER TABLE sync_jobs ADD COLUMN pid_identity TEXT;
      ALTER TABLE sync_jobs ADD COLUMN next_attempt_at TEXT;
    `);
    env.source.exec(`ALTER TABLE accounts ADD COLUMN deletion_mode TEXT;
      INSERT INTO accounts(id,name,username,deletion_mode) VALUES(1,'active','one@test','mirror_messages'),(2,'queued','two@test','mirror_messages');
      INSERT INTO sync_jobs VALUES(3,1,'2026-01-01',NULL,'running',1234),(4,2,'2026-01-01',NULL,'queued',NULL);`);
    restoreApplicationState({ Database: TestDatabase, currentDb: env.current, backupDbPath: env.sourcePath,
      currentSecretsDir: env.currentSecrets, backupSecretsDir: env.backupSecrets, workDir: env.workDir });
    const rows = env.current.prepare('SELECT status,result_known,result_code,pid FROM sync_jobs ORDER BY id').all();
    assert.deepEqual(rows.map(row => Object.values(row)), [
      ['interrupted', 0, 'restore_unknown', null], ['interrupted', 1, 'restore_cancelled', null],
    ]);
    assert.deepEqual(env.current.prepare('SELECT sync_result_unknown,last_finished_job_id FROM accounts ORDER BY id').all().map(row => Object.values(row)),
      [[1,3],[0,null]]);
  } finally {
    env.current.close(); env.source.close(); fs.rmSync(env.root, { recursive: true, force: true });
  }
});
