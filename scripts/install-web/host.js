'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validWebPort, WIZARD_PORT } = require('./protocol');

const project = path.resolve(__dirname, '../..');
const SAFE_PATH = '/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin';
const rootEnv = { PATH: SAFE_PATH, HOME: '/root' };
const MiB = 1024 * 1024;

function isPrivateIp(ip) {
  if (typeof ip !== 'string' || !net.isIPv4(ip)) return false;
  const [first, second] = ip.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function hasLanAddress(ip, interfaces = os.networkInterfaces()) {
  return isPrivateIp(ip) && Object.values(interfaces).flat().some(item => !item.internal && item.address === ip);
}

function listeningPorts(tables) {
  const ports = new Set();
  for (const table of tables) {
    for (const line of table.split('\n').slice(1)) {
      const [, addr, , state] = line.trim().split(/\s+/);
      if (state === '0A' && /^[0-9A-F]+:[0-9A-F]{4}$/i.test(addr)) ports.add(parseInt(addr.split(':')[1], 16));
    }
  }
  return ports;
}

function tcpPorts() {
  const tables = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try { tables.push(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (file !== '/proc/net/tcp6' || error.code !== 'ENOENT') throw error; }
  }
  return listeningPorts(tables);
}

function hasCapacity(statfs = fs.statfsSync) {
  return [['/', 1024], ['/usr', 768], ['/opt', 512], ['/var/lib', 256], ['/var/cache', 256],
    ['/home', 128], ['/tmp', 128], ['/var/log', 64], ['/run', 16]].every(([directory, minimum]) => {
    try {
      const { bavail, bsize, ffree } = statfs(directory, { bigint: true });
      return bavail * bsize >= BigInt(minimum * MiB) && ffree >= 2048n;
    } catch (_) { return false; }
  });
}

function inspectHost() {
  const guard = spawnSync('/bin/sh', ['-ec', `
    . "$1/scripts/lib/install-platform.sh"
    . "$1/scripts/lib/web-install-host.sh"
    web_install_platform "$1" || { printf '%s\\n' "$PLATFORM_ERROR"; exit 2; }
    node_version_supported /usr/bin/node && command -v npm >/dev/null || { echo node_version; exit 2; }
    printf '%s\\n' "$SERVICE_MANAGER"
    web_install_fresh_host`, 'sh', project], { env: rootEnv, timeout: 5000, encoding: 'utf8', maxBuffer: 4096 });
  const [manager, reason] = guard.stdout?.trim().split('\n') || [];
  if ((guard.status === 0 || guard.status === 1) && (manager === 'openrc' || manager === 'systemd')) {
    return { manager, fresh: guard.status === 0, reason: ['existing_app', 'existing_dovecot'].includes(reason) ? reason : undefined };
  }
  return { fresh: false, issue: guard.status === 2 ? manager : undefined };
}

function preflight(ip, port, includeWizardPort = false, host = inspectHost()) {
  let ports;
  try { ports = tcpPorts(); } catch (_) { /* Fail closed if the listener scan is unavailable. */ }
  const checks = [
    ['platform', Boolean(host.manager), host.issue],
    ['fresh', host.fresh, host.reason],
    ['lan', hasLanAddress(ip)],
    ['storage', hasCapacity()],
    ['web_port', validWebPort(port) && Boolean(ports && !ports.has(port))],
    ['imap_port', Boolean(ports && !ports.has(143))],
  ];
  if (includeWizardPort) checks.push(['wizard_port', Boolean(ports && !ports.has(WIZARD_PORT))]);
  return checks.map(([id, ok, reason]) => ({ id, ok, ...(reason ? { reason } : {}) }));
}

function verifySetupClosed(port) {
  if (!validWebPort(port)) return Promise.resolve(false);
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/auth/setup-status', agent: false }, response => {
      if (response.statusCode !== 200) { response.destroy(); resolve(false); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 2048) { response.destroy(); resolve(false); }
      });
      response.on('end', () => {
        try { resolve(JSON.parse(body).needsSetup === false); } catch (_) { resolve(false); }
      });
      response.on('error', () => resolve(false));
      response.on('close', () => resolve(false));
    });
    const deadline = setTimeout(() => { request.destroy(); resolve(false); }, 3000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', () => resolve(false));
  });
}

if (require.main === module) {
  const [mode, port, ip] = process.argv.slice(2);
  if (mode === 'check') process.exitCode = preflight(ip, Number(port)).every(check => check.ok) ? 0 : 1;
  else if (mode === 'verify') verifySetupClosed(Number(port)).then(ok => { process.exitCode = ok ? 0 : 1; });
  else process.exitCode = 2;
}

module.exports = { hasLanAddress, hasCapacity, inspectHost, isPrivateIp, listeningPorts, preflight, rootEnv };
