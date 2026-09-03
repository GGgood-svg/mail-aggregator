const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePublicBaseUrl,
  isValidMicrosoftTenant,
  createPkce,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshOAuthTokens,
  isAccessTokenFresh,
} = require('../server/oauth-core');

test('OAuth public URL accepts HTTPS roots and loopback HTTP only', () => {
  assert.equal(normalizePublicBaseUrl(' https://mail.example.com/ '), 'https://mail.example.com');
  assert.equal(normalizePublicBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(normalizePublicBaseUrl('http://localhost:8080'), 'http://localhost:8080');
  for (const value of ['http://mail.example.com', 'https://mail.example.com/path', 'javascript:alert(1)', '']) {
    assert.equal(normalizePublicBaseUrl(value), null, value);
  }
});

test('PKCE and provider authorization URLs contain the required scopes and no secret', () => {
  const pkce = createPkce();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(pkce.challenge, /^[A-Za-z0-9_-]{43}$/);

  const google = new URL(buildAuthorizationUrl({
    accountProvider: 'gmail', clientId: 'google-id', redirectUri: 'https://mail.example.com/api/oauth/callback/google',
    state: 'state', codeChallenge: pkce.challenge, loginHint: 'user@gmail.com',
  }));
  assert.equal(google.origin, 'https://accounts.google.com');
  assert.equal(google.searchParams.get('scope'), 'https://mail.google.com/');
  assert.equal(google.searchParams.get('access_type'), 'offline');
  assert.equal(google.searchParams.get('prompt'), 'consent');
  assert.equal(google.searchParams.has('client_secret'), false);

  const microsoft = new URL(buildAuthorizationUrl({
    accountProvider: 'outlook', clientId: 'ms-id', tenant: 'organizations',
    redirectUri: 'https://mail.example.com/api/oauth/callback/microsoft', state: 'state',
    codeChallenge: pkce.challenge, loginHint: 'user@example.com',
  }));
  assert.match(microsoft.pathname, /organizations\/oauth2\/v2\.0\/authorize$/);
  assert.match(microsoft.searchParams.get('scope'), /offline_access/);
  assert.match(microsoft.searchParams.get('scope'), /IMAP\.AccessAsUser\.All/);
  assert.equal(isValidMicrosoftTenant('common'), true);
  assert.equal(isValidMicrosoftTenant('tenant.example.com'), true);
  assert.equal(isValidMicrosoftTenant('../bad'), false);
});

test('authorization-code exchange and refresh rotate tokens safely', async () => {
  const requests = [];
  const responses = [
    { access_token: 'access-one', refresh_token: 'refresh-one', expires_in: 3600, token_type: 'Bearer' },
    { access_token: 'access-two', refresh_token: 'refresh-two', expires_in: 1800, token_type: 'Bearer' },
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: new URLSearchParams(options.body) });
    return { ok: true, status: 200, json: async () => responses.shift() };
  };
  const client = { clientId: 'id', clientSecret: 'secret' };
  const first = await exchangeAuthorizationCode({
    accountProvider: 'gmail', client, redirectUri: 'https://mail.example.com/api/oauth/callback/google',
    code: 'code', codeVerifier: 'verifier', fetchImpl,
  });
  assert.equal(first.accessToken, 'access-one');
  assert.equal(first.refreshToken, 'refresh-one');
  assert.equal(requests[0].body.get('code_verifier'), 'verifier');
  assert.equal(requests[0].body.get('client_secret'), 'secret');

  const second = await refreshOAuthTokens({ accountProvider: 'gmail', client, tokens: first, fetchImpl });
  assert.equal(second.accessToken, 'access-two');
  assert.equal(second.refreshToken, 'refresh-two');
  assert.equal(requests[1].body.get('grant_type'), 'refresh_token');
  assert.equal(isAccessTokenFresh(second, Date.now(), 60 * 1000), true);
});

test('refresh retains the previous refresh token when Google omits a replacement', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'new-access', expires_in: 3600 }),
  });
  const result = await refreshOAuthTokens({
    accountProvider: 'gmail',
    client: { clientId: 'id', clientSecret: 'secret' },
    tokens: { accessToken: 'old', refreshToken: 'keep-me', expiresAt: 0 },
    fetchImpl,
  });
  assert.equal(result.refreshToken, 'keep-me');
});
