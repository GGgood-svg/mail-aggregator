#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { dataPaths } = require('./data-paths');
const { acquireDataProcessLock } = require('./data-process');
const { journalPresent } = require('./restore-journal');
const { withHostLock } = require('../scripts/updater/lock');
const { createBackupPair, verifyBackupPair, rehearseBackupAccount } = require('./backup-pair');
const { version } = require('../package.json');

function databaseFrom(dirs) {
  return new Database(path.join(dirs.db, 'mail-aggregator.db'), { readonly: true, fileMustExist: true });
}
async function main(args) {
  const [command, ...rest] = args;
  if (command === 'create' && rest.length >= 3) {
    const [source, directory, passphrase, ...flags] = rest;
    const options = {};
    while (flags.length) {
      const flag = flags.shift();
      if (flag === '--stable-source' && !options.stableSource) options.stableSource = true;
      else if (flag === '--mailbox-user' && flags.length && !options.mailboxUser) options.mailboxUser = flags.shift();
      else if (flag === '--snapshot-id' && flags.length && !options.snapshotId) options.snapshotId = flags.shift();
      else throw new Error('无法识别的配对备份参数');
    }
    if (!options.stableSource || !options.mailboxUser || !options.snapshotId) throw new Error('请确认稳定快照并提供本地邮箱用户及快照标识');
    const dirs = dataPaths();
    const work = async () => {
      if (!fs.existsSync(path.join(dirs.db, 'mail-aggregator.db'))) throw new Error('找不到应用数据库，请核对 MAIL_AGG_DATA_DIR');
      const release = acquireDataProcessLock(dirs.root);
      let db;
      try {
        if (journalPresent(dirs.root)) throw new Error('上一次恢复有待核对，请先完成离线检查');
        db = databaseFrom(dirs);
        return await createBackupPair({ ...options, db, dirs, version, source, directory, passphrase });
      } finally { try { db?.close(); } finally { release(); } }
    };
    const lock = process.env.MAIL_AGG_HOST_MAINTENANCE_LOCK || '/run/mail-aggregator-maintenance/lock';
    return process.platform !== 'win32' && fs.existsSync(lock) ? withHostLock(lock, work) : work();
  }
  if (command === 'verify' && rest.length === 2) return verifyBackupPair({ directory: rest[0], passphrase: rest[1] });
  if (command === 'plan' && rest.length === 2) {
    const db = databaseFrom(dataPaths());
    try { return await verifyBackupPair({ directory: rest[0], passphrase: rest[1], compareDatabase: db }); }
    finally { db.close(); }
  }
  if (command === 'rehearse-account' && rest.length === 4 && /^[1-9]\d{0,15}$/.test(rest[3])) {
    return rehearseBackupAccount({ directory: rest[0], output: rest[1], passphrase: rest[2], accountId: rest[3] });
  }
  throw new Error('用法: create <Maildir快照> <备份父目录> <口令文件> --stable-source --mailbox-user <用户名> --snapshot-id <标识> | verify|plan <配对目录> <口令文件> | rehearse-account <配对目录> <演练父目录> <口令文件> <备份账号ID>');
}
if (require.main === module) {
  process.umask(0o077);
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`配对备份或演练失败: ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { main };
