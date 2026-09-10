'use strict';

function applySourceTransport(args, account) {
  if (!account || !account.ssl) throw new Error('远程IMAP必须使用SSL/TLS');
  // imapsync 的 --ssl1 只加密连接，默认并不验证服务器证书。显式启用
  // SSL_VERIFY_PEER，防止中间人用自签证书截获邮箱密码或OAuth令牌。
  args.push('--ssl1', '--sslargs1', 'SSL_verify_mode=1');
  return args;
}

module.exports = { applySourceTransport };
