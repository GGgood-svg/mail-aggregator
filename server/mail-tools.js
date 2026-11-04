const { Transform } = require('node:stream');
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

function mailError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function searchCriteria(query) {
  const result = {};
  for (const key of ['from', 'subject']) {
    const value = query[key];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw mailError('搜索文字不合法或超过200个字符');
    if (value.trim()) result[key] = value.trim();
  }
  const dates = {};
  for (const key of ['since', 'until']) {
    const value = query[key];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw mailError('日期格式必须为 YYYY-MM-DD');
    const date = new Date(value + 'T00:00:00.000Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw mailError('搜索日期不合法');
    dates[key] = date;
  }
  if (dates.since && dates.until && dates.since > dates.until) throw mailError('开始日期不能晚于结束日期');
  if (dates.since) result.since = dates.since;
  if (dates.until) result.before = new Date(dates.until.getTime() + 86400000);
  if (query.seen !== undefined && !['', 'all', 'read', 'unread'].includes(query.seen)) throw mailError('已读筛选值不合法');
  if (query.seen === 'read' || query.seen === 'unread') result.seen = query.seen === 'read';
  return result;
}

function safeFilename(value, fallback = 'attachment') {
  let name = String(value || '').toWellFormed().normalize('NFC').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/g, '_');
  name = [...name].slice(0, 150).join('').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!name) name = fallback;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}

function attachmentParts(structure) {
  if (!structure) return [];
  const result = [], stack = [{ node: structure, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++visited > 2000 || depth > 50) throw mailError('邮件结构过于复杂', 413);
    const type = String(node.type || '').toLowerCase();
    const filename = node.dispositionParameters?.filename || node.parameters?.name;
    const disposition = String(node.disposition || '').toLowerCase();
    const isFile = disposition === 'attachment' || Boolean(filename) || (!type.startsWith('text/') && !type.startsWith('multipart/') && !node.childNodes?.length);
    if (isFile && !type.startsWith('multipart/')) {
      const part = String(node.part || (depth === 0 ? '1' : ''));
      if (/^[1-9]\d*(?:\.[1-9]\d*)*$/.test(part)) result.push({
        part, filename: safeFilename(filename, `attachment-${part}`), contentType: type || 'application/octet-stream',
        size: Number(node.size || 0), inline: disposition === 'inline',
      });
      continue; // A forwarded message is one attachment, not arbitrary inner parts.
    }
    for (const child of [...(node.childNodes || [])].reverse()) stack.push({ node: child, depth: depth + 1 });
  }
  return result;
}

function checkUidValidity(mailbox, expected, required = false) {
  if (required && (typeof expected !== 'string' || !/^[1-9]\d*$/.test(expected))) throw mailError('请刷新邮件后重试下载');
  const actual = String(mailbox?.uidValidity);
  if (expected !== undefined && expected !== actual) throw mailError('邮箱已重建，请刷新邮件列表', 409);
  return actual;
}

function downloadLimiter(maximum = MAX_DOWNLOAD_BYTES) {
  let size = 0;
  return new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > maximum) callback(mailError('下载超过100 MB上限', 413));
    else callback(null, chunk);
  } });
}

module.exports = { MAX_DOWNLOAD_BYTES, mailError, searchCriteria, safeFilename, attachmentParts, checkUidValidity, downloadLimiter };
