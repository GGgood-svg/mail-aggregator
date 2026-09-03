#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { db, DIRS } = require('./db');
const { createBackupBundle } = require('./backup');
const { version } = require('../package.json');

function atomicCopy(source, destination, mode = 0o600) {
  const temporary = `${destination}.tmp.${process.pid}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(temporary, mode);
    if (fs.existsSync(destination)) throw new Error(`目标文件已存在: ${destination}`);
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

async function main() {
  const destinationDir = path.resolve(process.argv[2] || '/root/mail-aggregator-backups');
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  const bundle = await createBackupBundle({ db, dirs: DIRS, version });
  try {
    const archivePath = path.join(destinationDir, bundle.filename);
    const checksumPath = path.join(destinationDir, bundle.checksumFilename);
    atomicCopy(bundle.archivePath, archivePath);
    fs.writeFileSync(checksumPath, bundle.checksumText, { flag: 'wx', mode: 0o600 });
    console.log(`已生成: ${archivePath}`);
    console.log(`校验文件: ${checksumPath}`);
    console.log(`SHA-256: ${bundle.sha256}`);
    console.log('注意: 备份包含账号密码和OAuth令牌，请离线加密保存，绝不要上传到公共仓库。');
  } finally {
    bundle.cleanup();
  }
}

main().catch((error) => {
  console.error(`备份失败: ${error.message}`);
  process.exitCode = 1;
}).finally(() => {
  try { db.close(); } catch (_) {}
});
