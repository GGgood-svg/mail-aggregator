'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createOAuthRefresh } = require('../server/oauth-refresh');
const { withStateLock, lockPath } = require('../server/state-lock');
const { initializeRestoreState, recordRestoreResult } = require('../server/restore-journal');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-per-account-'));
  const filename = path.join(root, 'fixture.db');
  const firstDb = new Database(filename), secondDb = new Database(filename);
  firstDb.pragma('journal_mode = WAL'); firstDb.pragma('foreign_keys = ON'); secondDb.pragma('foreign_keys = ON');
  t.after(() => { firstDb.close(); secondDb.close(); fs.rmSync(root, { recursive: true, force: true }); });
  initializeRestoreState(firstDb);
  firstDb.exec(`CREATE TABLE admin_users (id INTEGER PRIMARY KEY, enabled INTEGER);
    INSERT INTO admin_users VALUES (1,1),(2,1);
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, owner_user_id INTEGER, provider TEXT, username TEXT,
      host TEXT, port INTEGER, ssl INTEGER, auth_type TEXT, name TEXT);
    INSERT INTO accounts VALUES(7,1,'gmail','fixture-a','imap.gmail.com',993,1,'oauth2','A'),
      (8,2,'gmail','fixture-b','imap.gmail.com',993,1,'oauth2','B');
    CREATE TABLE sync_jobs(id INTEGER PRIMARY KEY, account_id INTEGER, status TEXT);`);
  let client = { clientId: 'fixture-client', clientSecret: 'fixture-private', generation: 'provider-one' };
  let tokens = { refreshToken: 'initial-refresh', accessToken: 'initial-access', expiresAt: 1, grantGeneration: 'one' };
  const started = deferred(), finish = deferred();
  let calls = 0, writes = 0;
  const dependencies = { root, loadClient: () => client, loadTokens: () => tokens,
    persistTokens: (_id, next, { grantGeneration }) => { tokens = { ...next, grantGeneration }; writes++; },
    writeAccess: () => '/fixture/access.token', refresh: async () => {
      calls++; assert.equal(fs.existsSync(lockPath(root)), false);
      started.resolve();
      const response = await finish.promise;
      if (response instanceof Error) throw response;
      return response || { refreshToken: 'rotated-refresh', accessToken: 'rotated-access', expiresAt: Date.now() + 3600000 };
    },
  };
  return { root, firstDb, secondDb, started, finish, get calls() { return calls; }, get writes() { return writes; },
    get tokens() { return tokens; }, set tokens(next) { tokens = next; }, set client(next) { client = next; },
    a: createOAuthRefresh({ ...dependencies, database: firstDb }), b: createOAuthRefresh({ ...dependencies, database: secondDb }) };
}

const account = { id: 7, owner_user_id: 1 };
test('slow OAuth refresh releases the global lock and coalesces requests via separate DB connections', async t => {
  const f = fixture(t);
  const running = f.a(account); await f.started.promise;
  const joining = f.b(account);
  withStateLock(f.root, () => {
    f.secondDb.prepare("UPDATE accounts SET name='B can edit' WHERE id=8").run();
    f.secondDb.prepare("INSERT INTO sync_jobs(account_id,status) VALUES(8,'queued')").run();
  });
  assert.equal(f.secondDb.prepare('SELECT status FROM sync_jobs WHERE account_id=8').get().status, 'queued');
  f.finish.resolve();
  assert.deepEqual(await Promise.all([running, joining]), ['/fixture/access.token', '/fixture/access.token']);
  assert.equal(f.calls, 1); assert.equal(f.writes, 1);
  assert.equal(f.tokens.grantGeneration, 'one'); assert.equal(f.tokens.refreshToken, 'rotated-refresh');
  await f.b(account); assert.equal(f.writes, 1);
});

test('concurrent provider failure is shared without disclosing provider text', async t => {
  const f = fixture(t);
  const running = f.a(account); await f.started.promise;
  const joining = f.b(account);
  const both = Promise.allSettled([running, joining]);
  f.finish.resolve(Object.assign(new Error('secret provider response'), { code: 'invalid_grant' }));
  const result = await both;
  assert.deepEqual(result.map(item => item.reason.code), ['invalid_grant', 'invalid_grant']);
  assert.ok(result.every(item => !item.reason.message.includes('secret provider response')));
  assert.equal(f.calls, 1); assert.equal(f.writes, 0);
});

for (const [name, change] of [
  ['reauthorization', f => { f.tokens = { ...f.tokens, grantGeneration: 'two', refreshToken: 'new-authorization' }; }],
  ['account changes and changes back', f => f.secondDb.exec("UPDATE accounts SET name='new' WHERE id=7; UPDATE accounts SET name='A' WHERE id=7")],
  ['account deletion', f => f.secondDb.prepare('DELETE FROM accounts WHERE id=7').run()],
  ['restoration', f => recordRestoreResult(f.secondDb, 'independent-restore-operation', 'committed')],
  ['issuer changes', f => { f.client = { clientId: 'updated-client', clientSecret: 'fixture-private', generation: 'provider-two' }; }],
]) {
  test(`a provider response cannot commit after ${name}`, async t => {
    const f = fixture(t);
    const result = f.a(account); await f.started.promise;
    withStateLock(f.root, () => change(f));
    const rejected = assert.rejects(result, { code: 'oauth_stale' });
    f.finish.resolve(); await rejected;
    assert.equal(f.writes, 0);
  });
}
