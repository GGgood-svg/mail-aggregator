'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { WIZARD_PORT, TOKEN, receiveLines, send } = require('./protocol');
const COOKIE = '__Host-mailagg-setup';
const MAX_BODY = 4096;
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/setup.css', ['setup.css', 'text/css; charset=utf-8']],
  ['/setup.js', ['setup.js', 'text/javascript; charset=utf-8']],
]);
const routes = new Map([
  ['GET /api/status', 'status'], ['POST /api/pair', 'pair'], ['POST /api/preflight', 'preflight'],
  ['POST /api/install', 'install'], ['POST /api/reveal', 'reveal'], ['POST /api/finish', 'finish'],
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_BODY) reject(413);
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (received > MAX_BODY) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(400); }
    });
    req.on('error', () => reject(400));
    req.on('aborted', () => reject(400));
  });
}

function createHttps({ ip, key, cert, call }) {
  const files = new Map([...assets].map(([url, [name, type]]) => [url, [fs.readFileSync(path.join(__dirname, name)), type]]));
  const server = https.createServer({ key, cert, minVersion: 'TLSv1.2', headersTimeout: 8000, requestTimeout: 12000,
    maxHeaderSize: 8192, handshakeTimeout: 8000, connectionsCheckingInterval: 1500 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    function reply(status, body, close = false) {
      if (res.destroyed || res.writableEnded) return;
      if (close) res.setHeader('Connection', 'close');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    }
    const authority = `${ip}:${server.address().port}`;
    if (req.headers.host !== authority) return reply(421, { error: 'wrong_host' }, true);
    if (req.method === 'GET' && files.has(req.url)) {
      const [body, type] = files.get(req.url);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
      return res.end(body);
    }
    const op = routes.get(`${req.method} ${req.url}`);
    if (!op) return reply(404, { error: 'not_found' });
    let data;
    if (req.method === 'POST') {
      if (req.headers.origin !== `https://${authority}`) return reply(403, { error: 'origin' }, true);
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')
          || req.headers['content-encoding']) return reply(415, { error: 'json_required' }, true);
      if (Number(req.headers['content-length']) > MAX_BODY) return reply(413, { error: 'body_too_large' }, true);
      try { data = await readBody(req); }
      catch (status) { return reply(status, { error: status === 413 ? 'body_too_large' : 'invalid_json' }, true); }
    }
    const session = (req.headers.cookie || '').split(/;\s*/).filter(value => value.startsWith(`${COOKIE}=`));
    const value = session.length === 1 && session[0].slice(COOKIE.length + 1);
    try {
      const result = await call({ op, session: TOKEN.test(value) ? value : undefined, csrf: req.headers['x-install-csrf'], data });
      if (res.destroyed) return;
      if (result.cookie) res.setHeader('Set-Cookie', `${COOKIE}=${result.cookie}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=8400`);
      if (result.close) res.setHeader('Set-Cookie', `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return reply(result.status, result.body, result.close);
    } catch (_) { return reply(503, { error: 'installer_unavailable' }, true); }
  });
  server.maxConnections = 24;
  server.maxRequestsPerSocket = 50;
  server.keepAliveTimeout = 1500;
  server.setTimeout(12000);
  return server;
}

function main() {
  // Spawned by the root runner with a dedicated, transient uid/gid.
  if (!process.getuid() || !process.getgid() || process.getgroups().some(gid => gid !== process.getgid())) process.exit(1);
  let server, sequence = 0;
  const pending = new Map();
  const stop = () => {
    if (server) { server.close(); server.closeAllConnections(); }
    process.exit(0);
  };
  const call = message => new Promise((resolve, reject) => {
    if (pending.size >= 24) return reject(Error('busy'));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('timeout')); }, 10_000);
    pending.set(id, result => { clearTimeout(timer); resolve(result); });
    send(process.stdout, { id, ...message });
  });
  process.stdout.on('error', stop);
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  receiveLines(process.stdin, line => {
    const message = JSON.parse(line);
    if (message.shutdown === true) return stop();
    if (!server && message.init) {
      server = createHttps({ ...message.init, call });
      server.once('error', () => process.exit(1));
      server.listen(WIZARD_PORT, message.init.ip, () => send(process.stdout, { ready: true }));
    } else if (pending.has(message.id)) {
      const settle = pending.get(message.id);
      pending.delete(message.id);
      settle(message);
    }
  }, stop);
}

if (require.main === module) main();
module.exports = { createHttps };
