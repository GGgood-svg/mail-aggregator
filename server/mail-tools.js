const { Transform } = require('node:stream');
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENT_METADATA_BYTES = 512 * 1024;
const SEARCH_FILTER_KEYS = Object.freeze(['from', 'to', 'subject', 'body', 'since', 'until', 'seen', 'flagged', 'largerMb', 'smallerMb']);

function mailError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function searchCriteria(query) {
  const result = {};
  for (const key of ['from', 'to', 'subject', 'body']) {
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
  if (query.flagged !== undefined && !['', 'all', 'starred', 'unstarred'].includes(query.flagged)) throw mailError('星标筛选值不合法');
  if (query.flagged === 'starred' || query.flagged === 'unstarred') result.flagged = query.flagged === 'starred';
  const sizes = {};
  for (const [input, output] of [['largerMb', 'larger'], ['smallerMb', 'smaller']]) {
    const value = query[input];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !/^[1-9]\d{0,3}$/.test(value) || Number(value) > 4095) throw mailError('邮件大小必须是 1 至 4095 MB 的整数');
    sizes[output] = Number(value) * 1024 * 1024;
  }
  if (sizes.larger !== undefined && sizes.smaller !== undefined && sizes.larger >= sizes.smaller) {
    throw mailError('大小下限必须小于上限');
  }
  Object.assign(result, sizes);
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
  const result = [], stack = [{ node: structure, depth: 0, related: false }];
  let visited = 0;
  while (stack.length) {
    const { node, depth, related } = stack.pop();
    if (++visited > 2000 || depth > 50) throw mailError('邮件结构过于复杂', 413);
    const type = String(node.type || '').toLowerCase();
    const filename = node.dispositionParameters?.filename || node.parameters?.name;
    const disposition = String(node.disposition || '').toLowerCase();
    const isFile = disposition === 'attachment' || Boolean(filename) || (!type.startsWith('text/') && !type.startsWith('multipart/') && !node.childNodes?.length);
    if (isFile && !type.startsWith('multipart/')) {
      const part = String(node.part || (depth === 0 ? '1' : ''));
      if (part.length <= 256 && /^[1-9]\d*(?:\.[1-9]\d*)*$/.test(part)) result.push({
        part, filename: safeFilename(filename, `attachment-${part}`), contentType: utf8Prefix(type, 128) || 'application/octet-stream',
        size: Number(node.size || 0), inline: disposition !== 'attachment' && (disposition === 'inline' || (related && Boolean(node.id))),
      });
      continue; // A forwarded message is one attachment, not arbitrary inner parts.
    }
    for (const child of [...(node.childNodes || [])].reverse()) stack.push({ node: child, depth: depth + 1, related: related || type === 'multipart/related' });
  }
  return result;
}

function utf8Prefix(value, maximum) {
  const bytes = Buffer.from(String(value || '').slice(0, maximum));
  if (bytes.length <= maximum) return bytes.toString('utf8');
  let end = maximum;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function boundedAttachmentMetadata(items) {
  const attachments = [];
  let bytes = 2; // The JSON array's brackets and separators count as well.
  for (const item of items || []) {
    if (attachments.length === 2000) break;
    const filename = utf8Prefix(item.filename, 384) || 'attachment';
    const contentType = utf8Prefix(item.contentType, 128) || 'application/octet-stream';
    const value = { filename, contentType, size: Number(item.size || 0), inline: Boolean(item.inline) };
    if (typeof item.part === 'string' && item.part.length <= 256) value.part = item.part;
    const cost = Buffer.byteLength(JSON.stringify(value)) + (attachments.length > 0 ? 1 : 0);
    if (bytes + cost > MAX_ATTACHMENT_METADATA_BYTES) break;
    bytes += cost;
    attachments.push(value);
  }
  return { attachments, attachmentsOmittedCount: (items?.length || 0) - attachments.length };
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

module.exports = { MAX_DOWNLOAD_BYTES, MAX_ATTACHMENT_METADATA_BYTES, SEARCH_FILTER_KEYS, mailError, searchCriteria,
  safeFilename, attachmentParts, checkUidValidity, downloadLimiter, utf8Prefix, boundedAttachmentMetadata };
