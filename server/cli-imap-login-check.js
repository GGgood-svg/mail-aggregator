#!/usr/bin/env node
// mail-aggregator - 安装期间(install.sh --full)用来验证本地 Dovecot 是否真的
// 接受明文 IMAP LOGIN,而不是只看 doveadm user 这种"userdb 查得到"层面的结果。
//
// 用法: node cli-imap-login-check.js <host> <port> <username>
// 密码通过 stdin 传入,不经过命令行参数(ps不可见),和 cli-dovecot-hash.js
// 是同一个约定。
//
// 这是"尽力而为"的检查:安装脚本里失败只打印警告,不会让整个安装失败——
// 本地明文LOGIN也可能因为这台机器上和本项目无关的其它 Dovecot 策略被拒绝,
// 那种情况下 doveadm user 已经能确认 passdb/userdb 本身没问题了。

// Both installer and Web authentication probes enforce target TLS policy.

const host = process.argv[2];
const port = parseInt(process.argv[3], 10);
const username = process.argv[4];

if (require.main === module) {
  if (!host || !port || !username) {
    console.error('ERROR: usage: cli-imap-login-check.js <host> <port> <username> (密码从stdin读)');
    process.exit(1);
  }

  let password = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    password += chunk;
    if (password.length > 4096) {
      console.error('ERROR: password input is too large');
      process.exit(1);
    }
  });
  process.stdin.on('end', () => {
    password = password.replace(/\r?\n+$/, '');
    runCheck(password);
  });
}

async function runCheck(password) {
  try {
    imapQuote(username); imapQuote(password);
    const ok = await require('./target-transport').testTargetLogin({ host, port }, username, password);
    if (ok) console.log('OK');
    else { console.error('ERROR: IMAP authentication failed'); process.exitCode = 1; }
  } catch (_) {
    console.error('ERROR: invalid credential or IMAP connection'); process.exitCode = 1;
  }
}

function imapQuote(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error('IMAP credential contains a forbidden control character');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

module.exports = { imapQuote };
