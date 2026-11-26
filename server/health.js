const path = require('node:path');
const { db, DIRS } = require('./db');
const { localDovecot } = require('./config');
const { getDovecotStatus } = require('./dovecot');
const { checkTcpPort } = require('./system');
const { hasGlobalLocalSecret } = require('./credentials');
const { syncDiskCapacity } = require('./resource-limits');
const { createProbeCache, programVersion, versions, fileRevision } = require('./diagnostics');

function targetKey() {
  const settings = db.prepare(`SELECT key,value FROM settings WHERE key IN
    ('min_free_disk_mb','dovecot_last_known_hash','dovecot_using_default_password') ORDER BY key`).all();
  return JSON.stringify([localDovecot(), settings, fileRevision(path.join(DIRS.secrets, 'local-target.pass')),
    process.env.MAIL_AGG_MAIL_STORAGE_PATH, process.env.MAIL_AGG_DOVECOT_HELPER_PATH]);
}

const listener = createProbeCache({ key: targetKey, async probe() {
  const local = localDovecot();
  return { local, reachable: await checkTcpPort(local.host, local.port) };
} });

const binaries = createProbeCache({ key: targetKey, async probe() {
  const [dovecot, imapsync] = await Promise.all([programVersion('dovecot'), programVersion('imapsync')]);
  return versions(dovecot, imapsync);
} });

const storage = createProbeCache({ key: targetKey,
  probe: () => syncDiskCapacity(db, DIRS, localDovecot(), { priority: 0, operation: 'all' }) });

const authentication = createProbeCache({ key: targetKey, async probe() {
  const { local, reachable } = await listener.get();
  return getDovecotStatus(local, reachable);
} });

let generation = 0;
async function snapshot(collect) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const initial = generation;
    const key = targetKey();
    const result = await collect();
    if (generation === initial && targetKey() === key) return result;
  }
  throw Object.assign(new Error('诊断目标正在变化，请稍后重试'), { statusCode: 503 });
}

function withMaildir(status, capacity) {
  return { ...status, maildirExists: status.maildirExists || (capacity.observations || []).some(item => (item.storage === 'Maildir' || item.uses?.includes('mail')) && item.status !== 'unavailable') };
}

function getHealthOverview() {
  return snapshot(async () => {
    const [status, installed] = await Promise.all([listener.get(), binaries.get()]);
    return { ...status, installed };
  });
}

function getDovecotSnapshot() {
  return snapshot(async () => {
    const [status, capacity] = await Promise.all([authentication.get(), storage.get()]);
    return withMaildir(status, capacity);
  });
}

function getDiagnosticSnapshot() {
  return snapshot(async () => {
    const [installed, capacity] = await Promise.all([binaries.get(), storage.get()]);
    return { installed, capacity };
  });
}

function getHealthSnapshot() { return snapshot(collectHealthSnapshot); }

async function collectHealthSnapshot() {
  const [{ local }, installed, auth, capacity] = await Promise.all([listener.get(), binaries.get(), authentication.get(), storage.get()]);
  const dovecotStatus = withMaildir(auth, capacity);
  const { reachable, userExists, authTestOk } = dovecotStatus;
  const hasCredential = hasGlobalLocalSecret();
  const checks = [
    { id: 'node', label: 'Node.js', ok: !!installed.node, severity: 'critical', fix: '重新运行安装器以安装 Node.js。' },
    { id: 'imapsync', label: 'imapsync', ok: !!installed.imapsync, severity: 'critical', fix: '重新运行安装器以安装 imapsync。' },
    { id: 'dovecot-command', label: 'Dovecot 命令', ok: !!installed.dovecot, severity: 'critical', fix: '重新运行安装器以安装 Dovecot。' },
    { id: 'imap-listener', label: `本地 IMAP (${local.host}:${local.port})`, ok: reachable, severity: 'critical', fix: '检查 Dovecot 服务、监听地址和端口。' },
    { id: 'dovecot-user', label: `本地用户 (${local.user})`, ok: userExists, severity: 'critical', fix: '确认安装配置或重新初始化本地 Dovecot 用户。' },
    { id: 'maildir', label: 'Maildir', ok: dovecotStatus.maildirExists, severity: 'warning', fix: '检查本地用户 home 目录和 Maildir 所有者。' },
    { id: 'local-credential', label: '本地目标凭据', ok: hasCredential, severity: 'critical', fix: '在设置页配置或修改本地 Dovecot 密码。' },
    { id: 'disk', label: '应用与邮件存储空间', ok: capacity.ok, severity: 'warning', capacity,
      fix: '检查应用和邮件盘的可用空间、文件节点及容量探测。' },
  ];

  if (hasCredential && reachable) {
    checks.push({ id: 'imap-auth', label: '本地 IMAP 认证', ok: authTestOk === true, severity: 'critical', fix: '确认 Dovecot 密码与本地目标凭据一致。' });
  }

  let databaseOk = true;
  try { db.prepare('SELECT 1').get(); } catch (_) { databaseOk = false; }
  checks.push({ id: 'database', label: 'SQLite 数据库', ok: databaseOk, severity: 'critical', fix: '从备份恢复数据库，或检查数据目录权限。' });

  const failed = checks.filter((item) => !item.ok);
  const health = {
    ok: failed.every((item) => item.severity !== 'critical'),
    checkedAt: new Date().toISOString(),
    checks,
    summary: { total: checks.length, failed: failed.length, critical: failed.filter((item) => item.severity === 'critical').length },
  };
  return { health, installed, dovecotStatus, capacity };
}

function invalidateHealth() {
  generation++;
  for (const probe of [listener, binaries, storage, authentication]) probe.invalidate();
}

module.exports = { getHealthOverview, getDovecotSnapshot, getDiagnosticSnapshot, getHealthSnapshot, invalidateHealth,
  async getHealthReport() { return (await getHealthSnapshot()).health; } };
