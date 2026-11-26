#!/usr/bin/env node
'use strict';
const os = require('node:os');
const path = require('node:path');
const { dataPaths } = require('./data-paths');
const { withStateLock } = require('./state-lock');
const { acquireDataProcessLock } = require('./data-process');
const { createTotpSecurity } = require('./totp-security');
const { journalPresent } = require('./restore-journal');
const { withHostLock } = require('../scripts/updater/lock');

async function main() {
  if (process.platform !== 'linux' || os.userInfo().uid === 0) throw new Error('Run on Linux as the Web service user (usually mailadmin), after stopping Web');
  const [confirm, username] = process.argv.slice(2);
  if (process.argv.length !== 4 || confirm !== '--confirm-disable-totp' || !/^[\p{L}\p{N}_.@-]{2,64}$/u.test(username || '')) {
    throw new Error('Usage: node server/cli-totp-recovery.js --confirm-disable-totp <primary-admin-username>');
  }
  const dirs = dataPaths();
  const hostLock = process.env.MAIL_AGG_HOST_MAINTENANCE_LOCK || '/run/mail-aggregator-maintenance/lock';
  await withHostLock(hostLock, () => {
    const release = acquireDataProcessLock(dirs.root);
    try {
      return withStateLock(dirs.root, () => {
        if (journalPresent(dirs.root)) throw new Error('An application restore is not yet resolved');
        const Database = require('better-sqlite3');
        const db = new Database(path.join(dirs.db, 'mail-aggregator.db'), { fileMustExist: true, readonly: true });
        try {
          const user = db.prepare("SELECT id FROM admin_users WHERE username=? AND enabled=1 AND role='admin' AND mail_access_all=1").get(username);
          if (!user) throw new Error('Enabled primary administrator was not found');
          createTotpSecurity(dirs.root).offlineDisable(user);
        } finally { db.close(); }
      });
    } finally { release(); }
  });
  console.log('TOTP disabled and former sessions invalidated. Start Web, sign in with the existing password and enroll again.');
}
main().catch(error => {
  console.error(`TOTP recovery refused: ${error.code === 'maintenance_busy' ? 'another maintenance operation is running, or its lock is unavailable' : error.message}`);
  process.exitCode = 1;
});
