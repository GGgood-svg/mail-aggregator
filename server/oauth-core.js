const crypto = require('crypto');

const ACCOUNT_PROVIDER_MAP = {
  gmail: 'google',
  outlook: 'microsoft',
};

const PROVIDERS = {
  google: {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    scopes: ['https://mail.google.com/'],
  },
  microsoft: {
    scopes: ['offline_access', 'https://outlook.office.com/IMAP.AccessAsUser.All'],
  },
};

function oauthProviderForAccount(accountProvider) {
  return ACCOUNT_PROVIDER_MAP[accountProvider] || null;
}

function isValidMicrosoftTenant(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 255
    && /^(common|organizations|consumers|[a-zA-Z0-9][a-zA-Z0-9.-]*)$/.test(value);
}

function normalizePublicBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch (_) { return null; }
  const loopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  return parsed.origin;
}

function createPkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function createOAuthState() {
  return crypto.randomBytes(32).toString('base64url');
}

function providerEndpoints(accountProvider, tenant = 'common') {
  const provider = oauthProviderForAccount(accountProvider);
  if (provider === 'google') return { provider, ...PROVIDERS.google };
  if (provider === 'microsoft') {
    if (!isValidMicrosoftTenant(tenant)) throw new Error('Microsoft tenant 格式不合法');
    const encodedTenant = encodeURIComponent(tenant);
    return {
      provider,
      scopes: PROVIDERS.microsoft.scopes,
      authorizationEndpoint: `https://login.microsoftonline.com/${encodedTenant}/oauth2/v2.0/authorize`,
      tokenEndpoint: `https://login.microsoftonline.com/${encodedTenant}/oauth2/v2.0/token`,
    };
  }
  throw new Error('该账号不支持OAuth2');
}

function buildAuthorizationUrl({
  accountProvider,
  clientId,
  tenant,
  redirectUri,
  state,
  codeChallenge,
  loginHint,
}) {
  const definition = providerEndpoints(accountProvider, tenant);
  const url = new URL(definition.authorizationEndpoint);
  const params = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: definition.scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    login_hint: loginHint,
  };
  if (definition.provider === 'google') {
    params.access_type = 'offline';
    params.prompt = 'consent';
    params.include_granted_scopes = 'true';
  } else {
    params.response_mode = 'query';
  }
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function safeProviderError(payload, status) {
  const raw = payload && (payload.error_description || payload.error);
  const message = typeof raw === 'string'
    ? raw.replace(/[\r\n\0]/g, ' ').slice(0, 300)
    : `HTTP ${status}`;
  return new Error(`OAuth2令牌请求失败: ${message}`);
}

async function postToken(endpoint, params, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前Node.js运行时不支持OAuth2网络请求');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    let payload;
    try { payload = await response.json(); } catch (_) { payload = null; }
    if (!response.ok || !payload || !payload.access_token) {
      throw safeProviderError(payload, response.status);
    }
    return payload;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('OAuth2令牌请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTokenPayload(payload, previousRefreshToken = null, nowMs = Date.now()) {
  const refreshToken = payload.refresh_token || previousRefreshToken;
  if (!refreshToken) throw new Error('OAuth2授权未返回refresh token，请撤销旧授权后重新授权');
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    refreshToken,
    expiresAt: nowMs + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    tokenType: payload.token_type || 'Bearer',
    scope: payload.scope || '',
  };
}

async function exchangeAuthorizationCode({
  accountProvider,
  client,
  redirectUri,
  code,
  codeVerifier,
  fetchImpl,
}) {
  const definition = providerEndpoints(accountProvider, client.tenant);
  const payload = await postToken(definition.tokenEndpoint, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }, { fetchImpl });
  return normalizeTokenPayload(payload);
}

async function refreshOAuthTokens({ accountProvider, client, tokens, fetchImpl }) {
  const definition = providerEndpoints(accountProvider, client.tenant);
  const params = {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: tokens.refreshToken,
    grant_type: 'refresh_token',
  };
  if (definition.provider === 'microsoft') params.scope = definition.scopes.join(' ');
  const payload = await postToken(definition.tokenEndpoint, params, { fetchImpl });
  return normalizeTokenPayload(payload, tokens.refreshToken);
}

function isAccessTokenFresh(tokens, nowMs = Date.now(), minimumValidityMs = 5 * 60 * 1000) {
  return !!tokens
    && typeof tokens.accessToken === 'string'
    && tokens.accessToken.length > 0
    && Number(tokens.expiresAt) - nowMs > minimumValidityMs;
}

module.exports = {
  oauthProviderForAccount,
  isValidMicrosoftTenant,
  normalizePublicBaseUrl,
  createPkce,
  createOAuthState,
  providerEndpoints,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshOAuthTokens,
  isAccessTokenFresh,
};
