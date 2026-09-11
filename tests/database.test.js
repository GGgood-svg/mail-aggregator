const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  // node:sqlite is unavailable before Node 22.5. These integration tests are
  // skipped there; the dependency-free unit tests still run on Node 18+.
}

const dbModulePath = require.resolve('../server/db');
const integrationTest = DatabaseSync ? test : test.skip;

function BetterSqliteShim(filename) {
  const database = new DatabaseSync(filename);
  database.pragma = (statement) => database.exec(`PRAGMA ${statement}`);
  return database;
}

function loadDatabase(dataDir) {
  const originalLoad = Module._load;
  const previousDataDir = process.env.MAIL_AGG_DATA_DIR;
  delete require.cache[dbModulePath];
  process.env.MAIL_AGG_DATA_DIR = dataDir;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'better-sqlite3') return BetterSqliteShim;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(dbModulePath);
  } finally {
    Module._load = originalLoad;
    if (previousDataDir === undefined) delete process.env.MAIL_AGG_DATA_DIR;
    else process.env.MAIL_AGG_DATA_DIR = previousDataDir;
  }
}

function withTempDatabase(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-db-test-'));
  let runError = null;
  try {
    return run(dataDir);
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    delete require.cache[dbModulePath];
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    } catch (cleanupError) {
      // Preserve the real database/migration error if a failed module load left a
      // Windows SQLite handle alive; otherwise surface the cleanup regression.
      if (!runError) throw cleanupError;
    }
  }
}

function insertAccount(db, name = 'test-account') {
  return db.prepare(
    `INSERT INTO accounts (name, provider, host, port, ssl, username)
     VALUES (?, 'custom', 'imap.example.test', 993, 1, 'user@example.test')`
  ).run(name).lastInsertRowid;
}

integrationTest('database initialization enables WAL, foreign keys, and current defaults', () => {
  withTempDatabase((dataDir) => {
    const { db, DB_PATH } = loadDatabase(dataDir);
    try {
      assert.equal(DB_PATH, path.join(dataDir, 'db', 'mail-aggregator.db'));
      assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.equal(
        db.prepare("SELECT value FROM settings WHERE key='sync_timeout_minutes'").get().value,
        '120'
      );
      assert.equal(
        db.prepare("SELECT value FROM settings WHERE key='log_retention_days'").get().value,
        '90'
      );
      assert.equal(
        db.prepare("SELECT value FROM settings WHERE key='max_job_log_mb'").get().value,
        '16'
      );
      assert.equal(db.prepare("SELECT value FROM settings WHERE key='max_accounts_per_user'").get().value, '20');
      assert.equal(db.prepare("SELECT value FROM settings WHERE key='min_free_disk_mb'").get().value, '512');
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name);
      for (const name of ['accounts', 'mailbox_ownership', 'sync_jobs', 'settings', 'sessions', 'login_attempts']) {
        assert.ok(tables.includes(name), `missing table: ${name}`);
      }
      const accountId = insertAccount(db, 'flat-default');
      const account = db.prepare(`SELECT destination_mode, destination_folder, folder_includes,
        folder_excludes, max_age_days, max_size_mb, deletion_mode FROM accounts WHERE id=?`).get(accountId);
      assert.equal(account.destination_mode, 'flat');
      assert.equal(account.destination_folder, null);
      assert.equal(account.folder_includes, '');
      assert.equal(account.folder_excludes, '');
      assert.equal(account.max_age_days, null);
      assert.equal(account.max_size_mb, null);
      assert.equal(account.deletion_mode, 'archive');
      const accountColumns = db.prepare('PRAGMA table_info(accounts)').all().map((row) => row.name);
      const userColumns = db.prepare('PRAGMA table_info(admin_users)').all().map((row) => row.name);
      for (const name of ['owner_user_id', 'mailbox_folder']) assert.ok(accountColumns.includes(name));
      for (const name of ['role', 'enabled', 'session_version', 'mail_access_all']) assert.ok(userColumns.includes(name));
    } finally {
      db.close();
    }
  });
});

integrationTest('startup assigns legacy accounts to the first administrator without moving folders', () => {
  withTempDatabase((dataDir) => {
    let loaded = loadDatabase(dataDir);
    const userId = loaded.db.prepare("INSERT INTO admin_users(username,password_hash) VALUES('legacy','x')").run().lastInsertRowid;
    const accountId = loaded.db.prepare(`INSERT INTO accounts(name,provider,host,username,destination_mode,destination_folder)
      VALUES('old','custom','imap.example.test','old@example.test','subfolder','Old Mail')`).run().lastInsertRowid;
    loaded.db.close();
    delete require.cache[dbModulePath];
    loaded = loadDatabase(dataDir);
    try {
      const user = loaded.db.prepare('SELECT role,mail_access_all FROM admin_users WHERE id=?').get(userId);
      const account = loaded.db.prepare('SELECT owner_user_id,mailbox_folder FROM accounts WHERE id=?').get(accountId);
      assert.equal(user.role, 'admin');
      assert.equal(user.mail_access_all, 1);
      assert.equal(account.owner_user_id, userId);
      assert.equal(account.mailbox_folder, 'Old Mail');
      const ownership = loaded.db.prepare(`SELECT owner_user_id, former_account_id
        FROM mailbox_ownership WHERE local_user='mailuser' AND mailbox_folder='old mail' COLLATE NOCASE`).get();
      assert.equal(ownership.owner_user_id, userId);
      assert.equal(ownership.former_account_id, accountId);
    } finally { loaded.db.close(); }
  });
});

integrationTest('mailbox ownership survives account deletion and cannot be reassigned', () => {
  withTempDatabase((dataDir) => {
    const { db } = loadDatabase(dataDir);
    try {
      const firstOwner = db.prepare("INSERT INTO admin_users(username,password_hash) VALUES('first-owner','x')").run().lastInsertRowid;
      const secondOwner = db.prepare("INSERT INTO admin_users(username,password_hash) VALUES('second-owner','x')").run().lastInsertRowid;
      const accountId = db.prepare(`INSERT INTO accounts
        (name,provider,host,username,local_user,destination_mode,destination_folder,mailbox_folder,owner_user_id)
        VALUES('owned','custom','imap.example.test','a@example.test','mailuser','subfolder','Owned','U1-A99',?)`)
        .run(firstOwner).lastInsertRowid;
      const { registerMailboxOwnership } = require('../server/mailbox-ownership');
      registerMailboxOwnership(db, {
        localUser: 'mailuser', mailboxFolder: 'U1-A99', ownerUserId: firstOwner, accountId,
      });
      db.prepare('DELETE FROM accounts WHERE id=?').run(accountId);
      assert.equal(db.prepare(`SELECT owner_user_id FROM mailbox_ownership
        WHERE local_user='mailuser' AND mailbox_folder='U1-A99'`).get().owner_user_id, firstOwner);
      db.prepare('DELETE FROM admin_users WHERE id=?').run(firstOwner);
      assert.equal(db.prepare(`SELECT owner_user_id FROM mailbox_ownership
        WHERE local_user='mailuser' AND mailbox_folder='U1-A99'`).get().owner_user_id, firstOwner);
      assert.throws(() => registerMailboxOwnership(db, {
        localUser: 'mailuser', mailboxFolder: 'u1-a99', ownerUserId: secondOwner,
      }), /已归属于其他用户/);
    } finally { db.close(); }
  });
});

integrationTest('startup removes the transient cascading ownership foreign key without losing roots', () => {
  withTempDatabase((dataDir) => {
    let loaded = loadDatabase(dataDir);
    const owner = loaded.db.prepare("INSERT INTO admin_users(username,password_hash) VALUES('migration-owner','x')").run().lastInsertRowid;
    loaded.db.exec(`
      DROP TABLE mailbox_ownership;
      CREATE TABLE mailbox_ownership (
        local_user TEXT NOT NULL,
        mailbox_folder TEXT NOT NULL COLLATE NOCASE,
        owner_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        former_account_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (local_user, mailbox_folder)
      );
    `);
    loaded.db.prepare(`INSERT INTO mailbox_ownership(local_user,mailbox_folder,owner_user_id)
      VALUES('mailuser','U9-A9',?)`).run(owner);
    loaded.db.close();
    delete require.cache[dbModulePath];

    loaded = loadDatabase(dataDir);
    try {
      assert.equal(loaded.db.prepare('PRAGMA foreign_key_list(mailbox_ownership)').all().length, 0);
      assert.equal(loaded.db.prepare(`SELECT owner_user_id FROM mailbox_ownership
        WHERE local_user='mailuser' AND mailbox_folder='U9-A9'`).get().owner_user_id, owner);
    } finally { loaded.db.close(); }
  });
});

integrationTest('database permits only one active job per account and cascades deletion', () => {
  withTempDatabase((dataDir) => {
    const { db } = loadDatabase(dataDir);
    try {
      const accountId = insertAccount(db);
      db.prepare(
        "INSERT INTO sync_jobs(account_id,started_at,status) VALUES(?,datetime('now'),'queued')"
      ).run(accountId);
      assert.throws(
        () => db.prepare(
          "INSERT INTO sync_jobs(account_id,started_at,status) VALUES(?,datetime('now'),'running')"
        ).run(accountId),
        /UNIQUE constraint failed/
      );

      db.prepare(
        "INSERT INTO sync_jobs(account_id,started_at,status) VALUES(?,datetime('now'),'success')"
      ).run(accountId);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM sync_jobs WHERE account_id=?').get(accountId).count,
        2
      );

      db.prepare('DELETE FROM accounts WHERE id=?').run(accountId);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM sync_jobs WHERE account_id=?').get(accountId).count,
        0
      );
    } finally {
      db.close();
    }
  });
});

integrationTest('display folders are unique per Web user but reusable by another user', () => {
  withTempDatabase((dataDir) => {
    const { db } = loadDatabase(dataDir);
    try {
      const firstOwner = db.prepare("INSERT INTO admin_users(username,password_hash) VALUES('first','x')").run().lastInsertRowid;
      const secondOwner = db.prepare("INSERT INTO admin_users(username,password_hash) VALUES('second','x')").run().lastInsertRowid;
      const insert = db.prepare(`INSERT INTO accounts
        (name, provider, host, port, ssl, username, local_user, destination_mode, destination_folder, owner_user_id)
        VALUES (?, 'custom', 'imap.example.test', 993, 1, ?, ?, 'subfolder', ?, ?)`);
      insert.run('one', 'one@example.test', 'mailuser', 'QQ Mail', firstOwner);
      assert.throws(
        () => insert.run('two', 'two@example.test', 'mailuser', 'qq mail', firstOwner),
        /UNIQUE constraint failed/
      );
      assert.doesNotThrow(() => insert.run('three', 'three@example.test', 'mailuser', 'QQ Mail', secondOwner));
    } finally {
      db.close();
    }
  });
});

integrationTest('startup repairs duplicate active jobs before recreating the unique index', () => {
  withTempDatabase((dataDir) => {
    let loaded = loadDatabase(dataDir);
    const accountId = insertAccount(loaded.db);
    loaded.db.exec('DROP INDEX idx_unique_active_job_per_account');
    loaded.db.prepare(
      "INSERT INTO sync_jobs(account_id,started_at,status) VALUES(?,'2026-01-01 00:00:00','queued')"
    ).run(accountId);
    loaded.db.prepare(
      "INSERT INTO sync_jobs(account_id,started_at,status) VALUES(?,'2026-01-02 00:00:00','running')"
    ).run(accountId);
    loaded.db.close();
    delete require.cache[dbModulePath];

    loaded = loadDatabase(dataDir);
    try {
      const jobs = loaded.db
        .prepare('SELECT status, finished_at FROM sync_jobs WHERE account_id=? ORDER BY started_at')
        .all(accountId);
      assert.equal(jobs[0].status, 'cancelled');
      assert.ok(jobs[0].finished_at);
      assert.equal(jobs[1].status, 'running');

      assert.throws(
        () => loaded.db.prepare(
          "INSERT INTO sync_jobs(account_id,started_at,status) VALUES(?,datetime('now'),'queued')"
        ).run(accountId),
        /UNIQUE constraint failed/
      );
    } finally {
      loaded.db.close();
    }
  });
});
