'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, X509Certificate } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { WIZARD_PORT, InstallSession, receiveLines, send } = require('./protocol');
const { inspectHost, preflight, rootEnv } = require('./host');

const project = path.resolve(__dirname, '../..');
const node = '/usr/bin/node';
const details = new Set(['imapsync', 'dovecot_config', 'dovecot_state', 'admin_init', 'application_start', 'application_probe',
  'setup_closed', 'imap_login', 'updater', 'enable_boot']);
const failureCodes = {
  source_index_failed: 'MAI-101', dependency_failed: 'MAI-102', npm_dependencies_failed: 'MAI-103',
  native_sqlite_failed: 'MAI-104', service_start_failed: 'MAI-105', service_readiness_failed: 'MAI-106', install_failed: 'MAI-100',
  maintenance_busy: 'MAI-107', preflight_changed: 'MAI-108', install_timeout: 'MAI-109',
};
const publicFiles = ['scripts/install-web/https.js', 'scripts/install-web/protocol.js', 'scripts/install-web/index.html',
  'scripts/install-web/setup.css', 'scripts/install-web/setup.js', 'server/admin-setup-input.js', 'server/password-policy.js'];
const fail = () => { throw Error('host command failed'); };

function run(file, args) {
  const result = spawnSync(file, args, { env: rootEnv, encoding: 'utf8', timeout: 15000, maxBuffer: 4096 });
  if (result.status !== 0) fail();
  return result.stdout.trim();
}

function temporaryAccount(manager, user, group) {
  const openrc = manager === 'openrc';
  let userCreated = false, groupCreated = false;
  return {
    create() {
      if (openrc) run('/usr/sbin/addgroup', ['-S', group]);
      else run('/usr/sbin/groupadd', ['--system', group]);
      groupCreated = true;
      if (openrc) run('/usr/sbin/adduser', ['-S', '-D', '-H', '-h', '/nonexistent', '-s', '/sbin/nologin', '-G', group, user]);
      else run('/usr/sbin/useradd', ['--system', '--no-create-home', '--home-dir', '/nonexistent',
        '--shell', '/usr/sbin/nologin', '--no-user-group', '--gid', group, user]);
      userCreated = true;
      return { uid: Number(run('/usr/bin/id', ['-u', user])), gid: Number(run('/usr/bin/id', ['-g', user])) };
    },
    cleanUser() { if (userCreated) run(openrc ? '/usr/sbin/deluser' : '/usr/sbin/userdel', [user]); },
    cleanGroup() { if (groupCreated) run(openrc ? '/usr/sbin/delgroup' : '/usr/sbin/groupdel', [group]); },
  };
}

function stageAssets(stage) {
  for (const directory of ['scripts', 'scripts/install-web', 'server']) {
    fs.mkdirSync(path.join(stage, directory));
    fs.chmodSync(path.join(stage, directory), 0o755);
  }
  for (const file of publicFiles) {
    const target = path.join(stage, file);
    fs.copyFileSync(path.join(project, file), target);
    fs.chmodSync(target, 0o644);
  }
  fs.chmodSync(stage, 0o755);
}

function makeTls(stage, ip) {
  const keyPath = path.join(stage, 'private/key');
  const certPath = path.join(stage, 'private/cert');
  fs.mkdirSync(path.dirname(keyPath), { mode: 0o700 });
  run('/usr/bin/openssl', ['req', '-batch', '-new', '-x509', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-days', '1', '-subj', `/CN=${ip}`, '-addext', `subjectAltName=IP:${ip}`, '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'extendedKeyUsage=serverAuth', '-keyout', keyPath, '-out', certPath]);
  const key = fs.readFileSync(keyPath, 'utf8');
  const cert = fs.readFileSync(certPath, 'utf8');
  fs.unlinkSync(keyPath); fs.unlinkSync(certPath); fs.rmdirSync(path.dirname(keyPath));
  return { ip, key, cert };
}

function main(ip) {
  if (process.getuid() !== 0) return 1;
  process.umask(0o077);
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  const host = inspectHost();
  const issues = preflight(ip, 8080, true, host).filter(item => !item.ok && item.id !== 'web_port');
  if (issues.length) {
    console.error('无法启动安装向导，预检未通过：' + issues.map(item => item.reason || item.id).join(', '));
    return 1;
  }

  const suffix = randomBytes(6).toString('hex');
  const account = temporaryAccount(host.manager, `ma-setup-${suffix}`, `ma-wiz-g-${suffix}`);
  let stage, child, timer, shutdownTimer, startupTimer;
  let session, wizardReady = false, closed = false, offline = false;
  let job, logFd, jobKillTimer, timedOut = false;
  function clean() {
    if (closed) return;
    closed = true;
    clearInterval(timer); clearTimeout(shutdownTimer); clearTimeout(startupTimer);
    session?.clear();
    if (logFd !== undefined) { fs.closeSync(logFd); logFd = undefined; }
    const cleanup = [
      account.cleanUser,
      account.cleanGroup,
      () => { if (stage) fs.rmSync(stage, { recursive: true, force: true }); },
    ];
    for (const action of cleanup) {
      try { action(); } catch (_) { console.error('无法完全清理临时向导资源；请保留终端输出。'); }
    }
    if (wizardReady) console.log('临时 HTTPS 安装向导已关闭。');
  }
  function closeWizard() {
    if (closed || shutdownTimer) return;
    session?.clear();
    if (!child || offline) { clean(); return; }
    send(child.stdin, { shutdown: true });
    child.stdin.end();
    shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  }
  function peerExited() {
    if (offline) return;
    offline = true;
    if (!wizardReady) {
      console.error('临时 HTTPS 服务未启动；请确认地址、8090 端口和系统安装条件。');
      process.exitCode = 1;
    }
    if (!job) clean();
  }
  function rootLog(event) {
    // Only fixed stage tokens and exit codes enter this file. No raw command output.
    try { fs.writeSync(logFd, `${new Date().toISOString()} ${event}\n`); } catch (_) { /* Don't interrupt an active install. */ }
  }
  function start(options, imapPassword) {
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
    const log = `/var/log/mail-aggregator-web-install-${stamp}-${randomBytes(4).toString('hex')}.log`;
    logFd = fs.openSync(log, 'wx', 0o600);
    console.log(`开始安装。步骤记录（仅 root）：${log}`);
    rootLog('accepted');
    let verified = false, failure = null;
    const work = spawn('/bin/sh', [path.join(project, 'scripts/install.sh'), '--web-fresh', String(options.webPort), options.language, ip, options.securityProfile],
      { cwd: project, env: rootEnv, detached: true, stdio: ['pipe', 'ignore', 'ignore', 'pipe'] });
    job = work;
    work.stdin.on('error', () => {});
    work.stdio[3].on('error', () => {});
    work.on('error', () => {});
    receiveLines(work.stdio[3], line => {
      if (/^stage:[1-9]$/.test(line)) { session.progress(Number(line.slice(-1))); rootLog(line); }
      else if (line.startsWith('detail:') && details.has(line.slice(7))) {
        session.progress(session.step, line.slice(7));
        rootLog(line);
      } else if (line.startsWith('error:') && Object.hasOwn(failureCodes, line.slice(6))) {
        failure = line.slice(6);
        rootLog(`failure:${failureCodes[failure]}:${failure}`);
      } else if (line === 'verified' && session.step === 9 && session.detail === 'enable_boot') {
        verified = true;
        rootLog(line);
      }
    }, () => rootLog('invalid_progress'), 128);
    work.once('close', (code, signal) => {
      job = undefined;
      clearTimeout(jobKillTimer);
      const ok = code === 0 && verified && !timedOut;
      const fallback = session.step === 1 ? 'source_index_failed' : session.step >= 2 && session.step <= 4 ? 'dependency_failed'
        : session.detail === 'application_start' ? 'service_start_failed' : session.step === 9 ? 'service_readiness_failed' : 'install_failed';
      const error = timedOut ? 'install_timeout' : code === 73 ? 'maintenance_busy' : code === 74 ? 'preflight_changed' : failure || fallback;
      rootLog(`exit:${Number.isInteger(code) ? code : signal ? 'signal' : 'spawn_failed'}`);
      rootLog(ok ? 'succeeded' : `${failureCodes[error]}:${error}`);
      fs.closeSync(logFd); logFd = undefined;
      session.complete(ok, error);
      console.log(ok ? '已通过 Web 和 IMAP 验证。请在浏览器保存独立的 mailuser 密码。'
        : '安装未通过。请保留日志，检查失败步骤后再处理。向导不会自动重试。');
      if (!ok) process.exitCode = 1;
      if (offline) clean();
    });
    // Only this private pipe carries the two passwords. The installer consumes
    // it immediately and never forwards it to the package manager or services.
    work.stdin.end(`${JSON.stringify({ username: options.username, password: options.password })}\n${imapPassword}\n`);
  }

  try {
    stage = fs.mkdtempSync('/run/mail-aggregator-wizard-');
    const tls = makeTls(stage, ip);
    const fingerprint = new X509Certificate(tls.cert).fingerprint256;
    stageAssets(stage);
    const { uid, gid } = account.create();
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) fail();
    session = new InstallSession({ ip, preflight: port => preflight(ip, port), start });
    child = spawn(node, [path.join(stage, 'scripts/install-web/https.js')], {
      uid, gid, cwd: stage, env: { PATH: rootEnv.PATH, HOME: '/nonexistent' }, detached: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.stdin.on('error', () => {});
    child.once('error', () => {});
    child.once('close', peerExited);
    startupTimer = setTimeout(closeWizard, 12_000);
    let lastId = 0;
    receiveLines(child.stdout, line => {
      const message = JSON.parse(line);
      if (!wizardReady && message?.ready === true) {
        wizardReady = true;
        clearTimeout(startupTimer);
        console.log(`临时向导：https://${ip}:${WIZARD_PORT}/`);
        console.log(`证书 SHA-256 指纹：${fingerprint}`);
        console.log(`单次安装口令（15 分钟）：${session.printedCode()}`);
        console.log('请核对指纹后输入口令。保持此终端运行；关闭浏览器不会中断安装。');
        return;
      }
      if (!wizardReady || !Number.isSafeInteger(message?.id) || message.id <= lastId) throw Error('invalid frame');
      lastId = message.id;
      let result;
      try { result = session.handle(message); }
      catch (_) { result = { status: 503, body: { error: 'installer_unavailable' } }; }
      send(child.stdin, { id: message.id, ...result });
      if (result.close) setTimeout(closeWizard, 350);
    }, closeWizard);
    send(child.stdin, { init: tls });
    timer = setInterval(() => {
      if (!session.expired()) return;
      if (!job) { closeWizard(); return; }
      if (timedOut) return;
      timedOut = true;
      try { process.kill(-job.pid, 'SIGTERM'); } catch (_) { /* Already stopped. */ }
      jobKillTimer = setTimeout(() => { if (job) { try { process.kill(-job.pid, 'SIGKILL'); } catch (_) {} } }, 10_000);
    }, 1000);
    // Closing a browser or losing the terminal should not interrupt an accepted job.
    for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.on(signal, () => { if (!job) closeWizard(); });
  } catch (_) {
    console.error('无法建立临时安装环境。没有启动应用安装。');
    if (child) closeWizard(); else clean();
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv[2]);
