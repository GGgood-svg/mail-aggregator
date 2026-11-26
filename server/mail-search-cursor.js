const crypto = require('node:crypto');
const { mailError } = require('./mail-tools');

const TTL_MS = 15 * 60 * 1000;
const MAX_TOKEN_BYTES = 12288;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('base64url');

function searchScope(req, access) {
  const compare = values => [...new Set(values || [])].sort();
  return digest([req.user?.id, req.sessionID || null, req.session?.sessionVersion ?? req.user?.session_version ?? 0,
    !!access.all, !!access.allowUnscoped, compare(access.roots), compare(access.deniedRoots)]);
}

function createSearchCursors({ key = crypto.randomBytes(32), now = Date.now } = {}) {
  const sign = body => crypto.createHmac('sha256', key).update(body).digest();
  function invalid() {
    return Object.assign(mailError('搜索位置已失效，请重新搜索', 409), { code: 'SEARCH_CURSOR_INVALID' });
  }
  return {
    scope: searchScope,
    query: digest,
    invalid,
    issue(type, scope, query, position) {
      const data = { v: 1, type, scope, query, expires: now() + TTL_MS, position };
      const body = Buffer.from(JSON.stringify(data)).toString('base64url');
      return `${body}.${sign(body).toString('base64url')}`;
    },
    read(token, allowedTypes, scope, query) {
      if (typeof token !== 'string' || Buffer.byteLength(token) > MAX_TOKEN_BYTES || !/^[\w-]+\.[\w-]{43}$/.test(token)) throw invalid();
      const [body, encoded] = token.split('.');
      const signature = Buffer.from(encoded, 'base64url');
      if (signature.length !== 32 || signature.toString('base64url') !== encoded || !crypto.timingSafeEqual(signature, sign(body))) throw invalid();
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (data.v !== 1 || !allowedTypes.includes(data.type) || data.expires <= now() || data.scope !== scope || data.query !== query) throw invalid();
      return data;
    },
  };
}

module.exports = { createSearchCursors, TTL_MS };
