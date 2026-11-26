const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMaildirBackup, verifyMaildirBackup, rehearseMaildirBackup } = require('../server/maildir-backup');

const tempBase = process.env.MAIL_TEST_TEMP_BASE || os.tmpdir();
const msys = value => {
  if (process.platform !== 'win32') return value;
  const converted = value.replace(/\\/g, '/');
  return `/${converted[0].toLowerCase()}${converted.slice(2)}`;
};
const options = { gpg: process.env.MAIL_TEST_GPG || 'gpg', tar: process.env.MAIL_TEST_TAR || 'tar',
  gpgconf: process.env.MAIL_TEST_GPGCONF || 'gpgconf', homeBase: tempBase, toolPath: msys };

test('encrypted Maildir backup verifies, rehearses and preserves local control files', async t => {
  const base = fs.realpathSync(tempBase), root = fs.mkdtempSync(path.join(base, 'maildir-it-'));
  t.after(() => {
    const actual = fs.realpathSync(root);
    if (path.dirname(actual) !== base || !path.basename(actual).startsWith('maildir-it-')) throw new Error('Unexpected cleanup path');
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const source = path.join(root, 'Maildir'), backup = path.join(root, 'backups'), restore = path.join(root, 'restore');
  for (const directory of [source, backup, restore, ...['cur', 'new', 'tmp'].map(name => path.join(source, name))]) fs.mkdirSync(directory);
  const key = path.join(root, 'key'), wrong = path.join(root, 'wrong');
  fs.writeFileSync(key, 'fictional backup passphrase 123456\n', { mode: 0o600 });
  fs.writeFileSync(wrong, 'fictional incorrect passphrase 123\n', { mode: 0o600 });
  const longName = 'message-' + 'x'.repeat(130);
  fs.writeFileSync(path.join(source, 'cur', longName), 'synthetic message body');
  fs.writeFileSync(path.join(source, 'dovecot-uidlist'), '3 V123 N8\n7 :message\n');
  fs.writeFileSync(path.join(source, 'dovecot-keywords'), '0 example\n');
  await assert.rejects(createMaildirBackup({ source, directory: backup, passphrase: key, ...options }), /稳定快照/);
  await assert.rejects(createMaildirBackup({ source, directory: source, passphrase: key, stableSource: true, ...options }), /不能位于/);
  await assert.rejects(createMaildirBackup({ source, directory: backup, passphrase: key, stableSource: true, ...options, homeBase: path.join(source, 'tmp') }), /不能位于/);
  const first = await createMaildirBackup({ source, directory: backup, passphrase: key, stableSource: true, ...options });
  assert.ok(fs.existsSync(first.archive));
  assert.ok(!fs.readFileSync(first.archive).includes(Buffer.from('synthetic message body')));
  const verified = await verifyMaildirBackup({ archive: first.archive, passphrase: key, ...options });
  assert.ok(verified.entries >= 7); assert.ok(verified.bytes > 0);
  if (process.platform !== 'win32') {
    const link = path.join(source, 'cur', 'unsafe-link');
    fs.symlinkSync('/etc/passwd', link);
    const before = fs.readdirSync(backup).sort();
    await assert.rejects(createMaildirBackup({ source, directory: backup, passphrase: key, stableSource: true, ...options }));
    assert.deepEqual(fs.readdirSync(backup).sort(), before);
    fs.unlinkSync(link);
  }
  await assert.rejects(verifyMaildirBackup({ archive: first.archive, passphrase: wrong, ...options }));
  const damaged = path.join(root, 'damaged.gpg'), bytes = fs.readFileSync(first.archive);
  bytes[Math.floor(bytes.length / 2)] ^= 1; fs.writeFileSync(damaged, bytes);
  await assert.rejects(verifyMaildirBackup({ archive: damaged, passphrase: key, ...options }));
  await assert.rejects(rehearseMaildirBackup({ archive: damaged, directory: restore, passphrase: key, ...options }));
  assert.deepEqual(fs.readdirSync(restore), []);
  await assert.rejects(rehearseMaildirBackup({ archive: first.archive, directory: source, passphrase: key, ...options }), /不能位于 Maildir/);
  const result = await rehearseMaildirBackup({ archive: first.archive, directory: restore, passphrase: key, ...options });
  assert.equal(fs.readFileSync(path.join(result.directory, 'cur', longName), 'utf8'), 'synthetic message body');
  assert.equal(fs.readFileSync(path.join(result.directory, 'dovecot-uidlist'), 'utf8'), '3 V123 N8\n7 :message\n');
  assert.equal(fs.readFileSync(path.join(result.directory, 'dovecot-keywords'), 'utf8'), '0 example\n');
  const unrelated = path.join(backup, 'notes.txt'); fs.writeFileSync(unrelated, 'preserve');
  const second = await createMaildirBackup({ source, directory: backup, passphrase: key, stableSource: true, keep: 1, ...options });
  assert.equal(second.removed, 1); assert.ok(fs.existsSync(second.archive)); assert.ok(!fs.existsSync(first.archive));
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'preserve');
});

test('paired backup rejects mixed archives and stages only the selected account', async t => {
  const Database = require('better-sqlite3');
  const { createBackupPair, verifyBackupPair, rehearseBackupAccount } = require('../server/backup-pair');
  const base = fs.realpathSync(tempBase), root = fs.mkdtempSync(path.join(base, 'maildir-pair-'));
  const dirs = { root: path.join(root, 'app') };
  for (const name of ['db', 'tmp', 'secrets']) dirs[name] = path.join(dirs.root, name);
  t.after(() => {
    const actual = fs.realpathSync(root);
    if (path.dirname(actual) !== base || !path.basename(actual).startsWith('maildir-pair-')) throw new Error('Unexpected cleanup path');
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const source = path.join(root, 'Maildir'), directory = path.join(root, 'pairs'), output = path.join(root, 'rehearsals');
  const subfolders = ['', '.Alpha', '.Alpha.Invoices', '.AlphaExtra', '.Beta', '.Case', '.CASE.Sub'];
  for (const folder of subfolders) for (const kind of ['cur', 'new', 'tmp']) {
    fs.mkdirSync(path.join(source, folder, kind), { recursive: true, mode: 0o700 });
  }
  for (const working of [directory, output, ...Object.values(dirs)]) fs.mkdirSync(working, { mode: 0o700 });
  const db = new Database(path.join(dirs.db, 'mail-aggregator.db'));
  try {
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, provider TEXT, username TEXT,
      local_user TEXT, destination_mode TEXT, mailbox_folder TEXT, destination_folder TEXT);
      INSERT INTO accounts VALUES
      (1,'Alpha','custom','alpha@example.test','local','subfolder','Alpha',NULL),
      (2,'Beta','custom','beta@example.test','local','subfolder','Beta',NULL),
      (3,'Flat','custom','flat@example.test','local','flat',NULL,NULL),
      (4,'Elsewhere','custom','elsewhere@example.test','elsewhere','subfolder','Elsewhere',NULL),
      (5,'Conflict','custom','case@example.test','local','subfolder','Case',NULL);`);
    fs.mkdirSync(path.join(dirs.secrets, '1'), { mode: 0o700 });
    fs.writeFileSync(path.join(dirs.secrets, '1', 'source.pass'), 'fixture credential\n', { mode: 0o600 });
    const key = path.join(root, 'key');
    fs.writeFileSync(key, 'synthetic pairing passphrase 123456\n', { mode: 0o600 });
    const selectedName = process.platform === 'win32' ? 'first-mail' : 'first-mail:2,FS';
    const firstTime = new Date('2026-01-02T03:04:05.000Z'), secondTime = new Date('2026-02-03T04:05:06.000Z');
    const selectedMessage = path.join('.Alpha', 'cur', selectedName);
    const otherMessage = path.join('.Beta', 'new', 'beta-mail');
    for (const [file, content, time] of [
      [selectedMessage, 'selected mail', firstTime],
      [path.join('.Alpha.Invoices', 'new', 'next-mail'), '', secondTime],
      [path.join('.AlphaExtra', 'new', 'prefix-sibling'), 'not selected'],
      [otherMessage, 'other account'],
      [path.join('new', 'inbox-mail'), 'unmapped mail'],
      [path.join('.Case', 'cur', 'same-spelling'), 'case A'],
      [path.join('.CASE.Sub', 'cur', 'different-spelling'), 'case B'],
    ]) {
      const target = path.join(source, file);
      fs.writeFileSync(target, content);
      if (time) fs.utimesSync(target, time, time);
    }
    const uidList = '3 V137 N8\n7 :first-mail\n';
    fs.writeFileSync(path.join(source, '.Alpha', 'dovecot-uidlist'), uidList);
    const capture = snapshotId => createBackupPair({ db, dirs, version: '0.1.6', directory, source, passphrase: key,
      mailboxUser: 'local', snapshotId, stableSource: true, mailTools: options });
    const first = await capture('snapshot-a');
    assert.equal(first.accounts[0].messages, 2);
    assert.equal(first.accounts[0].folders, 2);
    assert.deepEqual(first.accounts.map(row => row.scope), ['covered', 'covered', 'unmapped', 'outside_snapshot', 'name_conflict']);
    assert.equal(first.unmappedMessages, 4);
    assert.equal(first.accounts[0].firstMaildirTimestamp, firstTime.toISOString());
    assert.equal(first.accounts[0].lastMaildirTimestamp, secondTime.toISOString());
    db.prepare('UPDATE accounts SET username=? WHERE id=1').run('renamed@example.test');
    fs.writeFileSync(path.join(source, otherMessage), 'different, valid second backup');
    const second = await capture('snapshot-b');
    const verify = () => verifyBackupPair({ directory: first.directory, passphrase: key, compareDatabase: db, mailTools: options });
    const original = await verify();
    assert.equal(original.verified, true);
    assert.equal(original.appFileCount, 2);
    assert.deepEqual(original.localComparison.slice(0, 2).map(row => row.status), ['name_conflict', 'same_scope_and_source']);
    for (const name of ['maildir.tar.gz.gpg', 'application.tar.gz']) {
      const target = path.join(first.directory, name), bytes = fs.readFileSync(target);
      fs.copyFileSync(path.join(second.directory, name), target);
      try { await assert.rejects(verify(), /同一组清单/); }
      finally { fs.writeFileSync(target, bytes); }
    }
    const rehearse = accountId => rehearseBackupAccount({ directory: first.directory, output, passphrase: key, accountId, mailTools: options });
    await assert.rejects(rehearse(5), /没有可独立演练/);
    assert.deepEqual(fs.readdirSync(output), []);
    const result = await rehearse(1);
    assert.deepEqual(fs.readdirSync(result.directory).sort(), ['.Alpha', '.Alpha.Invoices', 'cur', 'new', 'tmp']);
    assert.equal(fs.readFileSync(path.join(result.directory, selectedMessage), 'utf8'), 'selected mail');
    assert.equal(fs.readFileSync(path.join(result.directory, '.Alpha', 'dovecot-uidlist'), 'utf8'), uidList);
    assert.equal(fs.statSync(path.join(result.directory, selectedMessage)).mtime.toISOString(), firstTime.toISOString());
    assert.equal(fs.statSync(path.join(result.directory, '.Alpha.Invoices', 'new', 'next-mail')).size, 0);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(result.directory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(result.directory, selectedMessage)).mode & 0o777, 0o600);
    }
    assert.equal(result.assurance, 'isolated_files_only');
    assert.equal(fs.readdirSync(output).length, 1);
  } finally { db.close(); }
});
