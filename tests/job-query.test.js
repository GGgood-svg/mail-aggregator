const test = require('node:test');
const assert = require('node:assert/strict');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  // Query integration tests are skipped when node:sqlite is unavailable.
}

const { JOB_STATUSES, listJobs } = require('../server/job-query');
const integrationTest = DatabaseSync ? test : test.skip;

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_user_id INTEGER);
    CREATE TABLE sync_jobs (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO accounts(id,name,owner_user_id) VALUES(1,'one',10),(2,'two',20);
    INSERT INTO sync_jobs(id,account_id,started_at,status) VALUES
      (1,1,'2026-01-01 00:00:00','success'),
      (2,1,'2026-01-02 00:00:00','failed'),
      (3,1,'2026-01-03 00:00:00','success'),
      (4,2,'2026-01-04 00:00:00','success'),
      (5,2,'2026-01-05 00:00:00','running');
  `);
  return db;
}

integrationTest('job query paginates in stable newest-first order', () => {
  const db = createDatabase();
  try {
    const first = listJobs(db, { page: 1, pageSize: 2 });
    const second = listJobs(db, { page: 2, pageSize: 2 });
    assert.deepEqual(first.items.map((job) => job.id), [5, 4]);
    assert.deepEqual(second.items.map((job) => job.id), [3, 2]);
    assert.deepEqual(first.pagination, { page: 1, pageSize: 2, total: 5, totalPages: 3 });
  } finally {
    db.close();
  }
});

integrationTest('job query combines account and status filters', () => {
  const db = createDatabase();
  try {
    const result = listJobs(db, { accountId: 1, status: 'success', pageSize: 25 });
    assert.deepEqual(result.items.map((job) => job.id), [3, 1]);
    assert.equal(result.items[0].account_name, 'one');
    assert.equal(result.pagination.total, 2);
    assert.ok(JOB_STATUSES.includes('timed_out'));
  } finally {
    db.close();
  }
});

integrationTest('job query clamps pages beyond the final page and handles empty results', () => {
  const db = createDatabase();
  try {
    const last = listJobs(db, { page: 99, pageSize: 2 });
    assert.equal(last.pagination.page, 3);
    assert.deepEqual(last.items.map((job) => job.id), [1]);

    const empty = listJobs(db, { status: 'cancelled', page: 99, pageSize: 2 });
    assert.deepEqual(empty.items, []);
    assert.deepEqual(empty.pagination, { page: 1, pageSize: 2, total: 0, totalPages: 1 });
  } finally {
    db.close();
  }
});

integrationTest('job query never returns another user jobs', () => {
  const db = createDatabase();
  try {
    const result = listJobs(db, { ownerUserId: 10, pageSize: 25 });
    assert.deepEqual(result.items.map((job) => job.id), [3, 2, 1]);
    assert.equal(result.pagination.total, 3);
  } finally {
    db.close();
  }
});
