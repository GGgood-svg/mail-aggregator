const path = require('path');
const fs = require('fs');
const { db, DIRS } = require('./db');
const { writeSecret } = require('./credentials');
const {
  oauthProviderForAccount,
  isValidMicrosoftTenant,
  normalizePublicBaseUrl,
} = require('./oauth-core');
const { isValidSecret } = require('./validation');

const CLIENT_CONFIG_PATH = path.join(DIRS.secrets, 'oauth-clients.json');

function readClients() {
  if (!fs.existsSync(CLIENT_CONFIG_PATH)) return { google: {}, microsoft: { tenant: 'common' } };
  try {
    const parsed = JSON.parse(fs.readFileSync(CLIENT_CONFIG_PATH, 'utf8'));
    return {
      google: parsed.google || {},
      microsoft: { tenant: 'common', ...(parsed.microsoft || {}) },
    };
  } catch (_) {
    throw new Error('OAuth2客户端配置文件损坏');
  }
}

function publicBaseUrl() {
  const row = db.prepare("SELECT value FROM settings WHERE key='oauth_public_base_url'").get();
  return row ? row.value : '';
}

function publicOAuthConfig() {
  const clients = readClients();
  return {
    publicBaseUrl: publicBaseUrl(),
    google: {
      clientId: clients.google.clientId || '',
      hasClientSecret: !!clients.google.clientSecret,
      configured: !!clients.google.clientId && !!clients.google.clientSecret,
    },
    microsoft: {
      clientId: clients.microsoft.clientId || '',
      tenant: clients.microsoft.tenant || 'common',
      hasClientSecret: !!clients.microsoft.clientSecret,
      configured: !!clients.microsoft.clientId && !!clients.microsoft.clientSecret,
    },
  };
}

function normalizedClientId(value, label) {
  const result = String(value || '').trim();
  if (result.length > 512 || /[\r\n\0]/.test(result)) throw new Error(`${label} Client ID格式不合法`);
  return result;
}

function saveOAuthConfig(input) {
  const baseUrl = normalizePublicBaseUrl(input.publicBaseUrl);
  if (!baseUrl) throw new Error('OAuth2公开地址必须是HTTPS站点根地址；仅localhost允许HTTP');
  const clients = readClients();
  clients.google.clientId = normalizedClientId(input.googleClientId, 'Google');
  clients.microsoft.clientId = normalizedClientId(input.microsoftClientId, 'Microsoft');
  const tenant = String(input.microsoftTenant || 'common').trim();
  if (!isValidMicrosoftTenant(tenant)) throw new Error('Microsoft tenant格式不合法');
  clients.microsoft.tenant = tenant;

  for (const [field, target] of [
    ['googleClientSecret', clients.google],
    ['microsoftClientSecret', clients.microsoft],
  ]) {
    const value = input[field];
    if (value !== undefined && value !== '') {
      if (!isValidSecret(value)) throw new Error('OAuth2 Client Secret格式不合法');
      target.clientSecret = value;
    }
  }

  writeSecret(CLIENT_CONFIG_PATH, `${JSON.stringify(clients)}\n`);
  db.prepare(`INSERT INTO settings(key,value) VALUES('oauth_public_base_url',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(baseUrl);
  return publicOAuthConfig();
}

function getOAuthClient(accountProvider) {
  const provider = oauthProviderForAccount(accountProvider);
  if (!provider) throw new Error('该账号不支持OAuth2');
  const clients = readClients();
  const client = clients[provider];
  if (!client || !client.clientId || !client.clientSecret) {
    throw new Error(`${provider === 'google' ? 'Google' : 'Microsoft'} OAuth2客户端尚未配置`);
  }
  return {
    provider,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    tenant: provider === 'microsoft' ? client.tenant || 'common' : undefined,
  };
}

module.exports = {
  CLIENT_CONFIG_PATH,
  readClients,
  publicBaseUrl,
  publicOAuthConfig,
  saveOAuthConfig,
  getOAuthClient,
};
