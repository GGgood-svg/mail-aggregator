const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LOCK_MS,
  normalizedClientIp,
  LoginRateLimiter,
} = require('../server/login-rate-limit');

function fixture() {
  const rows = new Map();
  const db = {
    prepare(sql) {
      if (sql.startsWith('SELECT locked_until')) {
        return { get: (key) => rows.get(key) };
      }
      if (sql.startsWith('SELECT fail_count')) {
        return { get: (key) => rows.get(key) };
      }
      if (sql.startsWith('INSERT INTO login_attempts')) {
        return {
          run(key, failCount, lockedUntil, windowStarted) {
            rows.set(key, {
              ip: key,
              fail_count: failCount,
              locked_until: lockedUntil,
              window_started: windowStarted,
            });
          },
        };
      }
      if (sql.startsWith('DELETE FROM login_attempts WHERE ip=')) {
        return { run: (key) => rows.delete(key) };
      }
      if (sql.startsWith('DELETE FROM login_attempts')) {
        return {
          run(windowCutoff, lockCutoff) {
            for (const [key, row] of rows) {
              if ((row.window_started || 0) < windowCutoff && (row.locked_until || 0) < lockCutoff) rows.delete(key);
            }
          },
        };
      }
      throw new Error(`Unexpected SQL in fake database: ${sql}`);
    },
    close() {},
  };
  let now = 1_000_000;
  return { db, limiter: new LoginRateLimiter(db, { now: () => now }), setNow: (value) => { now = value; } };
}

test('trusted proxies must provide a forwarded client address', () => {
  const app = { get: () => 'loopback' };
  assert.equal(normalizedClientIp({ app, get: () => '', ip: '127.0.0.1' }), null);
  assert.equal(normalizedClientIp({ app, get: () => '203.0.113.8', ip: '203.0.113.8' }), '203.0.113.8');
  assert.equal(normalizedClientIp({ app: { get: () => false }, get: () => '', ip: '192.168.1.4' }), '192.168.1.4');
});

test('five failures lock only the same username and client address', () => {
  const { db, limiter } = fixture();
  for (let i = 0; i < 5; i++) limiter.failure('203.0.113.8', 'alice');
  assert.ok(limiter.check('203.0.113.8', 'alice') > 0);
  assert.equal(limiter.check('203.0.113.8', 'bob'), 0);
  assert.equal(limiter.check('203.0.113.9', 'alice'), 0);
  db.close();
});

test('failure windows expire and successful login clears only its scoped key', () => {
  const { db, limiter, setNow } = fixture();
  for (let i = 0; i < 4; i++) limiter.failure('203.0.113.8', 'alice');
  limiter.success('203.0.113.8', 'alice');
  assert.equal(limiter.check('203.0.113.8', 'alice'), 0);
  for (let i = 0; i < 5; i++) limiter.failure('203.0.113.8', 'alice');
  setNow(1_000_000 + LOCK_MS + 1);
  assert.equal(limiter.check('203.0.113.8', 'alice'), 0);
  limiter.failure('203.0.113.8', 'alice');
  assert.equal(limiter.check('203.0.113.8', 'alice'), 0);
  db.close();
});
