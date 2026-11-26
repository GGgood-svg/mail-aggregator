'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ensure, MiB, UpdateError } = require('./release');
const TOP = new Set(['server', 'web', 'node_modules', 'scripts', 'config']);
const FILES = new Set(['package.json', 'package-lock.json', 'TESTING.md']);
const MAX_EXPANDED = 384 * MiB;
function text(buffer) {
  const zero = buffer.indexOf(0);
  if (zero >= 0) ensure(buffer.subarray(zero).every(b => b === 0), 'invalid_archive');
  return buffer.subarray(0, zero < 0 ? buffer.length : zero).toString('utf8');
}
function oct(buffer) {
  const field = buffer.toString('latin1');
  // USTAR checksum: six octal digits, NUL, then a space (GNU tar).
  const value = /^ *([0-7]+)[\0 ]*$/.exec(field);
  ensure(value, 'invalid_archive');
  return parseInt(value[1], 8);
}
function header(block) {
  const chars = Buffer.from(block);
  chars.fill(32, 148, 156);
  ensure(chars.reduce((sum, n) => sum + n, 0) === oct(block.subarray(148, 156)) && block.toString('ascii', 257, 262) === 'ustar', 'invalid_archive');
  const type = block[156];
  ensure(type === 48 || type === 0 || type === 53, 'invalid_archive_type');
  const prefix = text(block.subarray(345, 500));
  const raw = `${prefix ? `${prefix}/` : ''}${text(block.subarray(0, 100))}`.replace(/\/$/, '');
  const parts = raw.split('/');
  ensure(parts.every(p => p !== '.' && p !== '..' && /^[\p{L}\p{N} _@+.,()!$%&'=[\]{}~-]+$/u.test(p)) &&
    (TOP.has(parts[0]) || (parts.length === 1 && FILES.has(raw) && type !== 53)), 'invalid_archive_path');
  const size = oct(block.subarray(124, 136));
  ensure(Number.isSafeInteger(size) && size <= MAX_EXPANDED && (type !== 53 || size === 0), 'invalid_archive');
  return { raw, size, directory: type === 53 };
}
async function extract(filename, dest) {
  await fsp.mkdir(dest, { mode: 0o755 });
  const input = fs.createReadStream(filename);
  const unzip = zlib.createGunzip();
  let total = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    total += chunk.length;
    callback(total > MAX_EXPANDED ? new UpdateError('archive_too_large') : null, chunk);
  } });
  const reading = pipeline(input, unzip, limit);
  reading.catch(() => {});
  const seen = new Set(), regular = new Set(), directories = new Set([dest]);
  let buffer = Buffer.alloc(0), fd, remain = 0, padding = 0, endings = 0;
  try {
    for await (const chunk of limit) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (remain > 0) {
          const count = Math.min(remain, buffer.length);
          const write = await fd.write(buffer, 0, count);
          ensure(write.bytesWritten === count, 'short_file_write');
          buffer = buffer.subarray(count);
          remain -= count;
          if (!remain) { await fd.sync(); await fd.close(); fd = null; }
        } else if (padding) {
          const count = Math.min(padding, buffer.length);
          ensure(buffer.subarray(0, count).every(n => n === 0), 'invalid_archive');
          buffer = buffer.subarray(count);
          padding -= count;
        } else if (buffer.length >= 512) {
          const block = buffer.subarray(0, 512);
          buffer = buffer.subarray(512);
          if (block.every(n => n === 0)) { endings++; continue; }
          ensure(!endings && seen.size < 40000, 'invalid_archive');
          const entry = header(block);
          ensure(!seen.has(entry.raw), 'duplicate_archive_entry');
          seen.add(entry.raw);
          const target = path.join(dest, entry.raw);
          await fsp.mkdir(path.dirname(target), { mode: 0o755, recursive: true });
          directories.add(path.dirname(target));
          if (entry.directory) { await fsp.mkdir(target, { mode: 0o755, recursive: true }); directories.add(target); }
          else {
            regular.add(entry.raw);
            fd = await fsp.open(target, 'wx', entry.raw.startsWith('scripts/') && entry.raw.endsWith('.sh') ? 0o755 : 0o644);
            remain = entry.size;
            padding = (512 - (remain % 512)) % 512;
            if (!remain) { await fd.sync(); await fd.close(); fd = null; }
          }
        } else break;
      }
    }
    await reading;
    if (process.platform !== 'win32') for (const dir of directories) await require('./transaction').flushDirectory(dir);
    ensure(endings >= 2 && !buffer.length && !remain && !padding && ['package.json', 'package-lock.json', 'server/app.js', 'web/index.html', 'node_modules/better-sqlite3/package.json'].every(p => regular.has(p)), 'invalid_archive');
  } finally { if (fd) await fd.close(); limit.destroy(); await reading.catch(() => {}); }
}
module.exports = { extract, MAX_EXPANDED };
