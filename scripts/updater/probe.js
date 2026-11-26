'use strict';
const { call } = require('./rpc');
const http = require('node:http');
const net = require('node:net');
const socket = '/run/mail-aggregator-update-app/control.sock';
const action = process.argv[2];
const version = process.argv[3];
async function main() {
  if (action === 'legacy-ready') {
    const port = Number(version);
    let host = process.argv[4] || '127.0.0.1';
    if (host === '::') host = '::1';
    if (host === '0.0.0.0' || host === 'localhost') host = '127.0.0.1';
    if (!net.isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) return (process.exitCode = 2);
    for (let attempt = 0; attempt < 60; attempt++) {
      const ok = await new Promise(resolve => {
        const req = http.get({ host, port, path: '/api/branding', headers: { Accept: 'application/json' } }, res => {
          res.destroy(); resolve([200, 301, 302, 308, 426].includes(res.statusCode));
        });
        req.once('error', () => resolve(false));
        req.setTimeout(500, () => req.destroy());
      });
      if (ok) return;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    process.exitCode = 1;
    return;
  }
  if (action === 'idle') {
    const result = await call(socket, { op: 'probe' });
    if (!result.paused || !result.idle || !result.ready) process.exitCode = 1;
  } else if (action === 'ready') {
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = await call(socket, { op: 'probe' }, 500).catch(() => null);
      if (result?.version === version && result.ready) return;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    process.exitCode = 1;
  } else process.exitCode = 2;
}
main().catch(() => { process.exitCode = 1; });
