'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizePublicBaseUrl } = require('./oauth-core');

const CLIENT_FILE = 'oauth-clients.json';

function readClientConfig(directory) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, CLIENT_FILE), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('OAuth2客户端配置文件损坏');
  }
}

function readLocalOAuthBase(db, directory, config = readClientConfig(directory)) {
  // Older installs held the address in SQLite. An explicitly empty address in
  // the new file must take precedence so a restore cannot re-enable a stale URL.
  if (config && Object.hasOwn(config, 'publicBaseUrl')) return normalizePublicBaseUrl(config.publicBaseUrl) || '';
  const value = db.prepare("SELECT value FROM settings WHERE key='oauth_public_base_url'").get()?.value;
  return normalizePublicBaseUrl(value) || '';
}

function preserveLocalOAuthBase(db, liveDir, stagedDir) {
  const localBase = readLocalOAuthBase(db, liveDir);
  const restored = readClientConfig(stagedDir);
  if (restored || localBase) {
    const target = path.join(stagedDir, CLIENT_FILE);
    fs.writeFileSync(target, `${JSON.stringify({ ...restored, publicBaseUrl: localBase })}\n`, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
  }
}

module.exports = { CLIENT_FILE, readClientConfig, readLocalOAuthBase, preserveLocalOAuthBase };
