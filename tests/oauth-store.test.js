const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { /* Node <22.5 */ }
const integrationTest = DatabaseSync ? test : test.skip;
const modulePaths = ['../server/db', '../server/credentials', '../server/oauth-store']
  .map((name) => require.resolve(name));

function BetterSqliteShim(filename) {
  const database = new DatabaseSync(filename);
  database.pragma = (statement) => database.exec(`PRAGMA ${statement}`);
  return database;
}

function loadStore(dataDir) {
  const originalLoad = Module._load;
  const previousDataDir = process.env.MAIL_AGG_DATA_DIR;
  for (const modulePath of modulePaths) delete require.cache[modulePath];
  process.env.MAIL_AGG_DATA_DIR = dataDir;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'better-sqlite3') return BetterSqliteShim;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { store: require('../server/oauth-store'), dbModule: require('../server/db') };
  } finally {
    Module._load = originalLoad;
    if (previousDataDir === undefined) delete process.env.MAIL_AGG_DATA_DIR;
    else process.env.MAIL_AGG_DATA_DIR = previousDataDir;
  }
}

integrationTest('OAuth client settings keep secrets out of API-shaped public config', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-oauth-store-'));
  try {
    const { store, dbModule } = loadStore(dataDir);
    const publicConfig = store.saveOAuthConfig({
      publicBaseUrl: 'https://mail.example.com/',
      googleClientId: 'google-id',
      googleClientSecret: 'google-secret',
      microsoftClientId: 'microsoft-id',
      microsoftClientSecret: 'microsoft-secret',
      microsoftTenant: 'organizations',
    });
    assert.equal(publicConfig.publicBaseUrl, 'https://mail.example.com');
    assert.equal(publicConfig.google.configured, true);
    assert.equal(publicConfig.microsoft.configured, true);
    assert.equal(JSON.stringify(publicConfig).includes('google-secret'), false);
    assert.equal(JSON.stringify(publicConfig).includes('microsoft-secret'), false);

    const stored = JSON.parse(fs.readFileSync(store.CLIENT_CONFIG_PATH, 'utf8'));
    assert.equal(stored.google.clientSecret, 'google-secret');
    assert.equal(stored.microsoft.clientSecret, 'microsoft-secret');

    store.saveOAuthConfig({
      publicBaseUrl: 'https://mail.example.com',
      googleClientId: 'google-id-2',
      googleClientSecret: '',
      microsoftClientId: 'microsoft-id',
      microsoftClientSecret: '',
      microsoftTenant: 'organizations',
    });
    assert.equal(store.getOAuthClient('gmail').clientSecret, 'google-secret');
    assert.throws(() => store.saveOAuthConfig({ publicBaseUrl: 'http://public.example.com' }), /必须是HTTPS/);
    dbModule.db.close();
  } finally {
    for (const modulePath of modulePaths) delete require.cache[modulePath];
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
