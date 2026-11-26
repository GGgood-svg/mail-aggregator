#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { startDataProcess } = require('./data-process');
const { createBackupBundle, buildFileInventory } = require('./backup');
const { dataPaths } = require('./data-paths');
const { journalPresent } = require('./restore-journal');
const { prepareRestoreArchive, checkTarget, reserve, statFile } = require('./restore-preflight');
const { MAX_WEB_RESTORE_UPLOAD, restoreApplicationState } = require('./restore');
const { version } = require('../package.json');

async function sealStage(stageDir) {
  return crypto.createHash('sha256').update(JSON.stringify(await buildFileInventory(stageDir))).digest('hex');
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
  const [action, first, second, third] = process.argv.slice(2);
  if (action === 'check-input') {
    const archive = statFile(first);
    if (archive.size > MAX_WEB_RESTORE_UPLOAD) throw new Error('备份压缩包超过 512 MiB 恢复上限');
    if (third && statFile(third).size > 8192) throw new Error('SHA-256校验文件过大');
    reserve(second, archive.size + 4 * 1024 * 1024, 8);
    return;
  }
  const dirs = dataPaths();
  if (journalPresent(dirs.root)) throw new Error('存在未完成的恢复，请先启动服务核对或运行离线诊断');
  if (!['prepare', 'apply'].includes(action) || !first) throw new Error('请通过 scripts/restore.sh 预检及恢复');
  const input = path.resolve(first);
  const stageDir = path.join(input, 'work', 'stage');
  if (action === 'prepare') {
    const prepared = await prepareRestoreArchive({ archivePath: second, checksumPath: third, dirs, stageDir });
    const { verified, database } = prepared;
    console.log(JSON.stringify({ verified, database, root: fs.realpathSync(dirs.root), stageSeal: await sealStage(stageDir) }));
    return;
  }
  if (process.env.MAIL_AGG_CLI_RESTORE_STOPPED !== '1') {
    throw new Error('请通过 scripts/restore.sh 执行恢复，以确保服务已停止并完成预检');
  }
  const receiptPath = path.join(input, 'prepared.json');
  if (statFile(receiptPath).size > 8192) throw new Error('恢复预检记录不合法');
  const prepared = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (prepared.root !== fs.realpathSync(dirs.root) || prepared.stageSeal !== await sealStage(stageDir)) {
    throw new Error('恢复预检材料或目标路径已变化，请重新预检');
  }
  checkTarget(dirs, prepared.verified);
  const release = startDataProcess(dirs);
  let db;
  try {
    db = require('./db').db;
    await restoreArchive(db, dirs, stageDir, prepared.database);
  } finally { try { db?.close(); } finally { release(); } }
}

async function restoreArchive(db, DIRS, stageDir, inspected) {
  let safetyBundle = null;
  try {
    const backupDbPath = path.join(stageDir, 'data/db/mail-aggregator.db');
    const backupSecretsDir = path.join(stageDir, 'data/secrets');
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
    });
    console.log(`恢复完成: ${JSON.stringify(restored)}`);
    console.log(`恢复前快照: ${snapshotPath}`);
    console.log(`备份内容: ${inspected.accountCount} 个账号，${inspected.jobCount} 条同步记录`);
    console.log('当前管理员、本机部署设置和本地 Dovecot 密码保持不变。');
  } finally {
    if (safetyBundle) safetyBundle.cleanup();
  }
}

main().catch((error) => {
  console.error(`恢复失败: ${error.message}`);
  if (error.rollbackError) console.error(`密钥回滚失败: ${error.rollbackError.message}`);
  if (error.recoveryDir) console.error(`为避免丢失旧密钥，故障现场已保留: ${error.recoveryDir}`);
  process.exitCode = 1;
});
