const fs = require('fs');
const { execFile } = require('child_process');
const { db, DIRS } = require('./db');
const { localDovecot } = require('./config');
const { checkTcpPort } = require('./system');
const { checkUserExists, checkMaildirExists, imapLoginTest } = require('./dovecot');
const { hasGlobalLocalSecret, readGlobalLocalSecret } = require('./credentials');

function commandExists(command) {
  return new Promise((resolve) => {
    execFile('sh', ['-c', `command -v ${command}`], { timeout: 3000 }, (error) => resolve(!error));
  });
}

function diskAvailableMb() {
  return new Promise((resolve) => {
    execFile('df', ['-Pk', DIRS.root], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      const line = String(stdout).trim().split('\n')[1];
      const parts = line && line.trim().split(/\s+/);
      resolve(parts && Number.isFinite(Number(parts[3])) ? Math.floor(Number(parts[3]) / 1024) : null);
    });
  });
}

async function getHealthReport() {
  const local = localDovecot();
  const [node, imapsync, dovecotCommand, reachable, userExists, diskMb] = await Promise.all([
    commandExists('node'), commandExists('imapsync'), commandExists('dovecot'),
    checkTcpPort(local.host, local.port), checkUserExists(local.user), diskAvailableMb(),
  ]);
  const checks = [
    { id: 'node', label: 'Node.js', ok: node, severity: 'critical', fix: '重新运行安装器以安装 Node.js。' },
    { id: 'imapsync', label: 'imapsync', ok: imapsync, severity: 'critical', fix: '重新运行安装器以安装 imapsync。' },
    { id: 'dovecot-command', label: 'Dovecot 命令', ok: dovecotCommand, severity: 'critical', fix: '重新运行安装器以安装 Dovecot。' },
    { id: 'imap-listener', label: `本地 IMAP (${local.host}:${local.port})`, ok: reachable, severity: 'critical', fix: '检查 Dovecot 服务、监听地址和端口。' },
    { id: 'dovecot-user', label: `本地用户 (${local.user})`, ok: userExists, severity: 'critical', fix: '确认安装配置或重新初始化本地 Dovecot 用户。' },
    { id: 'maildir', label: 'Maildir', ok: checkMaildirExists(local.user), severity: 'critical', fix: '检查本地用户 home 目录和 Maildir 所有者。' },
    { id: 'local-credential', label: '本地目标凭据', ok: hasGlobalLocalSecret(), severity: 'critical', fix: '在设置页配置或修改本地 Dovecot 密码。' },
    { id: 'disk', label: '可用磁盘空间', ok: diskMb === null || diskMb >= 512, severity: 'warning', detail: diskMb === null ? '未知' : `${diskMb} MB`, fix: '清理日志、缓存或扩容磁盘。' },
  ];

  if (hasGlobalLocalSecret() && reachable) {
    const password = readGlobalLocalSecret();
    const authOk = password ? await imapLoginTest(local.host, local.port, local.user, password) : false;
    checks.push({ id: 'imap-auth', label: '本地 IMAP 认证', ok: authOk, severity: 'critical', fix: '确认 Dovecot 密码与本地目标凭据一致。' });
  }

  let databaseOk = true;
  try { db.prepare('SELECT 1').get(); } catch (_) { databaseOk = false; }
  checks.push({ id: 'database', label: 'SQLite 数据库', ok: databaseOk, severity: 'critical', fix: '从备份恢复数据库，或检查数据目录权限。' });

  const failed = checks.filter((item) => !item.ok);
  return {
    ok: failed.every((item) => item.severity !== 'critical'),
    checkedAt: new Date().toISOString(),
    checks,
    summary: { total: checks.length, failed: failed.length, critical: failed.filter((item) => item.severity === 'critical').length },
  };
}

module.exports = { getHealthReport };
