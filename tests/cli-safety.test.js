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

test('fresh installs bind locally and require an explicit exposure mode', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf8');
  assert.match(script, /MAIL_AGG_BIND_HOST="127\.0\.0\.1"/);
  assert.match(script, /--lan-http/);
  assert.match(script, /--https-proxy/);
  assert.match(script, /MAIL_AGG_REQUIRE_HTTPS="true"/);
  const openrc = fs.readFileSync(path.join(root, 'scripts', 'mail-aggregator.openrc'), 'utf8');
  assert.match(openrc, /MAIL_AGG_REQUIRE_HTTPS/);
});

test('installer exposes an explicit app-only mode and rejects conflicting full modes', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf8');
  assert.match(script, /--app-only\) APP_ONLY=1/);
  assert.match(script, /APP_ONLY[^\n]*FULL[^\n]*INSTALL_DOVECOT/);
  assert.match(script, /--app-only 不能与/);
});

test('installer stages a complete app tree and service logs are owner-only', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf8');
  assert.match(script, /APP_STAGE="\$\{APP_DIR\}\.deploy"/);
  assert.match(script, /! -d "\$APP_DIR"[^\n]*-d "\$APP_PREVIOUS"/);
  assert.match(script, /npm install --omit=dev --no-audit --no-fund/);
  assert.ok(script.indexOf('npm install --omit=dev') < script.indexOf('mv "$APP_STAGE" "$APP_DIR"'));
  const openrc = fs.readFileSync(path.join(root, 'scripts', 'mail-aggregator.openrc'), 'utf8');
  assert.match(openrc, /checkpath -f -m 0600/);
  assert.match(script, /chmod 700 "\$DATA_DIR"/);
});

test('app-only deployment installs locked dependencies and must restart the service', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf8');
  assert.match(source, /npm ci --omit=dev --no-audit --no-fund/);
  assert.match(source, /service_restart mail-aggregator \\\n\s*\|\| fail_step "9\/9"/);
  assert.doesNotMatch(source, /if \[ "\$FULL" = "1" \]; then\s*\n\s*if service_status mail-aggregator/);
});

test('installer rejects a Node.js runtime older than the package engine', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf8');
  assert.match(script, /process\.versions\.node\.split/);
  assert.match(script, /NODE_MAJOR[^\n]*-ge 18/);
  assert.match(script, /Node\.js 18\/20\/22/);
});

test('privileged Dovecot helper uses fixed root-owned target paths', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'dovecot-helper.sh'), 'utf8');
  assert.match(source, /USERS_FILE="\/etc\/dovecot\/users"/);
  assert.match(source, /PERMS_LIB="\/usr\/local\/sbin\/mail-aggregator-dovecot-perms\.sh"/);
  assert.doesNotMatch(source, /MAIL_AGG_DOVECOT_(?:USERS_FILE|BACKUP_FILE|PERMS_LIB)/);
});
