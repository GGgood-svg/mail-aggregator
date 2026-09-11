const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { hashFile } = require('./backup');

const BLOCK_SIZE = 512;
const MAX_ENTRIES = 10000;
const MAX_UNCOMPRESSED_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function headerString(header, start, length) {
  const end = header.indexOf(0, start);
  return header.subarray(start, end === -1 || end > start + length ? start + length : end)
    .toString('utf8').trim();
}

function parseOctal(header, start, length, label) {
  const text = headerString(header, start, length).trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`${label}不是合法八进制数`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}超出安全范围`);
  return value;
}

function verifyHeaderChecksum(header) {
  const expected = parseOctal(header, 148, 8, 'tar校验和');
  let actual = 0;
  for (let index = 0; index < header.length; index++) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error('tar条目头校验失败');
}

function normalizeEntryPath(rawPath) {
  let value = String(rawPath || '').replace(/\\/g, '/');
  while (value.startsWith('./')) value = value.slice(2);
  value = value.replace(/\/+$/, '');
  if (!value) return '';
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) throw new Error('备份包含绝对路径');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('备份包含不安全路径');
  }
  if (value.length > 255) throw new Error('备份条目路径过长');
  return value;
}

function isAllowedPath(entryPath, isDirectory) {
  if (isDirectory) {
    return entryPath === ''
      || ['data', 'data/db', 'data/secrets'].includes(entryPath)
      || entryPath.startsWith('data/secrets/');
  }
  return entryPath === 'manifest.json'
    || entryPath === 'data/db/mail-aggregator.db'
    || entryPath.startsWith('data/secrets/');
}

async function readTarInventory(archivePath) {
  const source = fs.createReadStream(archivePath);
  const stream = zlib.createGunzip();
  source.pipe(stream);
  let buffer = Buffer.alloc(0);
  let current = null;
  let paddingRemaining = 0;
  let totalBytes = 0;
  let entryCount = 0;
  let ended = false;
  const files = new Map();
  const seen = new Set();
  let manifestText = null;

  function finishCurrent() {
    const sha256 = current.hash.digest('hex');
    files.set(current.path, { path: current.path, size: current.size, sha256 });
    if (current.manifestChunks) manifestText = Buffer.concat(current.manifestChunks).toString('utf8');
    paddingRemaining = (BLOCK_SIZE - (current.size % BLOCK_SIZE)) % BLOCK_SIZE;
    current = null;
  }

  try {
    for await (const chunk of stream) {
      if (ended && chunk.some((byte) => byte !== 0)) throw new Error('tar结束标记后仍有额外数据');
      if (ended) continue;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length) {
        if (current) {
          const take = Math.min(current.remaining, buffer.length);
          const part = buffer.subarray(0, take);
          current.hash.update(part);
          if (current.manifestChunks) current.manifestChunks.push(Buffer.from(part));
          current.remaining -= take;
          totalBytes += take;
          buffer = buffer.subarray(take);
          if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('备份解压后体积超过安全上限');
          if (current.remaining === 0) finishCurrent();
          continue;
        }
        if (paddingRemaining) {
          const take = Math.min(paddingRemaining, buffer.length);
          paddingRemaining -= take;
          buffer = buffer.subarray(take);
          continue;
        }
        if (buffer.length < BLOCK_SIZE) break;
        const header = buffer.subarray(0, BLOCK_SIZE);
        buffer = buffer.subarray(BLOCK_SIZE);
        if (header.every((byte) => byte === 0)) {
          ended = true;
          if (buffer.some((byte) => byte !== 0)) throw new Error('tar结束标记后仍有额外数据');
          buffer = Buffer.alloc(0);
          break;
        }
        verifyHeaderChecksum(header);
        const name = headerString(header, 0, 100);
        const prefix = headerString(header, 345, 155);
        const entryPath = normalizeEntryPath(prefix ? `${prefix}/${name}` : name);
        const type = String.fromCharCode(header[156] || 0);
        const isDirectory = type === '5';
        const isRegular = type === '\0' || type === '0';
        if (!isDirectory && !isRegular) throw new Error(`备份包含不允许的tar条目类型: ${type}`);
        if (!isAllowedPath(entryPath, isDirectory)) throw new Error(`备份包含非白名单路径: ${entryPath}`);
        if (seen.has(entryPath)) throw new Error(`备份包含重复条目: ${entryPath || '.'}`);
        seen.add(entryPath);
        entryCount++;
        if (entryCount > MAX_ENTRIES) throw new Error('备份条目数量超过安全上限');
        const size = parseOctal(header, 124, 12, 'tar条目大小');
        if (isDirectory) {
          if (size !== 0) throw new Error('tar目录条目大小不为零');
          continue;
        }
        if (entryPath === 'manifest.json' && size > MAX_MANIFEST_BYTES) {
          throw new Error('备份清单超过安全上限');
        }
        current = {
          path: entryPath,
          size,
          remaining: size,
          hash: crypto.createHash('sha256'),
          manifestChunks: entryPath === 'manifest.json' ? [] : null,
        };
        if (size === 0) finishCurrent();
      }
    }
  } finally {
    const closePromises = [source, stream].map((item) => (
      item.closed ? Promise.resolve() : new Promise((resolve) => item.once('close', resolve))
    ));
    source.unpipe(stream);
    stream.destroy();
    source.destroy();
    await Promise.all(closePromises);
  }

  if (current || paddingRemaining || buffer.length) throw new Error('tar归档被截断');
  if (!ended) throw new Error('tar归档缺少结束标记');
  return { files, manifestText, totalBytes };
}

function verifyManifest(files, manifestText) {
  if (!manifestText) throw new Error('备份缺少manifest.json');
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch (_) { throw new Error('备份清单不是合法JSON'); }
  if (manifest.formatVersion !== 1 || manifest.application !== 'mail-aggregator') {
    throw new Error('备份清单格式或应用标识不受支持');
  }
  if (!Array.isArray(manifest.files)) throw new Error('备份清单缺少文件校验列表');
  const expected = new Map();
  for (const item of manifest.files) {
    const itemPath = normalizeEntryPath(item && item.path);
    if (!itemPath.startsWith('data/')) throw new Error('备份清单包含非法文件路径');
    if (expected.has(itemPath)) throw new Error(`备份清单包含重复文件: ${itemPath}`);
    if (!Number.isSafeInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) {
      throw new Error(`备份清单中的文件信息不合法: ${itemPath}`);
    }
    expected.set(itemPath, item);
  }
  const actualDataFiles = [...files.values()].filter((item) => item.path.startsWith('data/'));
  if (actualDataFiles.length !== expected.size) throw new Error('备份文件数量与清单不一致');
  for (const actual of actualDataFiles) {
    const item = expected.get(actual.path);
    if (!item || item.size !== actual.size || item.sha256 !== actual.sha256) {
      throw new Error(`备份文件校验失败: ${actual.path}`);
    }
  }
  if (!files.has('data/db/mail-aggregator.db')) throw new Error('备份缺少SQLite数据库');
  return manifest;
}

async function verifyBackupArchive(archivePath, expectedArchiveSha256 = null) {
  const archiveSha256 = await hashFile(archivePath);
  if (expectedArchiveSha256 && archiveSha256 !== String(expectedArchiveSha256).toLowerCase()) {
    throw new Error('压缩包SHA-256与校验文件不一致');
  }
  const { files, manifestText, totalBytes } = await readTarInventory(archivePath);
  const manifest = verifyManifest(files, manifestText);
  return {
    ok: true,
    archiveSha256,
    fileCount: manifest.files.length,
    applicationVersion: manifest.applicationVersion,
    createdAt: manifest.createdAt,
    uncompressedBytes: totalBytes,
    databaseBytes: files.get('data/db/mail-aggregator.db').size,
  };
}

module.exports = {
  normalizeEntryPath,
  isAllowedPath,
  readTarInventory,
  verifyManifest,
  verifyBackupArchive,
};
