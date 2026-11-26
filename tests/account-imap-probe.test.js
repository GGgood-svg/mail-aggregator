'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createAccountImapProbe } = require('../server/account-imap-probe');
const { initializeRestoreState, recordRestoreResult } = require('../server/restore-journal');

function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE admin_users(id INTEGER PRIMARY KEY,role TEXT,mail_access_all INTEGER,enabled INTEGER);
    INSERT INTO admin_users VALUES(2,'user',0,1),(3,'user',0,1);
    CREATE TABLE accounts(id INTEGER PRIMARY KEY,name TEXT);
    INSERT INTO accounts VALUES(7,'a'),(8,'b');
    CREATE TABLE mailbox_ownership(local_user TEXT,mailbox_folder TEXT,owner_user_id INTEGER);
    INSERT INTO mailbox_ownership VALUES('mailuser','U2-A7',2),('mailuser','U3-A8',3);`);
  initializeRestoreState(db);
  const account = { id: 7, owner_user_id: 2, provider: 'custom', auth_type: 'password', host: 'imap.fixture.example',
    port: 993, ssl: true, username: 'fixture', local_user: 'mailuser', destination_mode: 'subfolder', mailbox_folder: 'U2-A7' };
  const local = { host: 'localhost', port: 143, user: 'mailuser' };
  const source = [{ path: 'INBOX', subscribed: true, delimiter: '/' }, { path: '资料/项目', pathAsListed: '&jWROmQ-/&mHl2Lg-', subscribed: true, delimiter: '/' },
    { path: 'Archive', subscribed: false, delimiter: '/' }];
  const target = [{ path: 'U2-A7.INBOX', subscribed: false, delimiter: '.' }, { path: 'U3-A8.Other user notes', delimiter: '.' }];
  const calls = [], settings = { oauthGrant: 'first-grant' };
  let now = 1827120000000;
  const probe = createAccountImapProbe({ database: db, localConfig: () => local,
    secretForSource: () => 'fixture-source-secret', secretForTarget: () => 'fixture-target-secret',
    oauthToken: async () => 'fixture-access-token', oauthGrant: () => settings.oauthGrant,
    resolvePublic: async () => [{ address: '93.184.216.34', family: 4 }], clock: () => now,
    createClient: options => {
      const isSource = options.host === '93.184.216.34';
      calls.push({ command: 'make', isSource, options });
      return { namespace: { prefix: '', delimiter: isSource ? '/' : '.' }, capabilities: new Map(), enabled: new Set(settings.utf8 ? ['UTF8=ACCEPT'] : []),
        async exec(command, args, options) {
          calls.push({ command, args, isSource });
          for (const [path, delimiter] of (await settings.scoped?.(args[1])) || []) {
            await options.untagged.LIST({ attributes: [[], delimiter == null ? null : { value: delimiter }, { value: path }] });
          }
          return { next() {} };
        },
        async connect() { calls.push({ command: 'connect', isSource }); if (settings.error && !isSource) throw settings.error; },
        async list(options) { calls.push({ command: 'list', isSource, options }); if (settings.list) await settings.list(isSource); return isSource ? source : target; },
        close() { calls.push({ command: 'close', isSource }); },
      };
    },
  });
  return { probe, account, db, calls, local, source, target, settings, advance: ms => { now += ms; } };
}

test('test checks both ends through read-only operations, with pinned TLS and scoped target results', async t => {
  const f = fixture(t);
  const before = JSON.stringify([f.source, f.target]);
  const result = await f.probe.run(f.account);
  assert.equal(result.ok, true); assert.equal(result.mode, 'read_only'); assert.equal(result.writeAccess, 'not_checked');
  assert.equal(result.source.folders, 3); assert.equal(result.target.folders, 1);
  assert.equal(JSON.stringify([f.source, f.target]), before);
  assert.deepEqual(f.calls.map(call => call.command), ['make','connect','list','close','make','connect','list','close']);
  const source = f.calls[0].options;
  assert.equal(source.secure, true); assert.equal(source.host, '93.184.216.34'); assert.equal(source.servername, 'imap.fixture.example');
  assert.equal(source.tls.rejectUnauthorized, true);
  assert.equal(source.tls.checkServerIdentity('93.184.216.34', { subjectaltname: 'DNS:imap.fixture.example' }), undefined);
  assert.equal(source.tls.checkServerIdentity('93.184.216.34', { subjectaltname: 'DNS:other.example' }).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(f.calls[2].options.listOnly, true); assert.equal(f.calls[6].options.listOnly, true);
  assert.equal(f.calls[4].options.host, '127.0.0.1'); assert.equal(f.calls[4].options.doSTARTTLS, false);
  assert.doesNotMatch(JSON.stringify(result), /secret|Other user notes/);
});

test('sync impact maps folders separately, with an expiring ticket bound to the account and restore generation', async t => {
  const f = fixture(t);
  const account = { ...f.account, deletion_mode: 'mirror_messages', folder_excludes: 'Archive' };
  const { plan, target } = await f.probe.run(account, { mode: 'plan' });
  assert.equal(target.folders, 1);
  assert.deepEqual(plan.counts, { use: 1, create: 1, skip: 1, conflict: 0 });
  assert.deepEqual(plan.rows.map(item => [item.destination, item.mayDeleteMessages]),
    [['U2-A7.INBOX', true], ['U2-A7.资料.项目', false], [null, false]]);
  assert.equal(plan.rows[1].subscribe, 'possible');
  assert.equal(f.probe.verifyPlan(account, plan.ticket), true);
  assert.equal(f.probe.verifyPlan({ ...account, id: 8, owner_user_id: 3 }, plan.ticket), false);
  assert.equal(f.probe.verifyPlan(account, `${plan.ticket.slice(0, -1)}z`), false);
  recordRestoreResult(f.db, 'restore-of-identical-settings', 'committed');
  assert.equal(f.probe.verifyPlan(account, plan.ticket), false);
  const again = await f.probe.run(account, { mode: 'plan' });
  f.advance(300001);
  assert.equal(f.probe.verifyPlan(account, again.plan.ticket), false);
});

test('independent target TLS failure keeps the successful source result and closes both sessions', async t => {
  const f = fixture(t);
  f.settings.error = Object.assign(new Error('raw server message'), { code: 'CERT_HAS_EXPIRED' });
  const result = await f.probe.run(f.account);
  assert.equal(result.ok, false); assert.equal(result.source.ok, true); assert.equal(result.target.reason, 'tls_failed');
  assert.doesNotMatch(JSON.stringify(result), /raw server message/);
  assert.equal(f.calls.filter(item => item.command === 'close').length, 2);
});

test('authorization changes, maintenance, and cancellation stop the read-only probe without partial disclosure', async t => {
  const revoked = fixture(t);
  let active = true;
  revoked.settings.list = async () => { active = false; };
  await assert.rejects(revoked.probe.run(revoked.account, { authorize() {
    if (!active) throw Object.assign(new Error('revoked'), { statusCode: 401 });
  } }), { statusCode: 401 });
  assert.equal(revoked.calls.at(-1).command, 'close');
  assert.equal(revoked.calls.some(call => call.isSource === false), false);
  const outside = fixture(t);
  const access = await outside.probe.run({ ...outside.account, mailbox_folder: 'U3-A8' });
  assert.equal(access.category, 'scope_denied'); assert.equal(outside.calls.length, 0);
  const finished = await outside.probe.run(outside.account, { signal: AbortSignal.abort() });
  assert.equal(finished.category, 'interrupted'); assert.equal(outside.calls.length, 0);
});

function manyFolders(f, length = 205, name = index => `Fixture-${index}`) {
  f.source.splice(0, f.source.length, ...Array.from({ length }, (_, index) => ({ path: name(index), delimiter: '/' })));
}

test('plan pages preserve one ordered snapshot, counts and hidden mirror risk without a second IMAP read', async t => {
  const f = fixture(t);
  manyFolders(f);
  f.target.push({ path: 'U2-A7.Fixture-125', delimiter: '.' });
  const subject = 'fixture-session';
  const account = { ...f.account, deletion_mode: 'mirror_messages' };
  const { plan } = await f.probe.run(account, { mode: 'plan', subject });
  assert.equal(plan.truncated, true); assert.equal(plan.totalRows, 205); assert.equal(plan.rows.length, 100);
  assert.deepEqual(plan.counts, { use: 1, create: 204, skip: 0, conflict: 0 });
  assert.equal(plan.mirrorMessages, true);
  assert.ok(plan.rows.every(row => !row.mayDeleteMessages));
  f.source[125].path = 'Arrived after the snapshot';
  f.target.splice(0);
  const calls = f.calls.length;
  const next = f.probe.readPage(account, plan.nextCursor, { subject });
  assert.equal(next.offset, 100); assert.equal(next.rows.length, 100);
  assert.equal(next.rows[25].destination, 'U2-A7.Fixture-125');
  assert.equal(next.rows[25].mayDeleteMessages, true);
  const last = f.probe.readPage(account, next.nextCursor, { subject });
  assert.equal(last.offset, 200); assert.equal(last.rows.length, 5); assert.equal(last.nextCursor, null);
  assert.deepEqual(f.probe.readPage(account, plan.pageCursor, { subject }).rows, plan.rows);
  assert.deepEqual(f.probe.readPage(account, plan.nextCursor, { subject }), next);
  assert.equal(f.calls.length, calls);
  assert.deepEqual([...plan.rows, ...next.rows, ...last.rows].map(row => row.source), Array.from({ length: 205 }, (_, i) => `Fixture-${i}`));
  assert.doesNotMatch(JSON.stringify([plan, next, last]), /Other user notes|Arrived after|fixture-session/);
});

test('plan cursors and tickets reject another session, changes, recovery, access loss, expiry and tampering', async t => {
  const f = fixture(t);
  manyFolders(f);
  const subject = 'fixture-session';
  const account = f.account;
  const build = async () => (await f.probe.run(account, { mode: 'plan', subject })).plan;
  const assertUnavailable = (response, category = 'config_changed') => {
    assert.equal(response.ok, false); assert.equal(response.category, category); assert.equal(response.rows, undefined);
  };
  const plan = await build();
  assert.equal(f.probe.verifyPlan(account, plan.ticket, { subject }), true);
  assert.equal(f.probe.verifyPlan(account, plan.ticket, { subject: 'another-session' }), false);
  assertUnavailable(f.probe.readPage(account, plan.nextCursor, { subject: 'another-session' }));
  assertUnavailable(f.probe.readPage({ ...account, id: 8, owner_user_id: 3 }, plan.nextCursor, { subject }));
  assertUnavailable(f.probe.readPage(account, plan.nextCursor.replace('.100.', '.101.'), { subject }));
  assert.throws(() => f.probe.readPage(account, plan.nextCursor, { subject, authorize() {
    throw Object.assign(new Error('revoked'), { statusCode: 401 });
  } }), { statusCode: 401 });
  assertUnavailable(f.probe.readPage(account, plan.nextCursor, { subject, signal: AbortSignal.abort() }), 'interrupted');
  assertUnavailable(f.probe.readPage(account, plan.nextCursor, { subject, assertOperational() {
    throw Object.assign(new Error('maintenance'), { probeCode: 'maintenance' });
  } }), 'maintenance');
  f.db.exec("UPDATE accounts SET name='changed' WHERE id=7; UPDATE accounts SET name='a' WHERE id=7");
  assertUnavailable(f.probe.readPage(account, plan.nextCursor, { subject }));
  assert.equal(f.probe.verifyPlan(account, plan.ticket, { subject }), false);
  const ownership = await build();
  f.db.exec("UPDATE mailbox_ownership SET owner_user_id=3 WHERE mailbox_folder='U2-A7'");
  assertUnavailable(f.probe.readPage(account, ownership.nextCursor, { subject }));
  f.db.exec("UPDATE mailbox_ownership SET owner_user_id=2 WHERE mailbox_folder='U2-A7'");
  const recovered = await build();
  recordRestoreResult(f.db, 'recovered-settings', 'committed');
  assertUnavailable(f.probe.readPage(account, recovered.nextCursor, { subject }));
  const oauth = { ...account, auth_type: 'oauth2' };
  const granted = (await f.probe.run(oauth, { mode: 'plan', subject })).plan;
  assert.equal(f.probe.verifyPlan(oauth, granted.ticket, { subject }), true);
  f.settings.oauthGrant = 'new-grant';
  assertUnavailable(f.probe.readPage(oauth, granted.nextCursor, { subject }));
  assert.equal(f.probe.verifyPlan(oauth, granted.ticket, { subject }), false);
  const expired = await build();
  f.advance(300000);
  assertUnavailable(f.probe.readPage(account, expired.nextCursor, { subject }));
  assert.equal(f.probe.verifyPlan(account, expired.ticket, { subject }), false);
});

test('page serialization is bounded without increasing IMAP list limits or returning partial plans', async t => {
  const f = fixture(t);
  manyFolders(f, 115, index => `Fixture-${index}-${'年'.repeat(900)}`);
  const { plan } = await f.probe.run(f.account, { mode: 'plan' });
  assert.ok(plan.rows.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(plan.rows)) <= 256 * 1024 + 2);
  assert.equal(f.probe.readPage(f.account, plan.nextCursor).offset, plan.rows.length);
  manyFolders(f, 1501);
  const large = await f.probe.run(f.account, { mode: 'plan' });
  assert.equal(large.category, 'plan_list_limit'); assert.equal(large.plan, undefined);
  assert.equal((await f.probe.run(f.account)).category, 'folder_limit');
  const reads = f.calls.filter(item => item.command === 'list').length;
  f.settings.list = async isSource => { if (isSource) throw new DOMException('fixture list timed out', 'TimeoutError'); };
  const timeout = await f.probe.run(f.account, { mode: 'plan' });
  assert.equal(timeout.source.reason, 'plan_list_timeout'); assert.equal(timeout.target.ok, true); assert.equal(timeout.plan, undefined);
  assert.equal(f.calls.filter(item => item.command === 'list').length, reads + 2);
});


test('source-only exact query encodes mailbox names, handles INBOX case and never consults the target', async t => {
  const f = fixture(t);
  f.settings.scoped = () => [['INBOX', '/'], ['INBOX/child', '/']];
  const exact = await f.probe.run(f.account, { mode: 'plan', scope: { kind: 'exact', path: 'inbox' } });
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.plan, { status: 'partial', scope: { kind: 'exact', path: 'inbox' },
    rows: [{ path: 'INBOX', canBrowseChildren: true }], targetState: 'unknown' });
  assert.equal(exact.target.step, 'not_checked');
  assert.equal(f.calls.some(event => !event.isSource), false);
  assert.deepEqual(f.calls.filter(item => item.command === 'LIST').map(item => item.args), [['','inbox']]);
  f.settings.scoped = pattern => { assert.equal(pattern, 'INBOX.&jMdlmQ-'); return [[pattern, '.'], ['Other', '.']]; };
  const unicode = await f.probe.run(f.account, { mode: 'plan', scope: { kind: 'exact', path: 'INBOX.資料' } });
  assert.deepEqual(unicode.plan.rows, [{ path: 'INBOX.資料', canBrowseChildren: true }]);
  f.settings.utf8 = true;
  f.settings.scoped = pattern => { assert.equal(pattern, 'INBOX.資料'); return [[pattern, '.']]; };
  const utf8 = await f.probe.run(f.account, { mode: 'plan', scope: { kind: 'exact', path: 'INBOX.資料' } });
  assert.deepEqual(utf8.plan.rows, unicode.plan.rows);
  for (const path of ['Project*','Project%','Project\r\n','é'.repeat(513),'']) {
    const before = f.calls.length;
    const invalid = await f.probe.run(f.account, { mode: 'plan', scope: { kind: 'exact', path } });
    assert.equal(invalid.category, 'plan_scope_invalid'); assert.equal(f.calls.length, before);
  }
});

test('scoped root and child queries use only a real LIST delimiter and discard out-of-scope responses', async t => {
  const f = fixture(t);
  const list = {
    '': [['','.']], '%': [['INBOX','.'],['Archive','.'],['Archive.hidden','.'],['Unexpected/child','/']],
    Archive: [['Archive','.']], 'Archive.%': [['Archive.First','.'],['Archive.First.Second','.'],['Archive2.No','.'],['Archive.Nested','/']],
    Flat: [['Flat',null]], Missing: [],
  };
  f.settings.scoped = pattern => { assert.ok(Object.hasOwn(list, pattern), pattern); return list[pattern]; };
  const run = scope => f.probe.run(f.account, { mode: 'plan', scope });
  const root = await run({ kind: 'root' });
  assert.deepEqual(root.plan.rows.map(row => row.path), ['INBOX','Archive']);
  const child = await run({ kind: 'children', path: 'Archive' });
  assert.deepEqual(child.plan.rows.map(row => row.path), ['Archive.First']);
  assert.equal((await run({ kind: 'children', path: 'Flat' })).category, 'plan_scope_flat');
  assert.equal((await run({ kind: 'children', path: 'Missing' })).category, 'plan_scope_missing');
  list[''] = [['',null]];
  assert.equal((await run({ kind: 'root' })).category, 'plan_scope_flat');
  assert.equal((await run({ kind: 'exact', path: 'Flat' })).plan.rows[0].canBrowseChildren, false);
  assert.deepEqual(f.calls.filter(item => item.command === 'LIST').map(item => item.args[1]),
    ['','%','Archive','Archive.%','Flat','Missing','','Flat']);
  assert.equal(f.calls.some(event => !event.isSource), false);
});

test('scoped query withholds rows on limits, timeout, cancellation or lost authorization', async t => {
  const f = fixture(t);
  const run = options => f.probe.run(f.account, { mode: 'plan', scope: { kind: 'root' }, ...options });
  f.settings.scoped = pattern => pattern === '' ? [['','/']]
    : Array.from({ length: 101 }, (_, i) => [`folder-${i}`, '/']);
  const limited = await run(); assert.equal(limited.category, 'plan_scope_limit'); assert.equal(limited.plan, undefined);
  f.settings.scoped = pattern => {
    if (pattern === '') return [['','/']];
    throw new DOMException('fixture timed out', 'TimeoutError');
  };
  const timed = await run(); assert.equal(timed.category, 'plan_list_timeout'); assert.equal(timed.plan, undefined);
  const controller = new AbortController();
  f.settings.scoped = () => { controller.abort(); return [['','/']]; };
  assert.equal((await run({ signal: controller.signal })).category, 'interrupted');
  let current = true;
  f.settings.scoped = () => { current = false; return [['','/']]; };
  await assert.rejects(run({ authorize() {
    if (!current) throw Object.assign(new Error('revoked'), { statusCode: 401 });
  } }), { statusCode: 401 });
  assert.equal(f.calls.some(event => !event.isSource), false);
});
