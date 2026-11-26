const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { verifyBackupArchive } = require('./backup-verifier');
const { extractVerifiedArchive, inspectRestoreDatabase, MAX_WEB_RESTORE_UPLOAD, MAX_WEB_RESTORE_EXPANDED } = require('./restore');

function issue(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function reserve(directory, bytes, files) {
  fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
  const stats = fs.statfsSync(directory, { bigint: true });
  if (stats.bavail * stats.bsize < BigInt(bytes) || (process.platform === 'linux' && stats.ffree < BigInt(files))) {
    throw issue(`恢复需要更多可用空间或文件节点: ${directory}`, 507);
  }
  return fs.statSync(directory, { bigint: true }).dev;
}
function statFile(filename) {
  const value = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!value?.isFile()) throw issue(`不是现有的普通文件: ${filename}`);
  return value;
}
function credentialFootprint(root) {
  let bytes = 0, files = 0;
  const walk = (dir, depth) => {
    if (depth > 5) throw issue('现有凭据目录层级异常');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++files > 20000) throw issue('现有凭据文件过多');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile()) bytes += fs.statSync(file).size;
    }
  };
  walk(root, 0);
  return { bytes, files };
}
function checkTarget(dirs, incoming) {
  const dbFile = path.join(dirs.db, 'mail-aggregator.db');
  const db = statFile(dbFile);
  fs.accessSync(dbFile, fs.constants.R_OK | fs.constants.W_OK);
  const wal = fs.lstatSync(`${dbFile}-wal`, { throwIfNoEntry: false });
  const old = credentialFootprint(dirs.secrets);
  const current = db.size + (wal?.size || 0) + old.bytes;
  const needs = new Map();
  for (const [dir, bytes, files] of [
    [dirs.tmp, 3 * current, old.files + 12],
    [dirs.restorePoints, 2 * current, 4],
    [dirs.root, incoming.uncompressedBytes + old.bytes, incoming.fileCount + old.files + 12],
    [dirs.db, 2 * (incoming.databaseBytes || incoming.uncompressedBytes), 4],
    [dirs.secrets, 0, 1],
  ]) {
    if (!fs.lstatSync(dir).isDirectory()) throw issue(`恢复目标目录异常: ${dir}`);
    const dev = reserve(dir, 0, 0), previous = needs.get(dev) || { dir, bytes: 0, files: 0 };
    previous.bytes += bytes; previous.files += files; needs.set(dev, previous);
  }
  for (const { dir, bytes, files } of needs.values()) reserve(dir, bytes + 4 * 1024 * 1024, files + 32);
}
function readExpectedChecksum(checksumPath, archivePath) {
  if (!checksumPath) return null;
  if (statFile(checksumPath).size > 8192) throw issue('SHA-256校验文件过大');
  const match = /^([a-fA-F0-9]{64})\s+(.+)$/.exec(fs.readFileSync(checksumPath, 'utf8').trim());
  if (!match || path.basename(match[2]) !== path.basename(archivePath)) throw issue('SHA-256校验文件无效或文件名与归档不匹配');
  return match[1].toLowerCase();
}
async function prepareRestoreArchive({ archivePath, checksumPath, stageDir, dirs, signal }) {
  if (statFile(archivePath).size > MAX_WEB_RESTORE_UPLOAD) throw issue('备份压缩包超过 512 MiB 恢复上限', 413);
  const verified = await verifyBackupArchive(archivePath, readExpectedChecksum(checksumPath, archivePath), {
    maxExpandedBytes: MAX_WEB_RESTORE_EXPANDED, signal,
  });
  if (verified.uncompressedBytes > MAX_WEB_RESTORE_EXPANDED) throw issue('备份展开内容超过 1 GiB 恢复上限', 413);
  reserve(path.dirname(stageDir), verified.uncompressedBytes + 4 * 1024 * 1024, verified.fileCount * 2 + 16);
  checkTarget(dirs, verified);
  await extractVerifiedArchive(archivePath, stageDir, { signal });
  const databasePath = path.join(stageDir, 'data/db/mail-aggregator.db');
  const secretsDir = path.join(stageDir, 'data/secrets');
  const database = inspectRestoreDatabase(Database, databasePath, { strict: true });
  checkTarget(dirs, verified);
  return { verified, database, databasePath, secretsDir };
}
module.exports = { checkTarget, prepareRestoreArchive, reserve, statFile };
