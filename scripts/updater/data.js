'use strict';
// Fixed-path operations; the parent only runs this script with the service uid.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const { flushDirectory } = require('./transaction');
const root = '/var/lib/mail-aggregator';
const dbPath = path.join(root, 'db/mail-aggregator.db');
const action = process.argv[2];
const app = process.argv[3];

async function main() {
  if (process.getuid() === 0) throw new Error('unprivileged only');
  const Database = require(path.join(app, 'node_modules/better-sqlite3'));
  if (action === 'port') {
    const db = new Database(dbPath, { fileMustExist: true, readonly: true, timeout: 2000 });
    try {
      const port = Number(db.prepare("SELECT value FROM settings WHERE key='web_port'").get()?.value || 8080);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port');
      process.stdout.write(String(port));
    } finally { db.close(); }
    return;
  }
  if (action === 'preflight') {
    const version = JSON.parse(await fsp.readFile(path.join(app, 'package.json'), 'utf8'));
    const lock = JSON.parse(await fsp.readFile(path.join(app, 'package-lock.json'), 'utf8'));
    if (version.name !== 'mail-aggregator' || version.version !== process.argv[4] || version.version !== lock.version) throw new Error('version mismatch');
    const db = new Database(':memory:');
    try { db.prepare('SELECT 1').get(); } finally { db.close(); }
    const security = require(path.join(app, 'server/http-security'));
    const config = JSON.parse(process.env.UPDATE_WEB_CONFIG || '{}');
    const requestedHost = (config.MAIL_AGG_BIND_HOST || '').trim() || '127.0.0.1';
    if (config.PORT && (!/^\d+$/.test(config.PORT) || Number(config.PORT) < 1 || Number(config.PORT) > 65535)) throw new Error('invalid Web port');
    const bindHost = security.resolveBindHost(requestedHost, '127.0.0.1');
    if (bindHost !== requestedHost || security.validateHttpSecurityConfig({ bindHost,
      trustProxy: security.parseTrustProxy(config.MAIL_AGG_TRUST_PROXY), cookieSecure: security.parseCookieSecure(config.MAIL_AGG_COOKIE_SECURE),
      requireHttps: security.parseBoolean(config.MAIL_AGG_REQUIRE_HTTPS),
    }).length) throw new Error('invalid Web configuration');
    return;
  }
  if (action === 'stopped') {
    const lock = new Database(path.join(root, '.process-lock.db'), { timeout: 0 });
    try { lock.exec('BEGIN EXCLUSIVE'); } finally { lock.close(); }
    return;
  }
  if (action === 'snapshot') {
    const scratch = await fsp.mkdtemp(path.join(root, 'update-snapshot-'));
    const filename = path.join(scratch, 'db');
    try {
      const db = new Database(dbPath, { fileMustExist: true, readonly: true, timeout: 0 });
      try { await db.backup(filename); } finally { db.close(); }
      const copy = new Database(filename, { fileMustExist: true, readonly: true });
      try { if (copy.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('snapshot not consistent'); }
      finally { copy.close(); }
      await pipeline(fs.createReadStream(filename), process.stdout);
    } finally { await fsp.rm(scratch, { recursive: true, force: true }); }
    return;
  }
  if (action === 'restore') {
    const temporary = path.join(path.dirname(dbPath), `.update-db-${randomUUID()}`);
    try {
      await pipeline(process.stdin, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      const copy = new Database(temporary, { fileMustExist: true, readonly: true });
      try { if (copy.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('snapshot not consistent'); }
      finally { copy.close(); }
      const file = await fsp.open(temporary, 'r');
      try { await file.sync(); } finally { await file.close(); }
      for (const suffix of ['-wal', '-shm', '-journal']) await fsp.rm(dbPath + suffix, { force: true });
      await fsp.rename(temporary, dbPath);
      await flushDirectory(path.dirname(dbPath));
    } finally { await fsp.rm(temporary, { force: true }); }
    return;
  }
  throw new Error('unknown operation');
}
main().catch(() => { process.exitCode = 1; });
