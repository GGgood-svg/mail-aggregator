const net = require('net');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { db } = require('./db');
const {
  saveGlobalLocalSecret,
  hasGlobalLocalSecret,
  readGlobalLocalSecret,
  targetPassPath,
} = require('./credentials');
const { checkTcpPort } = require('./system');
const { generateDovecotHash } = require('./doveadmHash');
const { localDovecot } = require('./config');

const HELPER_PATH = process.env.MAIL_AGG_DOVECOT_HELPER_PATH || '/usr/local/sbin/mail-aggregator-dovecot-helper';

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, String(value));
}

function clearTargetPasswordOverrides(targetUser) {
  const accounts = db.prepare('SELECT id FROM accounts WHERE local_user = ?').all(targetUser);
  for (const account of accounts) fs.rmSync(targetPassPath(account.id), { force: true });
}

// IMAP quoted-string转义:反斜杠和双引号需要用反斜杠转义。
// CR/LF不允许出现在quoted string里,这类输入应该在API层就被拒绝,
// 这里只做协议层面的转义,不做输入校验。
function imapQuote(str) {
  return '"' + String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// 最小化的IMAP LOGIN探测:连上本地Dovecot,发LOGIN命令,看服务器是否返回OK。
// 不使用doveadm auth test之类的工具,因为那类命令行工具的密码参数会出现在
// 进程argv里(ps可见),这里用原始socket实现,密码只经过内存里的一次write()。
// 这不是要重新实现imapsync/getmail那类完整IMAP客户端,只是本项目自己管理
// 本地Dovecot账号时需要的一个几十行的"能不能登录"探测,和同步引擎无关。
function imapLoginTest(host, port, username, password, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = '';
    let stage = 'greeting';
    let done = false;

    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (e) {
        // ignore
      }
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      if (stage === 'greeting') {
        if (buffer.includes('\r\n')) {
          stage = 'login';
          buffer = '';
          const cmd = `a1 LOGIN ${imapQuote(username)} ${imapQuote(password)}\r\n`;
          socket.write(cmd);
        }
        return;
      }

      if (stage === 'login') {
        if (/^a1 OK/im.test(buffer)) {
          socket.write('a2 LOGOUT\r\n');
          finish(true);
        } else if (/^a1 (NO|BAD)/im.test(buffer)) {
          finish(false);
        }
        // 否则可能还有更多untagged响应在路上,继续等
      }
    });

    socket.connect(port, host);
  });
}

// 密码哈希生成逻辑单独抽到 ./doveadmHash.js,和 install.sh --full 调用的
// server/cli-dovecot-hash.js 共用完全同一个函数,不是这里一份、shell里另一份。

// 调用root持有的helper脚本,通过sudo这道最小化权限边界。
// stdinInput用于set-password子命令传递新哈希,其它子命令不需要。
function runHelper(args, stdinInput) {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-n', HELPER_PATH, ...args], {
      env: { PATH: process.env.PATH },
    });
    let stdout = '';
    let stderr = '';
    let stdinError = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));

    child.once('error', (err) => {
      finish({ ok: false, message: `无法调用helper: ${err.message}` });
    });
    // helper可能在读取输入前因为sudo规则、权限库缺失等原因退出。接住异步
    // EPIPE,避免一个可报告的helper错误变成整个Web服务崩溃。
    child.stdin.once('error', (err) => {
      stdinError = err;
    });

    child.once('close', (code) => {
      const trimmed = stdout.trim();
      if (code === 0) {
        finish({ ok: true, stdout: trimmed });
      } else {
        const fallback = stdinError
          ? `退出码 ${code}; stdin ${stdinError.code || stdinError.message}`
          : `退出码 ${code}`;
        finish({ ok: false, message: (stderr || stdout || fallback).trim() });
      }
    });

    try {
      child.stdin.end(stdinInput !== undefined ? stdinInput + '\n' : undefined);
    } catch (err) {
      finish({ ok: false, message: `写入helper失败: ${err.message}` });
    }
  });
}

function checkUserExists(username) {
  return new Promise((resolve) => {
    execFile('id', [username], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

function checkMaildirExists(username) {
  try {
    return fs.existsSync(`/home/${username}/Maildir`);
  } catch (e) {
    return false;
  }
}

// 修改Dovecot密码的完整编排。任何一步失败都要保证不会出现
// "Dovecot密码已经改了,但local-target.pass还是旧密码"这种不一致状态。
async function changeDovecotPassword(currentPassword, newPassword, dependencies = {}) {
  const loginTest = dependencies.imapLoginTest || imapLoginTest;
  const hashPassword = dependencies.generateDovecotHash || generateDovecotHash;
  const helper = dependencies.runHelper || runHelper;
  const saveLocalSecret = dependencies.saveGlobalLocalSecret || saveGlobalLocalSecret;
  const clearTargetOverrides = dependencies.clearTargetPasswordOverrides || clearTargetPasswordOverrides;
  const saveSetting = dependencies.setSetting || setSetting;
  const sleep = dependencies.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const local = dependencies.localDovecot ? dependencies.localDovecot() : localDovecot();
  const { user: targetUser, host: localHost, port: localPort } = local;

  // 1. 验证旧密码,防止误操作或者在密码已经不一致的情况下继续往下走
  const currentOk = await loginTest(localHost, localPort, targetUser, currentPassword);
  if (!currentOk) {
    return { ok: false, error: '当前密码验证失败(登录不上本地Dovecot),请确认填的是当前正确密码' };
  }


  // A Dovecot username has one password. Per-account overrides for this same
  // target user would shadow the newly committed global credential and become
  // stale, so remove them while the old global password is still valid.
  try {
    clearTargetOverrides(targetUser);
  } catch (error) {
    return { ok: false, error: `清理账号级本地密码覆盖失败，尚未修改 Dovecot: ${error.message}` };
  }

  // 2. 生成新密码的哈希,这一步之后Node进程内存里就不再需要新密码明文
  //    以外的任何东西了(明文只会被写进local-target.pass这一个文件)
  let newHash;
  try {
    newHash = await hashPassword(newPassword);
  } catch (e) {
    return { ok: false, error: `生成密码哈希失败: ${e.message}` };
  }

  // 3. 通过helper写入(helper内部会自动备份旧文件)
  const setResult = await helper(['set-password', targetUser], newHash);
  if (!setResult.ok) {
    return {
      ok: false,
      error: `写入 Dovecot 密码失败: ${setResult.message}(如果是sudo权限问题,检查是否跑过 install.sh --full 或者手动配置过 sudoers 规则)`,
    };
  }

  // 4. 用新密码实际尝试登录,这是判断这次修改是否真正成功的唯一标准
  // Dovecot reload can briefly race with auth workers. Bound retries protect the
  // atomic rollback guarantee without hiding a real failure behind an infinite wait.
  let newOk = false;
  for (const delay of [300, 500, 1000]) {
    await sleep(delay);
    newOk = await loginTest(localHost, localPort, targetUser, newPassword);
    if (newOk) break;
  }
  if (!newOk) {
    const restoreResult = await helper(['restore-backup']);
    return {
      ok: false,
      error: restoreResult.ok
        ? '新密码登录验证失败,已自动回滚到修改前的 Dovecot 配置,local-target.pass 未被改动'
        : `新密码登录验证失败,而且自动回滚也失败了(${restoreResult.message})——这种情况需要手动检查 /etc/dovecot/users 和它旁边的 .mail-aggregator-backup 备份文件`,
    };
  }

  // 5. 走到这里说明新密码已经确认可用,提交:更新local-target.pass、
  //    记录这次写入的哈希(供后续漂移检测比对)、清掉"使用默认密码"标记
  try {
    saveLocalSecret(newPassword);
  } catch (error) {
    const restoreResult = await helper(['restore-backup']);
    return {
      ok: false,
      error: restoreResult.ok
        ? `本地同步凭据写入失败，已回滚 Dovecot 密码: ${error.message}`
        : `本地同步凭据写入失败，而且 Dovecot 自动回滚失败(${restoreResult.message})——请立即检查 /etc/dovecot/users、备份文件和 local-target.pass`,
    };
  }
  const known = await helper(['get-hash', targetUser]);
  saveSetting('dovecot_last_known_hash', known.ok ? known.stdout : newHash);
  saveSetting('dovecot_using_default_password', 'false');

  return { ok: true };
}

// Dashboard用的Dovecot状态汇总
async function getDovecotStatus() {
  const local = localDovecot();
  const { user: targetUser, host: localHost, port: localPort } = local;

  const [userExists, reachable] = await Promise.all([
    checkUserExists(targetUser),
    checkTcpPort(localHost, localPort),
  ]);
  const maildirExists = checkMaildirExists(targetUser);

  let authTestOk = null; // null = 还没法测(比如从没在Web里设置过本地密码)
  let configuredPassword = '';
  if (hasGlobalLocalSecret()) {
    configuredPassword = readGlobalLocalSecret();
    if (configuredPassword) {
      authTestOk = await imapLoginTest(localHost, localPort, targetUser, configuredPassword);
    }
  }

  // v0.1.3 stored this flag unconditionally during installation. A non-default
  // credential is definitive evidence that the user has configured a password,
  // so repair stale installations without requiring another password change.
  let usingDefaultPassword = getSetting('dovecot_using_default_password', 'false') === 'true';
  if (usingDefaultPassword && configuredPassword && configuredPassword !== '123456') {
    setSetting('dovecot_using_default_password', 'false');
    usingDefaultPassword = false;
  }

  // 漂移检测:如果有人绕过Web直接手改了/etc/dovecot/users,我们读不到明文,
  // 但可以把"helper现在报告的哈希"和"我们自己上次通过Web设置时记下的哈希"
  // 做字符串比较,不一致就说明被外部改过。helper调用本身失败(比如sudo没配)
  // 时无法判断,标记为unknown而不是武断地报"一致"或"不一致"。
  let driftStatus = 'unknown';
  const knownHash = getSetting('dovecot_last_known_hash', '');
  if (knownHash) {
    const current = await runHelper(['get-hash', targetUser]);
    if (current.ok) {
      driftStatus = current.stdout.trim() === knownHash.trim() ? 'in_sync' : 'drifted';
    }
  }

  return {
    targetUser,
    userExists,
    maildirExists,
    reachable,
    authTestOk,
    driftStatus,
    usingDefaultPassword,
  };
}

module.exports = {
  imapLoginTest,
  generateDovecotHash,
  runHelper,
  changeDovecotPassword,
  getDovecotStatus,
  checkUserExists,
  checkMaildirExists,
  clearTargetPasswordOverrides,
};
