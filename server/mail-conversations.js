const { createHash } = require('node:crypto');
const MAX_REFERENCES_BYTES = 8192;
const MAX_TOKENS = 12;
// Resolve only well-formed bracketed IDs. In particular, similar subjects,
// bare phrases, and addresses in comments do not provide a thread identity.
const ID = /<([A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,140}@[A-Za-z0-9.-]{1,120})>/g;
function withoutComments(value) {
  let text = '', depth = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (depth && char === '\\') i++;
    else if (char === '(') { if (depth++ === 0) text += ' '; }
    else if (char === ')') { if (!depth) return ''; depth--; }
    else if (!depth) text += char;
  }
  return depth ? '' : text;
}
const ids = value => [...withoutComments(String(value || '').slice(0, MAX_REFERENCES_BYTES)).matchAll(ID)].map(item => {
  const split = item[1].lastIndexOf('@');
  return item[1].slice(0, split) + '@' + item[1].slice(split + 1).toLowerCase();
});

function conversationTokens(message, folder, roots, scope) {
  // Legacy unscoped mail may have no provable account root. Treat each of
  // those folders as isolated rather than accidentally grouping accounts.
  const root = (roots || []).filter(path => folder === path || folder.startsWith(`${path}.`) || folder.startsWith(`${path}/`))
    .reduce((longest, path) => !longest || path.length > longest.length ? path : longest, null);
  if (Buffer.isBuffer(message.headers) && message.headers.length > MAX_REFERENCES_BYTES) return [];
  const references = Buffer.isBuffer(message.headers) ? message.headers.toString('ascii').replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/).find(line => /^references:/i.test(line)) : null;
  const own = ids(message.envelope?.messageId).slice(0, 1);
  const parent = ids(message.envelope?.inReplyTo).slice(0, 1);
  const links = ids(references);
  const items = [...new Set([...own, ...parent, ...(links.length ? [links[0], ...links.slice(-9)] : [])])].slice(0, MAX_TOKENS);
  return items.map(id => createHash('sha256').update(JSON.stringify([scope, root ? 'account' : 'folder', root || folder, id])).digest('base64url'));
}

module.exports = { conversationTokens };
