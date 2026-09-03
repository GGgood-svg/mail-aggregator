const { db } = require('./db');

const DEFAULTS = Object.freeze({
  dovecot_user: 'mailuser',
  dovecot_host: '127.0.0.1',
  dovecot_port: '143',
  web_port: '8080',
  web_language: 'zh-CN',
});

function get(key, fallback = DEFAULTS[key]) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value !== '' ? row.value : fallback;
}

function getPort(key, fallback = DEFAULTS[key]) {
  const value = Number.parseInt(get(key, fallback), 10);
  return Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : Number.parseInt(fallback, 10);
}

function localDovecot() {
  return {
    user: get('dovecot_user'),
    host: get('dovecot_host'),
    port: getPort('dovecot_port'),
  };
}

module.exports = { DEFAULTS, get, getPort, localDovecot };
