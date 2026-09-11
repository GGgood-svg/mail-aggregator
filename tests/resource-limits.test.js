'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { accountLimit, diskCapacity } = require('../server/resource-limits');

function fakeDb(settings = {}, accountCount = 0) {
  return {
    prepare(sql) {
      if (sql.includes('FROM settings')) return { get: (key) => settings[key] === undefined ? undefined : { value: settings[key] } };
      if (sql.includes('COUNT(*)')) return { get: () => ({ count: accountCount }) };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('account limit uses validated configuration and current owner count', () => {
  assert.deepEqual(accountLimit(fakeDb({ max_accounts_per_user: '7' }, 6), 42), { maximum: 7, count: 6 });
  assert.deepEqual(accountLimit(fakeDb({ max_accounts_per_user: 'invalid' }, 2), 42), { maximum: 20, count: 2 });
});

test('disk capacity enforces reserve and fails closed when it cannot inspect storage', () => {
  const db = fakeDb({ min_free_disk_mb: '512' });
  assert.equal(diskCapacity(db, '/data', () => ({ bavail: 600, bsize: 1024 * 1024 })).ok, true);
  const low = diskCapacity(db, '/data', () => ({ bavail: 400, bsize: 1024 * 1024 }));
  assert.equal(low.ok, false);
  assert.equal(low.availableMb, 400);
  const failed = diskCapacity(db, '/data', () => { throw new Error('unavailable'); });
  assert.equal(failed.ok, false);
  assert.equal(failed.availableMb, null);
});
