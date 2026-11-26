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
  // Node's built-in SQLite test driver is unavailable before Node 22.5.
}

const integrationTest = DatabaseSync ? test : test.skip;

let tempData = null;
let changeDovecotPassword = null;
if (DatabaseSync) {
  tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-dovecot-test-'));
  process.env.MAIL_AGG_DATA_DIR = tempData;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'better-sqlite3') {
      return function BetterSqliteShim(filename) {
        const database = new DatabaseSync(filename);
        database.pragma = (statement) => database.exec(`PRAGMA ${statement}`);
        return database;
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ changeDovecotPassword } = require('../server/dovecot'));
  Module._load = originalLoad;
}

test.after(() => {
  if (!DatabaseSync) return;
  require('../server/db').db.close();
  fs.rmSync(tempData, { recursive: true, force: true });
});

function dependencies(overrides = {}) {
  let hash = '{BLF-CRYPT}old-hash';
  return {
    localDovecot: () => ({ user: 'mailuser', host: '127.0.0.1', port: 143 }),
    imapLoginTest: async () => true,
    generateDovecotHash: async () => '{BLF-CRYPT}new-hash',
    runHelper: async (args) => {
      if (args[0] === 'get-hash') return { ok: true, stdout: hash };
      hash = args[0] === 'set-password' ? '{BLF-CRYPT}new-hash' : '{BLF-CRYPT}old-hash';
      return { ok: true, stdout: 'OK' };
    },
    saveGlobalLocalSecret: () => {},
    clearTargetPasswordOverrides: () => {},
    setSetting: () => {},
    sleep: async () => {},
    ...overrides,
  };
}

integrationTest('local secret write failure rolls Dovecot back before returning', async () => {
  const helperCalls = [];
  let hash = '{BLF-CRYPT}old-hash';
  const result = await changeDovecotPassword('old-password', 'new-password', dependencies({
    saveGlobalLocalSecret() { throw new Error('disk full'); },
    async runHelper(args) {
      helperCalls.push(args);
      if (args[0] === 'get-hash') return { ok: true, stdout: hash };
      hash = args[0] === 'set-password' ? '{BLF-CRYPT}new-hash' : '{BLF-CRYPT}old-hash';
      return { ok: true, stdout: 'OK' };
    },
  }));

  assert.equal(result.ok, false);
  assert.match(result.error, /已回滚 Dovecot 密码/);
  assert.deepEqual(helperCalls.map((args) => args[0]), ['get-hash', 'set-password', 'get-hash', 'get-hash', 'restore-backup', 'get-hash']);
});

integrationTest('failed helper write returns without committing the local secret', async () => {
  let secretWrites = 0;
  const result = await changeDovecotPassword('old-password', 'new-password', dependencies({
    runHelper: async args => args[0] === 'get-hash' ? { ok: true, stdout: '{BLF-CRYPT}old-hash' }
      : { ok: false, message: 'reload failed; previous users file restored' },
    saveGlobalLocalSecret() { secretWrites++; },
  }));

  assert.equal(result.ok, false);
  assert.match(result.error, /写入 Dovecot 密码失败/);
  assert.equal(secretWrites, 0);
});

integrationTest('successful password change commits the secret and drift settings', async () => {
  const settings = new Map();
  let saved = '';
  const result = await changeDovecotPassword('old-password', 'new-password', dependencies({
    saveGlobalLocalSecret(value) { saved = value; },
    setSetting(key, value) { settings.set(key, value); },
  }));

  assert.deepEqual(result, { ok: true });
  assert.equal(saved, 'new-password');
  assert.equal(settings.get('dovecot_last_known_hash'), '{BLF-CRYPT}new-hash');
  assert.equal(settings.get('dovecot_using_default_password'), 'false');
});

integrationTest('target password override cleanup failure stops before changing Dovecot', async () => {
  let helperCalls = 0;
  const result = await changeDovecotPassword('old-password', 'new-password', dependencies({
    clearTargetPasswordOverrides() { throw new Error('permission denied'); },
    async runHelper() { helperCalls++; return { ok: true, stdout: 'OK' }; },
  }));

  assert.equal(result.ok, false);
  assert.match(result.error, /尚未修改 Dovecot/);
  assert.equal(helperCalls, 0);
});

integrationTest('helper timeout after replacing users file restores and verifies the original password', async () => {
  let hash = '{BLF-CRYPT}old-hash', restored = 0, secretWrites = 0;
  const result = await changeDovecotPassword('old-password', 'new-password', dependencies({
    runHelper: async args => {
      if (args[0] === 'get-hash') return { ok: true, stdout: hash };
      if (args[0] === 'set-password') { hash = '{BLF-CRYPT}new-hash'; return { ok: false, message: 'timeout' }; }
      restored++; hash = '{BLF-CRYPT}old-hash'; return { ok: true, stdout: 'OK' };
    },
    imapLoginTest: async (_h, _p, _u, password) => password === 'old-password' && hash === '{BLF-CRYPT}old-hash',
    saveGlobalLocalSecret() { secretWrites++; },
  }));
  assert.equal(result.ok, false); assert.match(result.error, /已确认原密码和配置可用/);
  assert.equal(restored, 1); assert.equal(secretWrites, 0); assert.equal(hash, '{BLF-CRYPT}old-hash');
});

integrationTest('helper timeout does not overwrite an unrelated external edit or claim a verified rollback', async () => {
  let hash = '{BLF-CRYPT}old-hash', restored = 0;
  const result = await changeDovecotPassword('old-password', 'new-password', dependencies({
    runHelper: async args => {
      if (args[0] === 'get-hash') return { ok: true, stdout: hash };
      if (args[0] === 'set-password') { hash = '{BLF-CRYPT}external-edit'; return { ok: false, message: 'timeout' }; }
      restored++; return { ok: true, stdout: 'OK' };
    },
  }));
  assert.equal(result.ok, false); assert.match(result.error, /无法确认回滚/); assert.equal(restored, 0);
});
