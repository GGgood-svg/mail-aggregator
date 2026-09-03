const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  // Integration coverage is skipped on Node versions without node:sqlite.
}

const { cleanupExpired, cleanupKeepLatest } = require('../server/log-retention');
const integrationTest = DatabaseSync ? test : test.skip;

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-log-test-'));
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir);
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE sync_jobs (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      log_file TEXT
    );
    INSERT INTO accounts(id, name) VALUES(1, 'one'), (2, 'two');
  `);
  return {
    db,
    root,
    logDir,
    close() {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function addJob(harness, { id, accountId = 1, status = 'success', date }) {
  const logFile = path.join(harness.logDir, `job-${id}.log`);
  fs.writeFileSync(logFile, `job ${id}`);
  harness.db.prepare(
    `INSERT INTO sync_jobs(id,account_id,started_at,finished_at,status,log_file)
     VALUES(?,?,?,?,?,?)`
  ).run(id, accountId, date, status === 'queued' || status === 'running' ? null : date, status, logFile);
  return logFile;
}

integrationTest('expiry cleanup removes old completed jobs and files but preserves active and recent work', () => {
  const harness = createHarness();
  try {
    const oldFile = addJob(harness, { id: 1, date: '2026-01-01 00:00:00' });
    const activeFile = addJob(harness, { id: 2, status: 'running', date: '2026-01-01 00:00:00' });
    const recentFile = addJob(harness, { id: 3, date: '2026-04-25 00:00:00' });
    const result = cleanupExpired(harness.db, harness.logDir, 30, Date.parse('2026-05-01T00:00:00Z'));

    assert.equal(result.deletedJobs, 1);
    assert.equal(result.deletedFiles, 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(activeFile), true);
    assert.equal(fs.existsSync(recentFile), true);
    assert.deepEqual(
      harness.db.prepare('SELECT id FROM sync_jobs ORDER BY id').all().map((row) => row.id),
      [2, 3]
    );
  } finally {
    harness.close();
  }
});

integrationTest('expiry cleanup removes only old unreferenced canonical log files', () => {
  const harness = createHarness();
  try {
    const oldOrphan = path.join(harness.logDir, 'job-50.log');
    const recentOrphan = path.join(harness.logDir, 'job-51.log');
    const unrelated = path.join(harness.logDir, 'notes.log');
    fs.writeFileSync(oldOrphan, 'old');
    fs.writeFileSync(recentOrphan, 'recent');
    fs.writeFileSync(unrelated, 'unrelated');
    fs.utimesSync(oldOrphan, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    fs.utimesSync(recentOrphan, new Date('2026-04-25T00:00:00Z'), new Date('2026-04-25T00:00:00Z'));

    const result = cleanupExpired(harness.db, harness.logDir, 30, Date.parse('2026-05-01T00:00:00Z'));
    assert.equal(result.deletedOrphanFiles, 1);
    assert.equal(fs.existsSync(oldOrphan), false);
    assert.equal(fs.existsSync(recentOrphan), true);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    harness.close();
  }
});

integrationTest('manual cleanup keeps the newest completed jobs per account and never removes active jobs', () => {
  const harness = createHarness();
  try {
    addJob(harness, { id: 1, accountId: 1, date: '2026-01-01 00:00:00' });
    addJob(harness, { id: 2, accountId: 1, date: '2026-01-02 00:00:00' });
    addJob(harness, { id: 3, accountId: 1, status: 'queued', date: '2025-01-01 00:00:00' });
    addJob(harness, { id: 4, accountId: 2, date: '2026-01-01 00:00:00' });
    addJob(harness, { id: 5, accountId: 2, date: '2026-01-02 00:00:00' });

    const result = cleanupKeepLatest(harness.db, harness.logDir, 1);
    assert.equal(result.deletedJobs, 2);
    assert.deepEqual(
      harness.db.prepare('SELECT id FROM sync_jobs ORDER BY id').all().map((row) => row.id),
      [2, 3, 5]
    );
  } finally {
    harness.close();
  }
});
