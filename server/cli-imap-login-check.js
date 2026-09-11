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

const net = require('net');

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

function runCheck(password) {
  const socket = net.createConnection({ host, port });
  let buf = '';
  let stage = 'greeting';

  const timer = setTimeout(() => {
    console.error('ERROR: timeout waiting for IMAP server response');
    socket.destroy();
    process.exit(1);
  }, 8000);

  const finish = (ok, message) => {
    clearTimeout(timer);
    if (ok) {
      console.log('OK');
      socket.end();
      process.exit(0);
    } else {
      console.error(`ERROR: ${message}`);
      socket.destroy();
      process.exit(1);
    }
  };

  socket.on('data', (data) => {
    buf += data.toString('utf8');
    if (!buf.includes('\r\n')) return;

    if (stage === 'greeting') {
      stage = 'login';
      buf = '';
      // Use IMAP quoted strings because --default-dovecot-password may contain
      // whitespace, quotes, or backslashes even though generated passwords are hex.
      socket.write(`a LOGIN ${imapQuote(username)} ${imapQuote(password)}\r\n`);
      return;
    }

    if (stage === 'login') {
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^a\s+OK/i.test(last)) {
        finish(true);
      } else if (/^a\s+(NO|BAD)/i.test(last)) {
        finish(false, `IMAP LOGIN 被拒绝: ${last}`);
      }
      // 否则可能是多行响应的一部分,继续等待更多数据
    }
  });

  socket.on('error', (err) => {
    finish(false, `连接 ${host}:${port} 失败: ${err.message}`);
  });
}

function imapQuote(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error('IMAP credential contains a forbidden control character');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

module.exports = { imapQuote };
