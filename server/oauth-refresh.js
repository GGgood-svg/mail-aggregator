const { getOAuthClient } = require('./oauth-store');
const { refreshOAuthTokens, isAccessTokenFresh } = require('./oauth-core');
const {
  readOAuthTokens,
  saveOAuthTokens,
  oauthAccessTokenPath,
} = require('./credentials');

async function ensureAccountOAuthToken(account, { force = false, fetchImpl } = {}) {
  if (!account || account.auth_type !== 'oauth2') throw new Error('账号未使用OAuth2');
  const tokens = readOAuthTokens(account.id);
  if (!tokens || !tokens.refreshToken) throw new Error('OAuth2账号尚未授权，请在账号编辑页重新授权');
  if (!force && isAccessTokenFresh(tokens)) {
    saveOAuthTokens(account.id, tokens);
    return oauthAccessTokenPath(account.id);
  }
  const client = getOAuthClient(account.provider);
  const refreshed = await refreshOAuthTokens({
    accountProvider: account.provider,
    client,
    tokens,
    fetchImpl,
  });
  saveOAuthTokens(account.id, refreshed);
  return oauthAccessTokenPath(account.id);
}

module.exports = { ensureAccountOAuthToken };
