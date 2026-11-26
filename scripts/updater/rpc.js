'use strict';
const net = require('node:net');
const { UpdateError } = require('./release');
const LIMIT = 16000;
function call(socket, payload, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let data = '', bytes = 0;
    client.setEncoding('utf8');
    const timer = setTimeout(() => { client.destroy(); reject(new UpdateError('updater_unavailable')); }, timeout);
    client.once('connect', () => client.write(`${JSON.stringify(payload)}\n`));
    client.on('data', chunk => {
      data += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes > LIMIT) { client.destroy(new UpdateError('updater_unavailable')); return; }
      const end = data.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(data.slice(0, end));
        if (!response.ok) reject(new UpdateError(response.error));
        else resolve(response.result);
      } catch (_) { reject(new UpdateError('updater_unavailable')); }
      client.destroy();
    });
    client.once('error', () => reject(new UpdateError('updater_unavailable')));
    client.once('close', () => { clearTimeout(timer); reject(new UpdateError('updater_unavailable')); });
  });
}
function listen(descriptor, handle) {
  return new Promise((resolve, reject) => {
    let clients = 0;
    const server = net.createServer(socket => {
      if (clients >= 32) { socket.destroy(); return; }
      clients++;
      socket.once('close', () => clients--);
      socket.on('error', () => {});
      socket.setEncoding('utf8');
      socket.setTimeout(12000, () => socket.destroy());
      let data = '', bytes = 0, started = false;
      socket.on('data', chunk => {
        if (started) return;
        data += chunk;
        bytes += Buffer.byteLength(chunk);
        if (bytes > LIMIT) { socket.destroy(); return; }
        const end = data.indexOf('\n');
        if (end < 0) return;
        started = true;
        Promise.resolve().then(() => handle(JSON.parse(data.slice(0, end)))).then(
          result => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
          error => socket.end(`${JSON.stringify({ ok: false, error: error instanceof UpdateError ? error.code : 'updater_error' })}\n`),
        );
      });
    });
    server.once('error', reject);
    server.listen(descriptor, () => resolve(server));
  });
}
module.exports = { call, listen };
