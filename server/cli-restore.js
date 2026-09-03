#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { db, DIRS } = require('./db');
const { createBackupBundle } = require('./backup');
const { verifyBackupArchive } = require('./backup-verifier');
const {
  MAX_WEB_RESTORE_EXPANDED,
  extractVerifiedArchive,
  inspectRestoreDatabase,
  restoreApplicationState,
} = require('./restore');
const { version } = require('../package.json');

function readExpectedChecksum(checksumPath, archivePath) {
  if (!checksumPath) return null;
  const line = fs.readFileSync(checksumPath, 'utf8').trim();
  const match = /^([a-fA-F0-9]{64})\s+(.+)$/.exec(line);
  if (!match) throw new Error('SHA-256校验文件格式不合法');
  if (path.basename(match[2]) !== path.basename(archivePath)) {
    throw new Error('SHA-256校验文件中的文件名与压缩包不匹配');
  }
  return match[1].toLowerCase();
}

function moveFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    fs.rmSync(source, { force: true });
  }
}

async function main() {
  if (process.env.MAIL_AGG_CLI_RESTORE_STOPPED !== '1') {
    throw new Error('请通过 scripts/restore.sh 执行恢复，以确保服务已停止并完成预检');
  }
  const inputArchive = process.argv[2] && path.resolve(process.argv[2]);
  const checksumPath = process.argv[3] && path.resolve(process.argv[3]);
  if (!inputArchive || !fs.existsSync(inputArchive)) {
    throw new Error('用法: node server/cli-restore.js <backup.tar.gz> [backup.tar.gz.sha256]');
  }
  if (checksumPath && !fs.existsSync(checksumPath)) throw new Error('指定的SHA-256校验文件不存在');

  const workDir = fs.mkdtempSync(path.join(DIRS.tmp, 'cli-restore-'));
  let safetyBundle = null;
  let preserveWorkDir = false;
  try {
    // Copy first so an external process cannot replace the user-supplied path
    // between verification and extraction.
    const archivePath = path.join(workDir, 'upload.tar.gz');
    fs.copyFileSync(inputArchive, archivePath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(archivePath, 0o600);
    const expected = readExpectedChecksum(checksumPath, inputArchive);
    const verified = await verifyBackupArchive(archivePath, expected);
    if (verified.uncompressedBytes > MAX_WEB_RESTORE_EXPANDED) {
      throw new Error('备份解压后超过1 GiB的CLI恢复上限');
    }

    const stageDir = path.join(workDir, 'stage');
    await extractVerifiedArchive(archivePath, stageDir);
    const backupDbPath = path.join(stageDir, 'data', 'db', 'mail-aggregator.db');
    const backupSecretsDir = path.join(stageDir, 'data', 'secrets');
    const inspected = inspectRestoreDatabase(Database, backupDbPath);

    safetyBundle = await createBackupBundle({ db, dirs: DIRS, version });
    const snapshotName = safetyBundle.filename
      .replace('mail-aggregator-', 'pre-restore-')
      .replace('.tar.gz', `-${crypto.randomBytes(4).toString('hex')}.tar.gz`);
    const snapshotPath = path.join(DIRS.restorePoints, snapshotName);
    moveFile(safetyBundle.archivePath, snapshotPath);
    fs.writeFileSync(
      `${snapshotPath}.sha256`,
      `${safetyBundle.sha256}  ${snapshotName}\n`,
      { flag: 'wx', mode: 0o600 }
    );
    safetyBundle.cleanup();
    safetyBundle = null;

    const restored = restoreApplicationState({
      Database,
      currentDb: db,
      backupDbPath,
      currentSecretsDir: DIRS.secrets,
      backupSecretsDir,
      workDir,
    });
    fs.rmSync(DIRS.cache, { recursive: true, force: true });
    fs.mkdirSync(DIRS.cache, { recursive: true });
    console.log(`恢复完成: ${JSON.stringify(restored)}`);
    console.log(`恢复前快照: ${snapshotPath}`);
    console.log(`备份内容: ${inspected.accountCount} 个账号，${inspected.jobCount} 条同步记录`);
    console.log('当前管理员、本机部署设置和本地 Dovecot 密码保持不变。');
  } catch (error) {
    if (error.rollbackError) {
      preserveWorkDir = true;
      error.recoveryDir = workDir;
    }
    throw error;
  } finally {
    if (safetyBundle) safetyBundle.cleanup();
    if (!preserveWorkDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`恢复失败: ${error.message}`);
  if (error.rollbackError) console.error(`密钥回滚失败: ${error.rollbackError.message}`);
  if (error.recoveryDir) console.error(`为避免丢失旧密钥，故障现场已保留: ${error.recoveryDir}`);
  process.exitCode = 1;
}).finally(() => {
  try { db.close(); } catch (_) {}
});
