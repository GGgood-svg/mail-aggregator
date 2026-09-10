const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CSP,
  parseTrustProxy,
  parseCookieSecure,
  parseBoolean,
  isLoopbackAddress,
  isLoopbackBindHost,
  resolveBindHost,
  validateHttpSecurityConfig,
  requireHttpsMiddleware,
  securityHeaders,
} = require('../server/http-security');

test('loopback detection accepts numeric local addresses only', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.12.34.56'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.evil.example'), false);
  assert.equal(isLoopbackAddress('127.999.0.1'), false);
  assert.equal(isLoopbackAddress('192.168.1.2'), false);
});

test('trust proxy accepts only bounded, explicit configurations', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('uniquelocal'), 'uniquelocal');
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('10'), 10);
  assert.equal(parseTrustProxy('true'), false);
  assert.equal(parseTrustProxy('99'), false);
  assert.equal(parseTrustProxy('0.0.0.0/0'), false);
});

test('secure cookie mode defaults to auto and supports explicit enforcement', () => {
  assert.equal(parseCookieSecure(undefined), 'auto');
  assert.equal(parseCookieSecure('auto'), 'auto');
  assert.equal(parseCookieSecure('true'), true);
  assert.equal(parseCookieSecure('1'), true);
  assert.equal(parseCookieSecure('false'), false);
  assert.equal(parseCookieSecure('0'), false);
  assert.equal(parseCookieSecure('unexpected'), 'auto');
});

test('bind host accepts valid local addresses and falls back safely', () => {
  assert.equal(resolveBindHost(undefined), '127.0.0.1');
  assert.equal(resolveBindHost(' 127.0.0.1 '), '127.0.0.1');
  assert.equal(resolveBindHost('::1'), '::1');
  assert.equal(resolveBindHost('localhost'), 'localhost');
  assert.equal(resolveBindHost('https://example.com'), '127.0.0.1');
});

test('HTTPS deployment settings reject spoofable or incomplete proxy configurations', () => {
  assert.equal(parseBoolean('yes'), true);
  assert.equal(parseBoolean('off'), false);
  assert.equal(isLoopbackBindHost('localhost'), true);
  assert.equal(isLoopbackBindHost('0.0.0.0'), false);
  assert.deepEqual(validateHttpSecurityConfig({ bindHost: '127.0.0.1', trustProxy: 'loopback', cookieSecure: true, requireHttps: true }), []);
  assert.equal(validateHttpSecurityConfig({ bindHost: '0.0.0.0', trustProxy: 1, cookieSecure: true, requireHttps: true }).length, 1);
  assert.equal(validateHttpSecurityConfig({ bindHost: '127.0.0.1', trustProxy: false, cookieSecure: 'auto', requireHttps: true }).length, 2);
});

test('HTTPS middleware blocks plain requests without redirecting to an attacker-controlled host', () => {
  let nextCalled = false;
  const output = {};
  const res = {
    status(code) { output.status = code; return this; },
    json(body) { output.body = body; return this; },
    type(value) { output.type = value; return this; },
    send(body) { output.body = body; return this; },
  };
  requireHttpsMiddleware(true)({ secure: false, path: '/api/auth/me' }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(output.status, 426);
  assert.match(output.body.error, /HTTPS/);
  requireHttpsMiddleware(true)({ secure: true, path: '/' }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

function invokeHeaders({ secure, path }) {
  const headers = new Map();
  let nextCalled = false;
  securityHeaders(
    { secure, path },
    { setHeader(name, value) { headers.set(name, value); } },
    () => { nextCalled = true; }
  );
  return { headers, nextCalled };
}

test('security middleware sets browser protections and disables API caching', () => {
  const { headers, nextCalled } = invokeHeaders({ secure: false, path: '/api/settings' });
  assert.equal(nextCalled, true);
  assert.equal(headers.get('Content-Security-Policy'), CSP);
  assert.match(headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(headers.get('Content-Security-Policy'), /img-src 'self' data: https: http:/);
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headers.get('X-Frame-Options'), 'DENY');
  assert.equal(headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(headers.get('Cache-Control'), 'no-store');
  assert.equal(headers.has('Strict-Transport-Security'), false);
});

test('HSTS is emitted only when Express considers the request secure', () => {
  const secure = invokeHeaders({ secure: true, path: '/index.html' }).headers;
  const plain = invokeHeaders({ secure: false, path: '/index.html' }).headers;
  assert.equal(secure.get('Strict-Transport-Security'), 'max-age=31536000');
  assert.equal(plain.has('Strict-Transport-Security'), false);
  assert.equal(secure.has('Cache-Control'), false);
});
