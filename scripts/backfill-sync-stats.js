#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dataDirIndex = process.argv.indexOf('--data-dir');
if (dataDirIndex !== -1) {
  const value = process.argv[dataDirIndex + 1];
  if (!value) throw new Error('--data-dir requires a path');
  process.env.MAIL_AGG_DATA_DIR = path.resolve(value);
}
const { db, DIRS } = require('../server/db');
const { parseSummary } = require('../server/sync-output');

const logsRoot = `${path.resolve(DIRS.logs)}${path.sep}`;
const rows = db.prepare(`
  SELECT * FROM sync_jobs
  WHERE status = 'success' AND log_file IS NOT NULL
    AND (host1_messages IS NULL OR host2_messages IS NULL
      OR host1_folders IS NULL OR host2_folders IS NULL)
  ORDER BY id
`).all();

let updated = 0;
for (const row of rows) {
  const logFile = path.resolve(String(row.log_file || ''));
  if (!logFile.startsWith(logsRoot) || !/^job-\d+\.log$/.test(path.basename(logFile))) continue;
  try {
    if (fs.statSync(logFile).size > 25 * 1024 * 1024) continue;
    const summary = parseSummary(fs.readFileSync(logFile, 'utf8'));
    if (summary.host2Messages === null && summary.host2Folders === null) continue;
    db.prepare(`UPDATE sync_jobs SET
      host1_messages=COALESCE(host1_messages, ?), host2_messages=COALESCE(host2_messages, ?),
      host1_folders=COALESCE(host1_folders, ?), host2_folders=COALESCE(host2_folders, ?)
      WHERE id=?`).run(summary.host1Messages, summary.host2Messages, summary.host1Folders, summary.host2Folders, row.id);
    db.prepare(`UPDATE accounts SET
      last_host2_messages=COALESCE(last_host2_messages, ?),
      last_host2_folders=COALESCE(last_host2_folders, ?)
      WHERE id=?`).run(summary.host2Messages, summary.host2Folders, row.account_id);
    updated += 1;
  } catch (_) {}
}

console.log(`Backfilled sync totals for ${updated} job(s).`);
