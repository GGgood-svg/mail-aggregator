'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const native = process.env.MAIL_TEST_NATIVE_SQLITE === '1';
const Database = native ? require('better-sqlite3') : require('node:sqlite').DatabaseSync;
const { reconcileStartup, lastRestoreResult } = require('../server/restore-journal');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-restore-powercut-'));
  const dirs = { root, db: path.join(root, 'db'), secrets: path.join(root, 'secrets'), tmp: path.join(root, 'tmp'), cache: path.join(root, 'cache') };
  const filename = path.join(dirs.db, 'mail-aggregator.db');
  const sourceSecrets = path.join(root, 'source-secrets');
  for (const folder of [dirs.db, dirs.tmp, dirs.secrets, dirs.cache, sourceSecrets]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(dirs.cache, 'stale-sync-state'), 'fixture');
  for (const [file, label] of [[filename, 'original'], [path.join(root, 'source.db'), 'restored']]) {
    const db = new Database(file);
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE admin_users(id INTEGER PRIMARY KEY,username TEXT,password_hash TEXT);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE accounts(id INTEGER PRIMARY KEY,name TEXT,username TEXT);
      CREATE TABLE sync_jobs(id INTEGER PRIMARY KEY,account_id INTEGER,status TEXT,finished_at TEXT,pid INTEGER);
      CREATE TABLE notification_events(account_id INTEGER PRIMARY KEY);
      INSERT INTO admin_users VALUES(1,'synthetic','fixture-hash');`);
    db.prepare('INSERT INTO accounts VALUES(1,?,?)').run(label, 'synthetic@example.invalid');
    db.close();
  }
  fs.writeFileSync(path.join(dirs.secrets, 'account.pass'), 'original');
  fs.writeFileSync(path.join(dirs.secrets, 'local-target.pass'), 'preserved-local');
  fs.writeFileSync(path.join(sourceSecrets, 'account.pass'), 'restored');
  fs.writeFileSync(path.join(sourceSecrets, 'local-target.pass'), 'ignored-local');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { dirs, filename };
}

async function killAt(root, name) {
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/restore-crash-worker.cjs'), root, name],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '', output = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  let timer;
  try {
    const reached = new Promise(resolve => child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(`checkpoint ${name}\n`)) resolve();
    }));
    await Promise.race([reached, closed.then(() => assert.fail(`Worker exited before ${name}: ${stderr}`)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`No checkpoint ${name}`)), 8000); })]);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await closed;
  }
}

for (const [name, expected] of [['journal', 'original'], ['old-moved', 'original'], ['new-live', 'original'],
  ['committed', 'restored'], ['stage-cleaned', 'restored'], ['lock-released', 'restored'], ['journal-retired', 'restored']]) {
  test(`startup reconciles matching database and credentials after forced exit at ${name}`, async t => {
    const { dirs, filename } = fixture(t);
    await killAt(dirs.root, name);
    const recover = () => {
      if (native) require('../server/data-process').startDataProcess(dirs)();
      else reconcileStartup(dirs, file => new Database(file));
    };
    recover();
    recover();
    const db = new Database(filename);
    try {
      assert.equal(db.prepare('SELECT name FROM accounts').get().name, expected);
      assert.equal(fs.readFileSync(path.join(dirs.secrets, 'account.pass'), 'utf8'), expected);
      assert.equal(fs.readFileSync(path.join(dirs.secrets, 'local-target.pass'), 'utf8'), 'preserved-local');
      assert.equal(fs.existsSync(path.join(dirs.cache, 'stale-sync-state')), expected === 'original');
      assert.equal(lastRestoreResult(db).outcome, expected === 'original' ? 'rolled_back' :
        name === 'journal-retired' ? 'committed' : 'recovered_committed');
      assert.ok(!fs.readdirSync(dirs.root).some(name => /^\.restore-|^\.state-write/.test(name)));
    } finally { db.close(); }
  });
}

test('startup preserves ambiguous old recovery data and rejects damaged journals and unowned locks', t => {
  const { dirs } = fixture(t);
  const startup = () => reconcileStartup(dirs, () => assert.fail('unsafe database open'));
  const journal = path.join(dirs.root, '.restore-journal.json');
  const lock = path.join(dirs.root, '.state-write.lock');
  fs.writeFileSync(journal, '{broken');
  assert.throws(startup, /恢复状态需要检查/);
  assert.equal(fs.readFileSync(journal, 'utf8'), '{broken');
  fs.unlinkSync(journal);
  fs.writeFileSync(lock, '{}');
  assert.throws(startup, /归属/);
  assert.ok(fs.existsSync(lock));
  fs.unlinkSync(lock);
  const old = path.join(dirs.tmp, 'web-restore-legacy', 'old-secrets');
  fs.mkdirSync(old, { recursive: true });
  assert.throws(startup, /旧版本/);
  assert.ok(fs.existsSync(old));
});
