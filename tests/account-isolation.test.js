const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) {}

(DatabaseSync ? test : test.skip)('account routes enforce isolation and do not lock out child OAuth refresh during testing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-isolation-'));
  const previous = process.env.MAIL_AGG_DATA_DIR; process.env.MAIL_AGG_DATA_DIR = root;
  const original = Module._load;
  let db;
  Module._load = function(name, parent, main) {
    if (name === 'better-sqlite3') return function(filename) {
      const database = new DatabaseSync(filename); database.pragma = sql => database.exec('PRAGMA ' + sql);
      database.transaction = fn => (...args) => { database.exec('BEGIN'); try { const result = fn(...args); database.exec('COMMIT'); return result; } catch(e) { database.exec('ROLLBACK'); throw e; } };
      return database;
    };
    if (name === './sync' && parent.filename.endsWith('accounts.js')) return {
      isAccountLocked: () => false, hasActiveJob: () => false,
      testConnection: async () => {
        assert.equal(fs.existsSync(path.join(root, '.state-write.lock')), false, 'OAuth child must be able to acquire the state lock');
        return { ok: true };
      },
    };
    return original.call(this, name, parent, main);
  };
  try {
    ({ db } = require('../server/db'));
    const router = require('../server/accounts');
    const user = Number(db.prepare("INSERT INTO admin_users(username,password_hash,role) VALUES('review-user','dummy','user')").run().lastInsertRowid);
    const id = Number(db.prepare(`INSERT INTO accounts(name,provider,host,username,owner_user_id,destination_mode,destination_folder,mailbox_folder)
      VALUES('review','custom','imap.example.org','review@example.org',?,'subfolder','Review','U1-A1')`).run(user).lastInsertRowid);
    require('../server/credentials').saveSourceSecret(id, 'fixture');
    const handler = router.stack.find(s => s.route?.path === '/:id' && s.route.methods.put).route.stack[0].handle;
    const res = { code: 200, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
    handler({ params: { id: String(id) }, user: { id: user, role: 'user' }, body: {
      name: 'review', provider: 'custom', host: 'imap.example.org', port: 993, ssl: true, username: 'review@example.org', destination_mode: 'flat',
    } }, res, error => { throw error; });
    assert.equal(res.code, 400);
    assert.equal(db.prepare('SELECT destination_mode FROM accounts WHERE id=?').get(id).destination_mode, 'subfolder');
    const testHandler = router.stack.find(s => s.route?.path === '/:id/test').route.stack[0].handle;
    await testHandler({ params: { id: String(id) }, user: { id: user } }, res, error => { throw error; });
    assert.equal(res.body.ok, true);
  } finally {
    Module._load = original; if (db) db.close();
    if (previous === undefined) delete process.env.MAIL_AGG_DATA_DIR; else process.env.MAIL_AGG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
