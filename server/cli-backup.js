#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { dataPaths } = require('./data-paths');
const { journalPresent } = require('./restore-journal');
const { createBackupBundle } = require('./backup');
const { version } = require('../package.json');
const { inspectRestoreDatabase } = require('./restore');

function atomicCopy(source, destination, mode = 0o600) {
  const temporary = `${destination}.tmp.${process.pid}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(temporary, mode);
    fs.linkSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function inspectSource(filename) {
  const snapshot = inspectRestoreDatabase(Database, filename, { strict: true });
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const administrators = db.prepare(`SELECT COUNT(*) AS n FROM admin_users
      WHERE role='admin' AND enabled=1 AND length(password_hash)>0`).get().n;
    if (!administrators) throw new Error('数据库没有已启用的管理员，请核对备份来源');
    return { administrators, accounts: snapshot.accountCount, settings: snapshot.settingCount };
  } finally { db.close(); }
}

async function main() {
  const dirs = dataPaths();
  const filename = path.join(dirs.db, 'mail-aggregator.db');
  console.log(`备份数据目录: ${dirs.root}`);
  if (!fs.existsSync(filename) || !fs.lstatSync(filename).isFile()) throw new Error('找不到现有应用数据库，请核对 MAIL_AGG_DATA_DIR');
  if (journalPresent(dirs.root)) throw new Error('存在未完成的恢复，请先核对恢复状态');
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  let bundle;
  try {
    // Check the actual SQLite snapshot before archiving or publishing anything.
    bundle = await createBackupBundle({ db, dirs, version, inspectSnapshot: inspectSource, migrateNotificationConfig: false });
    console.log(`管理员: ${bundle.snapshot.administrators}；账号: ${bundle.snapshot.accounts}`);
    const destinationDir = path.resolve(process.argv[2] || '/root/mail-aggregator-backups');
    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
    const archivePath = path.join(destinationDir, bundle.filename);
    const checksumPath = path.join(destinationDir, bundle.checksumFilename);
    atomicCopy(bundle.archivePath, archivePath);
    try { fs.writeFileSync(checksumPath, bundle.checksumText, { flag: 'wx', mode: 0o600 }); }
    catch (error) { fs.unlinkSync(archivePath); throw error; }
    console.log(`已生成: ${archivePath}`);
    console.log(`校验文件: ${checksumPath}`);
    console.log(`SHA-256: ${bundle.sha256}`);
    console.log('注意: 备份包含账号密码和OAuth令牌，请离线加密保存，绝不要上传到公共仓库。');
  } finally {
    try { bundle?.cleanup(); } finally { db.close(); }
  }
}

main().catch((error) => {
  console.error(`备份失败: ${error.message}`);
  process.exitCode = 1;
});
