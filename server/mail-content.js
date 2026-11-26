'use strict';
const sanitizeHtml = require('sanitize-html');
const { utf8Prefix, boundedAttachmentMetadata } = require('./mail-tools');
const MAX_RENDER_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_BYTES = 2 * 1024 * 1024;
const renderLimit = reason => Object.assign(new Error('Message preview budget exceeded'), { previewReason: reason });

const CSS_LENGTH = /^(?:auto|0|-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?)(?:\s+(?:auto|0|-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?)){0,3}$/i;
const CSS_COLOR = /^(?:transparent|#[0-9a-f]{3,8}|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%]+\)|[a-z]{1,24})$/i;
const CSS_BORDER = /^(?:none|0|(?:\d+(?:\.\d+)?(?:px|pt)?\s+)?(?:solid|dashed|dotted|double)\s+(?:#[0-9a-f]{3,8}|rgba?\([0-9.,\s%]+\)|[a-z]{1,24}))$/i;

function formatAddresses(addresses) {
  if (!Array.isArray(addresses)) return '';
  return addresses
    .map((item) => {
      const name = String(item && item.name || '').trim();
      const address = String(item && item.address || '').trim();
      if (name && address) return `${name} <${address}>`;
      return name || address;
    })
    .filter(Boolean)
    .join(', ');
}

function toIsoString(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}


function sanitizeMessageHtml(html, details = {}) {
  if (!html) return '';
  if (Buffer.byteLength(String(html)) > MAX_RENDER_BYTES) throw renderLimit('render_limit');
  let remoteImageCount = 0;
  let inlineBytes = 0;
  const cleaned = sanitizeHtml(String(html), {
    allowedTags: [
      'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's',
      'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'table', 'thead',
      'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
      'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'center', 'font',
    ],
    allowedAttributes: {
      '*': ['style', 'align', 'valign', 'dir', 'lang', 'width', 'height', 'title'],
      a: ['href', 'title', 'target', 'rel', 'style'],
      img: ['src', 'data-remote-src', 'alt', 'title', 'width', 'height', 'border', 'hspace', 'vspace', 'style'],
      table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'align', 'bgcolor', 'role', 'style'],
      td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'style'],
      th: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'style'],
      col: ['span', 'width', 'style'],
      font: ['face', 'size', 'color', 'style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    nonTextTags: ['style', 'script', 'textarea', 'option', 'xmp', 'noscript', 'template'],
    allowedStyles: {
      '*': {
        color: [CSS_COLOR],
        'background-color': [CSS_COLOR],
        'font-family': [/^[\w\s'",.-]{1,160}$/],
        'font-size': [CSS_LENGTH],
        'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/i],
        'font-style': [/^(?:normal|italic|oblique)$/i],
        'text-decoration': [/^(?:none|underline|line-through)(?:\s+(?:underline|line-through))?$/i],
        'text-align': [/^(?:left|right|center|justify|start|end)$/i],
        'line-height': [/^(?:normal|\d+(?:\.\d+)?(?:px|pt|em|rem|%)?)$/i],
        'letter-spacing': [CSS_LENGTH],
        width: [CSS_LENGTH], 'min-width': [CSS_LENGTH], 'max-width': [CSS_LENGTH],
        height: [CSS_LENGTH], 'min-height': [CSS_LENGTH], 'max-height': [CSS_LENGTH],
        margin: [CSS_LENGTH], 'margin-top': [CSS_LENGTH], 'margin-right': [CSS_LENGTH],
        'margin-bottom': [CSS_LENGTH], 'margin-left': [CSS_LENGTH],
        padding: [CSS_LENGTH], 'padding-top': [CSS_LENGTH], 'padding-right': [CSS_LENGTH],
        'padding-bottom': [CSS_LENGTH], 'padding-left': [CSS_LENGTH],
        border: [CSS_BORDER], 'border-top': [CSS_BORDER], 'border-right': [CSS_BORDER],
        'border-bottom': [CSS_BORDER], 'border-left': [CSS_BORDER],
        'border-collapse': [/^(?:collapse|separate)$/i],
        'border-spacing': [CSS_LENGTH],
        'vertical-align': [/^(?:baseline|top|middle|bottom|text-top|text-bottom|sub|super)$/i],
        'white-space': [/^(?:normal|nowrap|pre|pre-wrap|pre-line)$/i],
        'word-break': [/^(?:normal|break-all|keep-all|break-word)$/i],
        display: [/^(?:block|inline|inline-block|table|table-row|table-cell)$/i],
        float: [/^(?:none|left|right)$/i],
        overflow: [/^(?:visible|hidden|auto)$/i],
      },
    },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
      }),
      img: (tagName, attribs) => {
        let source = String(attribs.src || '').trim();
        if (/^cid:/i.test(source)) {
          const attachment = details.cidAttachments?.get(source.slice(4));
          if (attachment && /^image\/(?:png|jpe?g|gif|webp)$/i.test(attachment.contentType)) {
            const bytes = Math.ceil(attachment.content.length / 3) * 4 + attachment.contentType.length + 13;
            if (inlineBytes + bytes > MAX_INLINE_BYTES) throw renderLimit('inline_limit');
            source = `data:${attachment.contentType};base64,${attachment.content.toString('base64')}`;
          }
        }
        const safe = { ...attribs };
        delete safe.src;
        delete safe['data-remote-src'];
        if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(source)) {
          inlineBytes += Buffer.byteLength(source);
          if (inlineBytes > MAX_INLINE_BYTES) throw renderLimit('inline_limit');
          safe.src = source;
        } else if (/^https?:\/\//i.test(source) || /^\/\//.test(source)) {
          safe['data-remote-src'] = source.startsWith('//') ? `https:${source}` : source;
          remoteImageCount += 1;
        }
        return { tagName, attribs: safe };
      },
    },
  });
  details.remoteImageCount = remoteImageCount;
  return cleaned;
}

function serializeSummary(message) {
  const envelope = message.envelope || {};
  const flags = message.flags instanceof Set ? [...message.flags] : [];
  return {
    uid: message.uid,
    subject: utf8Prefix(envelope.subject, 4096) || '(无主题)',
    from: utf8Prefix(formatAddresses(envelope.from), 4096),
    to: utf8Prefix(formatAddresses(envelope.to), 4096),
    date: toIsoString(envelope.date || message.internalDate),
    size: Number(message.size || 0),
    seen: flags.includes('\\Seen'),
    flagged: flags.includes('\\Flagged'),
  };
}

function serializeParsedMessage(message, parsed) {
  const summary = serializeSummary(message);
  const htmlDetails = { cidAttachments: new Map((parsed.attachments || [])
    .filter(item => item.cid && Buffer.isBuffer(item.content)).map(item => [item.cid, item])) };
  let html = '', text = '', omittedReason;
  try {
    if (Buffer.byteLength(String(parsed.text || '')) + Buffer.byteLength(String(parsed.html || '')) > MAX_RENDER_BYTES) throw renderLimit('render_limit');
    html = sanitizeMessageHtml(parsed.html, htmlDetails);
    text = String(parsed.text || '').trim();
    if (Buffer.byteLength(html) + Buffer.byteLength(text) > MAX_RENDER_BYTES) throw renderLimit('render_limit');
  } catch (error) {
    if (!error.previewReason) throw error;
    html = ''; text = ''; omittedReason = error.previewReason;
  }
  const result = {
    ...summary,
    subject: utf8Prefix(parsed.subject, 4096) || summary.subject,
    from: parsed.from ? utf8Prefix(parsed.from.text, 4096) : summary.from,
    to: parsed.to ? utf8Prefix(parsed.to.text, 4096) : summary.to,
    cc: utf8Prefix(parsed.cc?.text, 4096),
    replyTo: utf8Prefix(parsed.replyTo?.text, 4096),
    date: parsed.date ? parsed.date.toISOString() : summary.date,
    text,
    html,
    remoteImageCount: Number(htmlDetails.remoteImageCount || 0),
    ...boundedAttachmentMetadata((parsed.attachments || []).map((attachment) => ({
      filename: attachment.filename || 'attachment',
      contentType: attachment.contentType || 'application/octet-stream',
      size: Number(attachment.size || 0),
      inline: Boolean(attachment.related || attachment.contentDisposition === 'inline'),
    }))),
  };
  if (omittedReason) Object.assign(result, { bodyOmitted: true, omittedReason, remoteImageCount: 0 });
  // Enforce the structured-clone payload budget in this worker, before posting.
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RENDER_BYTES) {
    omitBody(result);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RENDER_BYTES) throw renderLimit('render_limit');
  return result;
}

function omitBody(message) {
  Object.assign(message, { html: '', text: '', bodyOmitted: true, omittedReason: 'render_limit', remoteImageCount: 0 });
}

function encodeMailDetail(folder, message) {
  let payload = JSON.stringify({ folder, message });
  if (Buffer.byteLength(payload) > MAX_RENDER_BYTES) {
    omitBody(message);
    payload = JSON.stringify({ folder, message });
  }
  if (Buffer.byteLength(payload) > MAX_RENDER_BYTES) throw renderLimit('render_limit');
  return payload;
}

module.exports = { formatAddresses, toIsoString, sanitizeMessageHtml, serializeSummary, serializeParsedMessage,
  encodeMailDetail, MAX_RENDER_BYTES, MAX_INLINE_BYTES };
