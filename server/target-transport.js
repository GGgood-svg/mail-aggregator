function isLocalTarget(host) {
  return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(String(host).toLowerCase());
}

function imapTransportOptions(local) {
  if (Number(local.port) === 993) return { secure: true };
  return { secure: false, doSTARTTLS: !isLocalTarget(local.host) };
}

function applyTargetTransport(args, local) {
  if (Number(local.port) === 993) args.push('--ssl2');
  else if (isLocalTarget(local.host)) return args.concat(['--nossl2', '--notls2']);
  else args.push('--nossl2', '--tls2');
  args.push('--sslargs2', 'SSL_verify_mode=1', '--sslargs2', 'SSL_verifycn_scheme=imap',
    '--sslargs2', `SSL_verifycn_name=${local.host}`, '--sslargs2', `SSL_hostname=${local.host}`);
  return args;
}
async function testTargetLogin(local, username, password, timeoutMs = 8000, dependencies = {}) {
  const options = { host: local.host, port: local.port, ...imapTransportOptions(local),
    auth: { user: username, pass: password }, logger: false, disableAutoIdle: true,
    connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs };
  const client = dependencies.createClient ? dependencies.createClient(options) : new (require('imapflow').ImapFlow)(options);
  client.on('error', () => {});
  try { await client.connect(); return true; }
  catch (_) { return false; }
  finally { try { client.close(); } catch (_) {} }
}
module.exports = { isLocalTarget, imapTransportOptions, applyTargetTransport, testTargetLogin };
