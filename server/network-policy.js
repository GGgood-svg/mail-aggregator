'use strict';

const net = require('node:net');
const dns = require('node:dns').promises;

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['2001:db8::', 32],
]) blocked.addSubnet(address, prefix, 'ipv6');

function isBlockedAddress(address, family = net.isIP(address)) {
  if (family === 4 || family === 'IPv4' || family === 'ipv4') {
    return blocked.check(address, 'ipv4');
  }
  if (family === 6 || family === 'IPv6' || family === 'ipv6') {
    // IPv4-mapped IPv6 literals are unnecessary for IMAP configuration and are
    // rejected entirely to avoid bypasses caused by mixed-family normalization.
    if (/^::ffff:/i.test(address)) return true;
    return blocked.check(address, 'ipv6');
  }
  return true;
}

function isLocalHostname(host) {
  const normalized = String(host || '').replace(/\.$/, '').toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local');
}

async function assertPublicImapHost(host, lookup = dns.lookup) {
  const normalized = String(host || '').trim();
  if (isLocalHostname(normalized)) throw new Error('IMAP服务器不能指向本机或局域网地址');
  const literalFamily = net.isIP(normalized);
  if (literalFamily) {
    if (isBlockedAddress(normalized, literalFamily)) throw new Error('IMAP服务器不能指向本机、局域网或保留地址');
    return [{ address: normalized, family: literalFamily }];
  }

  let addresses;
  try {
    addresses = await lookup(normalized, { all: true, verbatim: true });
  } catch (_) {
    throw new Error('无法解析 IMAP 服务器地址');
  }
  if (!Array.isArray(addresses) || !addresses.length) throw new Error('IMAP服务器没有可用地址');
  if (addresses.some((item) => isBlockedAddress(item.address, item.family))) {
    throw new Error('IMAP服务器解析到了本机、局域网或保留地址，已拒绝连接');
  }
  return addresses;
}

function assertSecureAccountEndpoint(account, preset = null) {
  if (!account || !account.ssl) throw new Error('远程IMAP必须使用SSL/TLS，不能发送明文密码');
  if (account.provider && account.provider !== 'custom') {
    if (!preset) throw new Error('账号使用了未知的邮件服务商预设');
    const actualHost = String(account.host || '').replace(/\.$/, '').toLowerCase();
    const presetHost = String(preset.host || '').replace(/\.$/, '').toLowerCase();
    if (actualHost !== presetHost || Number(account.port) !== Number(preset.port)
        || String(account.auth_type) !== String(preset.auth_type) || !preset.ssl) {
      throw new Error('邮件服务商预设的连接地址或认证方式已被篡改');
    }
  }
}

module.exports = { isBlockedAddress, isLocalHostname, assertPublicImapHost, assertSecureAccountEndpoint };
