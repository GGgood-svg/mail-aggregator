'use strict';
const fs = require('node:fs');
const FILE = '/etc/mail-aggregator/config';
const KEYS = new Set(['DOVECOT_USER', 'DOVECOT_HOST', 'DOVECOT_PORT', 'WEB_PORT', 'WEB_LANGUAGE', 'PORT',
  'MAIL_AGG_BIND_HOST', 'MAIL_AGG_TRUST_PROXY', 'MAIL_AGG_COOKIE_SECURE', 'MAIL_AGG_REQUIRE_HTTPS',
  'MAIL_AGG_REQUIRED_MOUNTS', 'MAIL_AGG_MAIL_STORAGE_PATH']);

// The deployment file is data, not a privileged shell script. Quoted values,
// adjacent comments after whitespace and optional export are supported.
function parseWebConfig(text) {
  const values = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = /^\s*(?:export[ \t]+)?([A-Z_][A-Z0-9_]*)=(?:'([^'\r\n]*)'|"([^"\\$`\r\n]*)"|([A-Za-z0-9_./:+-]*))(?:[ \t]+(?:#.*)?|)$/.exec(line);
    if (!match || !KEYS.has(match[1]) || /[\x00-\x1F\x7F]/.test(match[2] ?? match[3] ?? match[4])) {
      throw new Error(`Invalid runtime configuration on line ${index + 1}`);
    }
    values[match[1]] = match[2] ?? match[3] ?? match[4];
  }
  return values;
}
function readWebConfig(filename = FILE) {
  let fd;
  try { fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || info.mode & 0o022 || info.size > 16384) throw new Error('Unsafe runtime configuration');
    const bytes = Buffer.alloc(16385);
    const count = fs.readSync(fd, bytes);
    if (count > 16384) throw new Error('Runtime configuration exceeds 16 KiB');
    return parseWebConfig(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
  } finally { fs.closeSync(fd); }
}
function shellExports(values) {
  return Object.entries(values).map(([key, value]) => `export ${key}='${value.replace(/'/g, "'\"'\"'")}'`).join('\n');
}
if (require.main === module) {
  try { console.log(shellExports(readWebConfig())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parseWebConfig, readWebConfig, shellExports };
