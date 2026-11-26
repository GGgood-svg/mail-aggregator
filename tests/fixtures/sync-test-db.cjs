'use strict';
const { DatabaseSync } = require('node:sqlite');

function configure(db) {
  db.transaction = job => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = job(...args); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return db;
}

function createDatabase() {
  const db = configure(new DatabaseSync(':memory:'));
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE sync_provider_cooldowns(provider_key TEXT PRIMARY KEY,retry_at TEXT NOT NULL);
    CREATE TABLE accounts(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      owner_user_id INTEGER NOT NULL DEFAULT 1, last_sync_at TEXT, last_sync_status TEXT, last_sync_message TEXT,
      last_sync_category TEXT, last_finished_job_id INTEGER, last_sync_attempt_at TEXT, last_sync_success_at TEXT,
      sync_failure_count INTEGER NOT NULL DEFAULT 0, sync_result_unknown INTEGER NOT NULL DEFAULT 0, sync_review_required INTEGER NOT NULL DEFAULT 0,
      sync_block_code TEXT, sync_block_since TEXT, sync_block_scope TEXT, sync_next_retry_at TEXT, sync_paused_until TEXT,
      last_host2_messages INTEGER, last_host2_folders INTEGER, last_transferred INTEGER, last_skipped INTEGER, last_errors INTEGER
    );
    CREATE TABLE sync_jobs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL DEFAULT 'queued',
      exit_code INTEGER, duration_ms INTEGER, pid INTEGER, pid_identity TEXT, stage TEXT, result_code TEXT, trigger_source TEXT, transport_state TEXT, mirror_at_release INTEGER,
      result_known INTEGER, result_message TEXT, next_attempt_at TEXT, transfer_started_at TEXT,
      host1_messages INTEGER, host2_messages INTEGER, host1_folders INTEGER, host2_folders INTEGER, messages_transferred INTEGER,
      messages_skipped INTEGER, errors INTEGER, log_file TEXT
    );
    CREATE UNIQUE INDEX idx_unique_active_job_per_account ON sync_jobs(account_id) WHERE status IN ('queued','running');
    CREATE TABLE fixture_events(job INTEGER PRIMARY KEY,kind TEXT);
  `);
  return db;
}

module.exports = { configure, createDatabase };
