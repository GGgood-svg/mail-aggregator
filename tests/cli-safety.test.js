const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('CLI backup uses the online backup implementation instead of copying a live SQLite directory', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'backup.sh'), 'utf8');
  assert.match(script, /server\/cli-backup\.js/);
  assert.doesNotMatch(script, /cp\s+-a\s+[^\n]*DATA_DIR[^\n]*db/);
});

test('CLI restore verifies before stopping and never directly extracts or deletes live state', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'restore.sh'), 'utf8');
  const verifyAt = script.indexOf('verify-backup.sh');
  const stopAt = script.indexOf('mail-aggregator stop');
  assert.ok(verifyAt >= 0 && stopAt > verifyAt, 'preflight must happen before service stop');
  assert.match(script, /server\/cli-restore\.js/);
  assert.doesNotMatch(script, /tar\s+x/);
  assert.doesNotMatch(script, /rm\s+-rf\s+[^\n]*DATA_DIR/);
});

test('direct CLI restore refuses to run without the stopped-service wrapper marker', () => {
  const source = fs.readFileSync(path.join(root, 'server', 'cli-restore.js'), 'utf8');
  assert.match(source, /MAIL_AGG_CLI_RESTORE_STOPPED/);
  assert.match(source, /verifyBackupArchive/);
  assert.match(source, /createBackupBundle/);
  assert.match(source, /restoreApplicationState/);
});

test('full installer generates a unique password instead of shipping a shared default', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf8');
  assert.doesNotMatch(script, /DEFAULT_INITIAL_PASSWORD=["']123456["']/);
  assert.match(script, /generate_initial_password\(\)/);
  assert.match(script, /od -An -N16 -tx1 \/dev\/urandom/);
  assert.match(script, /\$\{#INITIAL_DOVECOT_PASSWORD\}[^\n]*-eq 32/);
});
