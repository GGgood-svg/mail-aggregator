const net = require('node:net');

const RESERVED_SYSTEM_USERS = new Set(['root', 'daemon', 'bin', 'nobody']);

function parseIntegerInRange(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  let number;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[0-9]+$/.test(text)) return null;
    number = Number(text);
  } else if (typeof value === 'number') {
    number = value;
  } else {
    return null;
  }
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function normalizeHost(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isValidHost(value) {
  if (typeof value !== 'string') return false;
  const host = normalizeHost(value);
  if (!host || host.length > 253 || /[\s\u0000-\u001f\u007f]/.test(host)) return false;
  if (net.isIP(host)) return true;
  if (host.includes('://') || /[/\\@]/.test(host)) return false;

  const hostname = host.endsWith('.') ? host.slice(0, -1) : host;
  if (!hostname) return false;
  return hostname.split('.').every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
  );
}

function normalizeSystemUsername(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isValidSystemUsername(value) {
  const username = normalizeSystemUsername(value);
  return (
    /^[a-z_][a-z0-9_-]{0,31}$/.test(username) &&
    !RESERVED_SYSTEM_USERS.has(username)
  );
}

function isValidSecret(value) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 4096 &&
    !/[\r\n\0]/.test(value)
  );
}

module.exports = {
  parseIntegerInRange,
  normalizeHost,
  isValidHost,
  normalizeSystemUsername,
  isValidSystemUsername,
  isValidSecret,
};
