const fs = require('fs');
const path = require('path');
const { verifyBackupArchive } = require('./backup-verifier');

async function main() {
  const archivePath = process.argv[2];
  const checksumPath = process.argv[3];
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error('用法: node server/cli-verify-backup.js <backup.tar.gz> [backup.tar.gz.sha256]');
  }
  let expected = null;
  if (checksumPath) {
    if (!fs.existsSync(checksumPath)) throw new Error('指定的SHA-256校验文件不存在');
    const line = fs.readFileSync(checksumPath, 'utf8').trim();
    const match = /^([a-fA-F0-9]{64})\s+(.+)$/.exec(line);
    if (!match) throw new Error('SHA-256校验文件格式不合法');
    if (path.basename(match[2]) !== path.basename(archivePath)) {
      throw new Error('SHA-256校验文件中的文件名与压缩包不匹配');
    }
    expected = match[1];
  }
  const result = await verifyBackupArchive(archivePath, expected);
  console.log('备份验证通过');
  console.log(`版本: ${result.applicationVersion || '未知'}`);
  console.log(`创建时间: ${result.createdAt || '未知'}`);
  console.log(`数据文件: ${result.fileCount}`);
  console.log(`SHA-256: ${result.archiveSha256}`);
}

main().catch((error) => {
  console.error(`备份验证失败: ${error.message}`);
  process.exitCode = 1;
});
