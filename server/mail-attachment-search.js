const { attachmentParts, mailError } = require('./mail-tools');
const FILTER_KEYS = Object.freeze(['attachment', 'attachmentName', 'attachmentType']);
const MAX_CANDIDATES = 20;
const MAX_DISPLAY_PARTS = 10;

function attachmentCriteria(input) {
  const presence = input.attachment === undefined ? 'all' : input.attachment;
  if (!['', 'all', 'present', 'absent'].includes(presence)) throw mailError('附件筛选值不合法');
  function value(key, length) {
    const raw = input[key];
    if (raw === undefined) return '';
    if (typeof raw !== 'string' || raw.length > length || /[\x00-\x1f\x7f]/.test(raw)) throw mailError('附件筛选值不合法');
    return raw.trim().normalize('NFC').toLowerCase();
  }
  const name = value('attachmentName', 100), type = value('attachmentType', 128);
  if ((type && !/^[a-z0-9][a-z0-9.+_-]*\/(?:\*|[a-z0-9][a-z0-9.+_-]*)$/.test(type)) || (presence === 'absent' && (name || type))) throw mailError('附件筛选值不合法');
  if (presence === 'absent') return { present: false, name, type };
  if (presence === 'present' || name || type) return { present: true, name, type };
  return null;
}

function attachmentMatch(message, filter) {
  if (!message.bodyStructure) throw mailError('无法读取附件结构，请稍后重试', 502);
  const files = attachmentParts(message.bodyStructure).filter(item => !item.inline);
  if (!filter.present) return files.length ? null : { matchingAttachments: [], matchingAttachmentsOmitted: 0 };
  const matches = files.filter(item => (!filter.name || item.filename.normalize('NFC').toLowerCase().includes(filter.name))
    && (!filter.type || (filter.type.endsWith('/*') ? item.contentType.startsWith(filter.type.slice(0, -1)) : item.contentType === filter.type)));
  const displayed = matches.slice(0, MAX_DISPLAY_PARTS);
  return matches.length ? { matchingAttachments: displayed, matchingAttachmentsOmitted: matches.length - displayed.length } : null;
}

module.exports = { FILTER_KEYS, MAX_CANDIDATES, attachmentCriteria, attachmentMatch };
