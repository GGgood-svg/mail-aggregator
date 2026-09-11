'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadCredentials(secretsDir) {
  const modulePath = require.resolve('../server/credentials');
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === './db' && parent && parent.filename === modulePath) return { DIRS: { secrets: secretsDir } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require('../server/credentials'); }
  finally { Module._load = originalLoad; }
}

test('account credential snapshot restores replaced and deleted secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-agg-secrets-'));
  try {
    const credentials = loadCredentials(dir);
    credentials.saveSourceSecret(7, 'original-source');
    credentials.saveTargetSecret(7, 'original-target');
    const snapshot = credentials.snapshotAccountSecrets(7);
    credentials.saveSourceSecret(7, 'replacement');
    credentials.deleteSourceSecret(7);
    credentials.saveOAuthTokens(7, { accessToken: 'access', refreshToken: 'refresh' });
    credentials.restoreAccountSecrets(7, snapshot);
    assert.equal(fs.readFileSync(credentials.sourcePassPath(7), 'utf8'), 'original-source');
    assert.equal(fs.readFileSync(credentials.targetPassPath(7), 'utf8'), 'original-target');
    assert.equal(credentials.hasOAuthTokens(7), false);
  } finally {
    delete require.cache[require.resolve('../server/credentials')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
