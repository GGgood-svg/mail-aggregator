const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) {}
const integrationTest = DatabaseSync ? test : test.skip;

function BetterSqliteShim(filename) {
  const database = new DatabaseSync(filename);
  database.pragma = (statement) => database.exec(`PRAGMA ${statement}`);
  return database;
}

const dbPath = require.resolve('../server/db');
const authPath = require.resolve('../server/auth');
const accessPath = require.resolve('../server/access-control');

function unload() {
  for (const item of [accessPath, authPath, dbPath]) delete require.cache[item];
}

function loadDatabase(root) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'better-sqlite3') return BetterSqliteShim;
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require('../server/db'); }
  finally { Module._load = originalLoad; }
}

function withDatabase(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-users-'));
  const previous = process.env.MAIL_AGG_DATA_DIR;
  process.env.MAIL_AGG_DATA_DIR = root;
  unload();
  const database = loadDatabase(root);
  let activeDb = database.db;
  try { return run(database.db, root, (replacement) => { activeDb = replacement; }); }
  finally {
    try { activeDb.close(); } catch (_) {} unload();
    if (previous === undefined) delete process.env.MAIL_AGG_DATA_DIR;
    else process.env.MAIL_AGG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

integrationTest('account access always includes the authenticated owner', () => {
  withDatabase((db) => {
    const first = db.prepare("INSERT INTO admin_users(username,password_hash,role) VALUES('one','x','user')").run().lastInsertRowid;
    const second = db.prepare("INSERT INTO admin_users(username,password_hash,role) VALUES('two','x','user')").run().lastInsertRowid;
    const account = db.prepare(`INSERT INTO accounts(name,provider,host,username,owner_user_id)
      VALUES('private','custom','imap.example.test','one@example.test',?)`).run(first).lastInsertRowid;
    const { ownedAccount } = require('../server/access-control');
    assert.equal(ownedAccount({ user: { id: first } }, account).name, 'private');
    assert.equal(ownedAccount({ user: { id: second } }, account), undefined);
  });
});

integrationTest('disabled users and stale session versions are rejected immediately', () => {
  withDatabase((db) => {
    const id = db.prepare(`INSERT INTO admin_users(username,password_hash,role,session_version)
      VALUES('member','x','user',2)`).run().lastInsertRowid;
    const { sessionUser } = require('../server/auth');
    assert.equal(sessionUser({ session: { userId: Number(id), sessionVersion: 1 } }), null);
    assert.equal(sessionUser({ session: { userId: Number(id), sessionVersion: 2 } }).username, 'member');
    db.prepare('UPDATE admin_users SET enabled=0 WHERE id=?').run(id);
    assert.equal(sessionUser({ session: { userId: Number(id), sessionVersion: 2 } }), null);
  });
});

integrationTest('legacy administrator access excludes every other user mailbox root', () => {
  withDatabase((db) => {
    const adminId = db.prepare(`INSERT INTO admin_users(username,password_hash,role,mail_access_all)
      VALUES('admin','x','admin',1)`).run().lastInsertRowid;
    const userId = db.prepare(`INSERT INTO admin_users(username,password_hash,role)
      VALUES('member','x','user')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO accounts(name,provider,host,username,owner_user_id,destination_mode,destination_folder,mailbox_folder)
      VALUES('admin mail','custom','imap.example.test','admin@example.test',?,'subfolder','Admin Mail','U1-A1')`).run(adminId);
    db.prepare(`INSERT INTO accounts(name,provider,host,username,owner_user_id,destination_mode,destination_folder,mailbox_folder)
      VALUES('member mail','custom','imap.example.test','member@example.test',?,'subfolder','Member Mail','U2-A2')`).run(userId);

    const { mailAccessForRequest, folderAllowed } = require('../server/mail-reader');
    const access = mailAccessForRequest({ user: { id: Number(adminId), mail_access_all: 1 } });
    assert.equal(folderAllowed('INBOX', access), true);
    assert.equal(folderAllowed('U1-A1/INBOX', access), true);
    assert.equal(folderAllowed('U2-A2', access), false);
    assert.equal(folderAllowed('U2-A2/INBOX', access), false);
  });
});
