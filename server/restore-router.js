const { asyncRoute } = require('./state-lock');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { prepareRestoreArchive, checkTarget } = require('./restore-preflight');
const { createBackupBundle } = require('./backup');
const maintenanceLock = require('./maintenance-lock');
const {
  receiveArchive,
  restoreApplicationState,
} = require('./restore');

const PENDING_TTL_MS = 30 * 60 * 1000;
const DOWNLOAD_TTL_MS = 30 * 60 * 1000;
let inspecting = false;

function safeCleanup(directory) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch (_) {}
}

function moveFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination);
    fs.rmSync(source, { force: true });
  }
  fs.chmodSync(destination, 0o600);
}

function createRestoreRouter({
  db,
  dirs,
  version,
  scheduler,
  hasRunningSyncs,
  passwordGuard,
  isSecureRequest,
  stopMailTasks = async () => {},
  withMaintenance = work => work(),
  onRestored = () => {},
  onRecoveryRequired = () => {},
}) {
  const router = express.Router();
  const pending = new Map();
  const downloads = new Map();

  function expirePending(id) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    safeCleanup(item.workDir);
  }

  router.post('/inspect', asyncRoute(async (req, res) => {
    if (!isSecureRequest(req)) {
      return res.status(400).json({ error: '远程恢复必须使用 HTTPS；HTTP 仅允许服务器本机访问' });
    }
    if (!req.is(['application/gzip', 'application/x-gzip', 'application/octet-stream'])) {
      req.resume();
      return res.status(415).json({ error: '请上传 .tar.gz 备份文件' });
    }
    if (inspecting || maintenanceLock.current() === 'restore') {
      req.resume(); return res.status(409).json({ error: '已有备份正在上传、预检或恢复，请稍后重试' });
    }
    inspecting = true;
    const controller = new AbortController();
    const cancelled = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', cancelled);

    let workDir, preflightTimer;
    try {
      for (const [id, item] of pending) {
        if (item.owner === req.sessionID) expirePending(id);
      }
      workDir = fs.mkdtempSync(path.join(dirs.tmp, 'web-restore-'));
      const archivePath = path.join(workDir, 'upload.tar.gz');
      const uploadBytes = await receiveArchive(req, archivePath, undefined, { signal: controller.signal });
      preflightTimer = setTimeout(() => controller.abort(), 120000); preflightTimer.unref?.();
      const stageDir = path.join(workDir, 'stage');
      const { verified, database, databasePath, secretsDir } = await prepareRestoreArchive({ archivePath, stageDir, dirs, signal: controller.signal });
      require('./auth').assertCurrentUser(req, null, 'primary');
      if (controller.signal.aborted) throw new Error('Operation cancelled');
      const id = crypto.randomBytes(24).toString('hex');
      const item = {
        id,
        owner: req.sessionID,
        workDir,
        databasePath,
        secretsDir,
        verified,
        expiresAt: Date.now() + PENDING_TTL_MS,
      };
      pending.set(id, item);
      const timer = setTimeout(() => expirePending(id), PENDING_TTL_MS);
      timer.unref();
      res.json({
        ok: true,
        restoreId: id,
        uploadBytes,
        archiveSha256: verified.archiveSha256,
        backupVersion: verified.applicationVersion,
        createdAt: verified.createdAt,
        fileCount: verified.fileCount,
        uncompressedBytes: verified.uncompressedBytes,
        ...database,
        notes: [
          '当前Web管理员和登录会话保持不变',
          '当前本地Dovecot密码保持不变',
          '邮件正文、日志和缓存不在恢复范围内',
        ],
      });
    } catch (error) {
      if (workDir) safeCleanup(workDir);
      console.error(`[restore] 预检失败: ${error.message}`);
      if (!res.destroyed) res.status(error.statusCode || 400).json({ error: error.message || '备份预检失败' });
    } finally {
      clearTimeout(preflightTimer);
      inspecting = false; res.removeListener('close', cancelled);
    }
  }));

  router.post('/apply', passwordGuard, asyncRoute(async (req, res) => withMaintenance(async () => {
    if (!isSecureRequest(req)) {
      return res.status(400).json({ error: '远程恢复必须使用 HTTPS；HTTP 仅允许服务器本机访问' });
    }
    const item = pending.get(String(req.body && req.body.restoreId || ''));
    if (!item || item.owner !== req.sessionID || item.expiresAt < Date.now()) {
      return res.status(404).json({ error: '恢复预检已过期，请重新上传备份' });
    }
    if (req.body.confirmation !== 'RESTORE') {
      return res.status(400).json({ error: '请输入 RESTORE 确认恢复' });
    }
    const active = db.prepare(
      "SELECT COUNT(*) AS count FROM sync_jobs WHERE status IN ('queued','running')"
    ).get().count;
    if (active > 0 || hasRunningSyncs()) {
      return res.status(409).json({ error: '仍有同步任务正在运行或排队，请先停止或取消全部任务' });
    }
    if (!maintenanceLock.acquire('restore')) {
      return res.status(409).json({ error: '系统正在执行备份或恢复，请稍后再试' });
    }

    let safetyBundle = null;
    let safetyPath = null;
    let snapshotId = null;
    let snapshotName = null;
    let recoveryRequired = false;
    const controller = new AbortController();
    const cancelled = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', cancelled);
    scheduler.stop();
    try {
      require('./auth').assertCurrentUser(req, null, 'primary');
      checkTarget(dirs, item.verified);
      await stopMailTasks();
      safetyBundle = await createBackupBundle({ db, dirs, version, signal: controller.signal, allowDuringRestore: true });
      snapshotName = safetyBundle.filename
        .replace('mail-aggregator-', 'pre-restore-')
        .replace('.tar.gz', `-${crypto.randomBytes(4).toString('hex')}.tar.gz`);
      safetyPath = path.join(dirs.restorePoints, snapshotName);
      moveFile(safetyBundle.archivePath, safetyPath);
      fs.writeFileSync(
        `${safetyPath}.sha256`,
        `${safetyBundle.sha256}  ${snapshotName}\n`,
        { mode: 0o600 }
      );
      safetyBundle.cleanup();
      safetyBundle = null;

      snapshotId = crypto.randomBytes(24).toString('hex');
      downloads.set(snapshotId, {
        owner: req.sessionID,
        path: safetyPath,
        filename: snapshotName,
        sha256: fs.readFileSync(`${safetyPath}.sha256`, 'utf8').slice(0, 64),
        expiresAt: Date.now() + DOWNLOAD_TTL_MS,
      });

      const restored = restoreApplicationState({
        Database,
        currentDb: db,
        backupDbPath: item.databasePath,
        currentSecretsDir: dirs.secrets,
        backupSecretsDir: item.secretsDir,
        onJournal: operationId => { res.locals.auditOperationId = operationId; },
        beforeCommit() {
          require('./auth').assertCurrentUser(req, null, 'primary');
          if (controller.signal.aborted || pending.get(item.id) !== item || item.owner !== req.sessionID || item.expiresAt <= Date.now()) {
            throw Object.assign(new Error('恢复预检或登录会话已失效，请重新预检'), { statusCode: 409 });
          }
        },
      });
      onRestored();

      pending.delete(item.id);
      safeCleanup(item.workDir);
      res.json({
        ok: true,
        message: '恢复完成，当前管理员和本地Dovecot密码保持不变',
        restored,
        snapshotId,
        snapshotFilename: snapshotName,
      });
    } catch (error) {
      recoveryRequired = Boolean(error.recoveryRequired);
      if (safetyBundle) safetyBundle.cleanup();
      console.error(`[restore] 恢复失败: ${error.message}`);
      if (error.rollbackError) {
        console.error(`[restore] 密钥回滚失败: ${error.rollbackError.message}`);
      }
      if (!res.destroyed) res.status(error.statusCode || 500).json({
        error: recoveryRequired ? '恢复需要核对，服务将停止。请运行离线诊断并保留恢复前快照'
          : error.statusCode ? error.message : '恢复未完成。原有配置仍在使用',
        snapshotId,
        snapshotFilename: snapshotName,
      });
    } finally {
      res.removeListener('close', cancelled);
      if (recoveryRequired) onRecoveryRequired();
      else {
        maintenanceLock.release('restore');
        scheduler.start();
      }
    }
  })));

  router.get('/snapshot/:id', (req, res) => {
    if (!isSecureRequest(req)) {
      return res.status(400).json({ error: '远程快照下载必须使用 HTTPS' });
    }
    const item = downloads.get(req.params.id);
    if (!item || item.owner !== req.sessionID || item.expiresAt < Date.now() || !fs.existsSync(item.path)) {
      return res.status(404).json({ error: '恢复前快照下载已过期' });
    }
    res.set('X-Backup-SHA256', item.sha256);
    res.download(item.path, item.filename);
  });

  router.get('/snapshots', (req, res) => {
    if (!isSecureRequest(req)) {
      return res.status(400).json({ error: '远程快照查看必须使用 HTTPS' });
    }
    const rows = fs.readdirSync(dirs.restorePoints, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^pre-restore-[A-Za-z0-9-]+\.tar\.gz$/.test(entry.name))
      .map((entry) => {
        const absolute = path.join(dirs.restorePoints, entry.name);
        const stat = fs.statSync(absolute);
        const checksumPath = `${absolute}.sha256`;
        const checksum = fs.existsSync(checksumPath)
          ? fs.readFileSync(checksumPath, 'utf8').slice(0, 64)
          : '';
        return { filename: entry.name, size: stat.size, createdAt: stat.mtime.toISOString(), sha256: checksum };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(rows);
  });

  router.get('/snapshots/:filename', (req, res) => {
    if (!isSecureRequest(req)) {
      return res.status(400).json({ error: '远程快照下载必须使用 HTTPS' });
    }
    const filename = String(req.params.filename || '');
    if (!/^pre-restore-[A-Za-z0-9-]+\.tar\.gz$/.test(filename)) {
      return res.status(400).json({ error: '快照文件名不合法' });
    }
    const target = path.join(dirs.restorePoints, filename);
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile()) {
      return res.status(404).json({ error: '恢复前快照不存在' });
    }
    const checksumPath = `${target}.sha256`;
    if (fs.existsSync(checksumPath)) {
      res.set('X-Backup-SHA256', fs.readFileSync(checksumPath, 'utf8').slice(0, 64));
    }
    res.download(target, filename);
  });

  return router;
}

module.exports = { createRestoreRouter };
