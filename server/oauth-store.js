const path = require('path');
const { randomUUID } = require('node:crypto');
const { db, DIRS } = require('./db');
const { writeSecret } = require('./credentials');
const {
  oauthProviderForAccount,
  isValidMicrosoftTenant,
  normalizePublicBaseUrl,
} = require('./oauth-core');
const { isValidSecret } = require('./validation');

const { CLIENT_FILE, readClientConfig, readLocalOAuthBase } = require('./oauth-config-file');
const CLIENT_CONFIG_PATH = path.join(DIRS.secrets, CLIENT_FILE);

function readClients(parsed = readClientConfig(DIRS.secrets)) {
  return { google: { ...(parsed?.google || {}) }, microsoft: { tenant: 'common', ...(parsed?.microsoft || {}) } };
}

function publicBaseUrl() {
  return readLocalOAuthBase(db, DIRS.secrets);
}

function publicOAuthConfig() {
  const config = readClientConfig(DIRS.secrets);
  const clients = readClients(config);
  return {
    publicBaseUrl: readLocalOAuthBase(db, DIRS.secrets, config),
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
  const before = JSON.stringify(clients);
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

  const previous = JSON.parse(before);
  for (const provider of ['google', 'microsoft']) {
    if (JSON.stringify(clients[provider]) !== JSON.stringify(previous[provider])) clients[provider].generation = randomUUID();
  }
  writeSecret(CLIENT_CONFIG_PATH, `${JSON.stringify({ ...clients, publicBaseUrl: baseUrl })}\n`);
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
    generation: client.generation || null,
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
