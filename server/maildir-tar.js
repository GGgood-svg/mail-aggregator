const { TextDecoder } = require('node:util');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const BLOCK = 512;
const MAX_ENTRIES = 1_000_000;
const MAX_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_PAX = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function field(block, start, length) {
  const slice = block.subarray(start, start + length);
  const zero = slice.indexOf(0);
  return decoder.decode(zero < 0 ? slice : slice.subarray(0, zero));
}
function octal(block, start, length) {
  const value = field(block, start, length).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error('非法 tar 数值');
  const number = parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error('tar 数值超出范围');
  return number;
}
function safePath(raw) {
  let value = String(raw);
  if (value.includes('\\')) throw new Error('备份包含不安全路径');
  while (value.startsWith('./')) value = value.slice(2);
  value = value.replace(/\/+$/, '');
  if (!value || value === '.') return '';
  if (value.length > 4096 || value.startsWith('/') || /^[A-Za-z]:/.test(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('备份包含不安全路径');
  if (value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('备份包含不安全路径');
  return value;
}
function parsePax(buffer) {
  const fields = Object.create(null);
  const allowed = new Set(['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname']);
  for (let offset = 0; offset < buffer.length;) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('非法 PAX 条目');
    const countText = buffer.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d*$/.test(countText)) throw new Error('非法 PAX 条目长度');
    const length = Number(countText), end = offset + length;
    if (!Number.isSafeInteger(length) || end > buffer.length || end <= space + 2 || buffer[end - 1] !== 10) throw new Error('非法 PAX 条目长度');
    const record = decoder.decode(buffer.subarray(space + 1, end - 1));
    const equals = record.indexOf('=');
    if (equals < 1) throw new Error('非法 PAX 条目');
    const key = record.slice(0, equals), value = record.slice(equals + 1);
    if (!allowed.has(key) || Object.hasOwn(fields, key)) throw new Error('备份含不支持的 PAX 属性');
    fields[key] = value;
    offset = end;
  }
  return fields;
}

// Only relative regular files and directories, unique paths, bounded sizes,
// and a conservative subset of PAX attributes are accepted. A writer may
// stage selected files as they are checked, and publish only after validation
// and decryption have both finished successfully.
async function validateMaildirTar(source, { maxExpandedBytes = MAX_BYTES, onEntry, openEntry } = {}) {
  if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 1 || maxExpandedBytes > MAX_BYTES) throw new Error('解压体积上限不合法');
  const gzip = zlib.createGunzip();
  const pump = pipeline(source, gzip);
  pump.catch(() => {});
  let buffer = Buffer.alloc(0), current = null, padding = 0, pendingPax = null, ended = false;
  let entries = 0, bytes = 0, expandedBytes = 0;
  const seen = new Set();
  const required = new Set(['cur', 'new', 'tmp']);
  function finish() {
    if (current.pax) pendingPax = parsePax(Buffer.concat(current.chunks));
    padding = (BLOCK - current.size % BLOCK) % BLOCK;
    current = null;
  }
  try {
    for await (const chunk of gzip) {
      expandedBytes += chunk.length;
      if (expandedBytes > maxExpandedBytes) throw new Error('备份解压体积超过上限');
      if (ended) { if (chunk.some(byte => byte !== 0)) throw new Error('tar 结束后存在额外内容'); continue; }
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length) {
        if (current) {
          const take = Math.min(current.remaining, buffer.length), part = buffer.subarray(0, take);
          if (current.pax) current.chunks.push(Buffer.from(part));
          else {
            bytes += take;
            if (bytes > MAX_BYTES) throw new Error('备份解压体积超过上限');
            if (current.writer) await current.writer.write(part);
          }
          current.remaining -= take; buffer = buffer.subarray(take);
          if (!current.remaining) {
            if (current.writer) await current.writer.finish();
            finish();
          }
          continue;
        }
        if (padding) { const take = Math.min(padding, buffer.length); padding -= take; buffer = buffer.subarray(take); continue; }
        if (buffer.length < BLOCK) break;
        const header = buffer.subarray(0, BLOCK); buffer = buffer.subarray(BLOCK);
        if (header.every(byte => byte === 0)) {
          if (pendingPax || buffer.some(byte => byte !== 0)) throw new Error('tar 结束标记不合法');
          ended = true; buffer = Buffer.alloc(0); break;
        }
        let checksum = 0;
        for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
        if (checksum !== octal(header, 148, 8) || !field(header, 257, 6).startsWith('ustar')) throw new Error('tar 头校验失败');
        const type = String.fromCharCode(header[156] || 0), headerSize = octal(header, 124, 12);
        if (type === 'x') {
          if (pendingPax || headerSize > MAX_PAX) throw new Error('非法 PAX 头');
          current = { pax: true, size: headerSize, remaining: headerSize, chunks: [] };
          if (!headerSize) finish();
          continue;
        }
        if (!['\0', '0', '5'].includes(type)) throw new Error('备份只允许普通文件和目录');
        const name = field(header, 0, 100), prefix = field(header, 345, 155);
        const entryPath = safePath(pendingPax?.path ?? (prefix ? `${prefix}/${name}` : name));
        let size = headerSize;
        if (pendingPax?.size !== undefined) {
          if (!/^\d+$/.test(pendingPax.size)) throw new Error('非法 PAX 文件大小');
          size = Number(pendingPax.size);
          if (!Number.isSafeInteger(size)) throw new Error('PAX 文件大小超出范围');
        }
        let mtime;
        if (onEntry || openEntry) {
          const rawMtime = pendingPax?.mtime;
          if (rawMtime !== undefined && !/^-?\d+(?:\.\d+)?$/.test(rawMtime)) throw new Error('非法 PAX 时间');
          mtime = rawMtime === undefined ? octal(header, 136, 12) : Number(rawMtime);
          if (!Number.isFinite(mtime) || Math.abs(mtime) > 8.64e12) throw new Error('PAX 时间超出范围');
        }
        pendingPax = null;
        if (seen.has(entryPath)) throw new Error('备份包含重复路径');
        seen.add(entryPath);
        if (++entries > MAX_ENTRIES || size > MAX_BYTES - bytes) throw new Error('备份内容超过安全上限');
        if (type === '5') {
          if (size) throw new Error('目录条目大小不为零');
          required.delete(entryPath);
          const entry = { path: entryPath, directory: true, size, mtime };
          onEntry?.(entry);
          if (openEntry) await openEntry(entry);
          continue;
        }
        if (!entryPath) throw new Error('文件路径为空');
        const entry = { path: entryPath, directory: false, size, mtime };
        onEntry?.(entry);
        const writer = openEntry && await openEntry(entry);
        current = { pax: false, size, remaining: size, writer };
        if (!size) {
          if (writer) await writer.finish();
          finish();
        }
      }
    }
    await pump;
    if (!ended || current || padding || buffer.length || pendingPax || required.size) throw new Error('tar 归档或 Maildir 结构不完整');
    return { entries, bytes, expandedBytes };
  } catch (error) {
    source.destroy(); gzip.destroy(); await pump.catch(() => {}); throw error;
  }
}

module.exports = { validateMaildirTar, safePath, parsePax, MAX_ENTRIES, MAX_BYTES };
