const express = require('express');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 50;
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

const CSS_LENGTH = /^(?:auto|0|-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?)(?:\s+(?:auto|0|-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?)){0,3}$/i;
const CSS_COLOR = /^(?:transparent|#[0-9a-f]{3,8}|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%]+\)|[a-z]{1,24})$/i;
const CSS_BORDER = /^(?:none|0|(?:\d+(?:\.\d+)?(?:px|pt)?\s+)?(?:solid|dashed|dotted|double)\s+(?:#[0-9a-f]{3,8}|rgba?\([0-9.,\s%]+\)|[a-z]{1,24}))$/i;

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = String(value ?? '');
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function validateMailboxPath(value) {
  const path = String(value || 'INBOX');
  if (!path || path.length > 512 || /[\r\n\0]/.test(path)) {
    const error = new Error('邮箱文件夹名称不合法');
    error.statusCode = 400;
    throw error;
  }
  return path;
}

function calculateSequenceRange(total, page, pageSize) {
  if (!Number.isInteger(total) || total <= 0) return null;
  const end = total - (page - 1) * pageSize;
  if (end < 1) return null;
  const start = Math.max(1, end - pageSize + 1);
  return `${start}:${end}`;
}

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

function imapTransportOptions(local) {
  const host = String(local && local.host || '').trim().toLowerCase();
  const port = Number(local && local.port);
  if (port === 993) return { secure: true };
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  return {
    secure: false,
    // The standard local Dovecot install advertises STARTTLS with a self-signed
    // certificate. Loopback traffic never leaves the host, so keep it plain.
    // A non-loopback server must successfully upgrade instead of leaking auth.
    doSTARTTLS: loopback ? false : true,
  };
}

function sanitizeMessageHtml(html, details = {}) {
  if (!html) return '';
  let remoteImageCount = 0;
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
        const source = String(attribs.src || '').trim();
        const safe = { ...attribs };
        delete safe.src;
        delete safe['data-remote-src'];
        if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(source)) {
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
    subject: envelope.subject || '(无主题)',
    from: formatAddresses(envelope.from),
    to: formatAddresses(envelope.to),
    date: toIsoString(envelope.date || message.internalDate),
    size: Number(message.size || 0),
    seen: flags.includes('\\Seen'),
    flagged: flags.includes('\\Flagged'),
  };
}

function serializeParsedMessage(message, parsed) {
  const summary = serializeSummary(message);
  const htmlDetails = {};
  const html = sanitizeMessageHtml(parsed.html, htmlDetails);
  return {
    ...summary,
    subject: parsed.subject || summary.subject,
    from: parsed.from ? parsed.from.text : summary.from,
    to: parsed.to ? parsed.to.text : summary.to,
    cc: parsed.cc ? parsed.cc.text : '',
    replyTo: parsed.replyTo ? parsed.replyTo.text : '',
    date: parsed.date ? parsed.date.toISOString() : summary.date,
    text: String(parsed.text || '').trim(),
    html,
    remoteImageCount: Number(htmlDetails.remoteImageCount || 0),
    attachments: (parsed.attachments || []).map((attachment) => ({
      filename: attachment.filename || 'attachment',
      contentType: attachment.contentType || 'application/octet-stream',
      size: Number(attachment.size || 0),
      inline: Boolean(attachment.related || attachment.contentDisposition === 'inline'),
    })),
  };
}

function createClient() {
  // 延迟加载数据库相关模块，让纯解析/安全函数可以在没有 SQLite 原生绑定的
  // 开发机上独立测试；生产请求第一次读取邮箱时才需要数据库。
  const { localDovecot } = require('./config');
  const { readGlobalLocalSecret } = require('./credentials');
  const local = localDovecot();
  const password = readGlobalLocalSecret();
  if (!password) {
    const error = new Error('本地邮箱密码尚未配置，请先到设置页面配置 Dovecot 密码');
    error.statusCode = 503;
    throw error;
  }
  const client = new ImapFlow({
    host: local.host,
    port: local.port,
    ...imapTransportOptions(local),
    auth: { user: local.user, pass: password },
    logger: false,
    disableAutoIdle: true,
    socketTimeout: 30_000,
  });
  // ImapFlow may emit asynchronous connection errors after connect() has resolved.
  // Always install a listener so a broken local socket can never crash the Web process.
  client.on('error', () => {});
  return client;
}

async function withClient(work, dependencies = {}) {
  const client = dependencies.createClient ? dependencies.createClient() : createClient();
  try {
    await client.connect();
    return await work(client);
  } finally {
    if (client && client.usable !== false) {
      try { await client.logout(); } catch (_) { try { client.close(); } catch (_) {} }
    }
  }
}

function publicMailError(error) {
  if (error && error.statusCode) return error;
  const wrapped = new Error('读取本地邮箱失败，请确认 Dovecot 正常运行后重试');
  wrapped.statusCode = 502;
  return wrapped;
}

function mailAccessForRequest(req, dependencies = {}) {
  if (dependencies.mailAccessForRequest) return dependencies.mailAccessForRequest(req);
  // Pure router tests mount this module without the application's auth middleware.
  if (!req.user) return { all: true, roots: [] };
  if (req.user.mail_access_all) return { all: true, roots: [] };
  const { db } = require('./db');
  const rows = db.prepare(`SELECT COALESCE(mailbox_folder,destination_folder) AS mailbox_folder FROM accounts
    WHERE owner_user_id=? AND destination_mode='subfolder' AND destination_folder IS NOT NULL`).all(req.user.id);
  return { all: false, roots: rows.map((row) => row.mailbox_folder) };
}

function folderAllowed(folder, access) {
  if (access.all) return true;
  return access.roots.some((root) => folder === root || folder.startsWith(`${root}.`) || folder.startsWith(`${root}/`));
}

function requireFolderAccess(folder, access) {
  if (folderAllowed(folder, access)) return;
  const error = new Error('文件夹不存在或不属于当前用户');
  error.statusCode = 404;
  throw error;
}

function createMailRouter(dependencies = {}) {
  const router = express.Router();

  router.put('/seen-all', async (req, res) => {
    try {
      const access = mailAccessForRequest(req, dependencies);
      const input = req.body?.folders;
      if (!Array.isArray(input) || !input.length || input.length > 500 ||
          input.some((path) => typeof path !== 'string' || !path.trim())) {
        return res.status(400).json({ error: 'Invalid folder list' });
      }
      const folders = [...new Set(input.map(validateMailboxPath))];
      folders.forEach((folder) => requireFolderAccess(folder, access));
      const results = await withClient(async (client) => {
        const available = new Set((await client.list()).filter((entry) => !entry.flags?.has('\\Noselect')).map((entry) => entry.path));
        if (folders.some((folder) => !available.has(folder))) {
          const error = new Error('文件夹不存在，请刷新后重试'); error.statusCode = 400; throw error;
        }
        const results = [];
        for (const folder of folders) {
          try {
            await client.mailboxOpen(folder, { readOnly: false });
            const uids = await client.search({ seen: false }, { uid: true });
            let updated = 0;
            for (let offset = 0; offset < uids.length; offset += 500) {
              const batch = uids.slice(offset, offset + 500);
              if (!await client.messageFlagsAdd(batch, ['\\Seen'], { uid: true })) throw new Error('Flag update failed');
              updated += batch.length;
            }
            results.push({ folder, ok: true, updated });
          } catch (_) { results.push({ folder, ok: false }); }
        }
        return results;
      }, dependencies);
      res.json({ results });
    } catch (error) {
      const safe = publicMailError(error);
      res.status(safe.statusCode).json({ error: safe.message });
    }
  });

  router.put('/messages/:uid/seen', async (req, res) => {
    try {
      const folder = validateMailboxPath(req.query.folder);
      requireFolderAccess(folder, mailAccessForRequest(req, dependencies));
      const uid = parsePositiveInteger(req.params.uid, null);
      if (!uid || typeof req.body?.seen !== 'boolean') {
        return res.status(400).json({ error: 'Invalid UID or seen state' });
      }
      const seen = await withClient(async (client) => {
        await client.mailboxOpen(folder, { readOnly: false });
        const message = await client.fetchOne(uid, { flags: true }, { uid: true });
        if (!message) { const error = new Error('邮件不存在或已被移除'); error.statusCode = 404; throw error; }
        const method = req.body.seen ? 'messageFlagsAdd' : 'messageFlagsRemove';
        await client[method](uid, ['\\Seen'], { uid: true });
        const updated = await client.fetchOne(uid, { flags: true }, { uid: true });
        if (!updated || updated.flags.has('\\Seen') !== req.body.seen) throw new Error('Flag update failed');
        return updated.flags.has('\\Seen');
      }, dependencies);
      res.json({ folder, uid, seen });
    } catch (error) {
      const safe = publicMailError(error);
      res.status(safe.statusCode).json({ error: safe.message });
    }
  });

  router.get('/folders', async (req, res) => {
    try {
      const access = mailAccessForRequest(req, dependencies);
      const folders = await withClient(async (client) => {
        const entries = await client.list({ statusQuery: { messages: true, unseen: true } });
        return entries
          .filter((entry) => !(entry.flags instanceof Set && entry.flags.has('\\Noselect')))
          .filter((entry) => folderAllowed(entry.path, access))
          .map((entry) => ({
            path: entry.path,
            name: entry.name || entry.path,
            delimiter: entry.delimiter || '/',
            specialUse: entry.specialUse || null,
            messages: Number(entry.status && entry.status.messages || 0),
            unseen: Number(entry.status && entry.status.unseen || 0),
          }))
          .sort((a, b) => {
            if (a.path.toUpperCase() === 'INBOX') return -1;
            if (b.path.toUpperCase() === 'INBOX') return 1;
            return a.path.localeCompare(b.path);
          });
      }, dependencies);
      res.json({ folders });
    } catch (error) {
      const safe = publicMailError(error);
      res.status(safe.statusCode).json({ error: safe.message });
    }
  });

  router.get('/messages', async (req, res) => {
    try {
      const folder = validateMailboxPath(req.query.folder);
      requireFolderAccess(folder, mailAccessForRequest(req, dependencies));
      const page = parsePositiveInteger(req.query.page, 1);
      const pageSize = parsePositiveInteger(req.query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const result = await withClient(async (client) => {
        const mailbox = await client.mailboxOpen(folder, { readOnly: true });
        const total = Number(mailbox.exists || 0);
        const range = calculateSequenceRange(total, page, pageSize);
        const messages = range
          ? await client.fetchAll(range, {
              uid: true,
              envelope: true,
              flags: true,
              internalDate: true,
              size: true,
            })
          : [];
        return {
          folder,
          page,
          pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
          messages: messages.reverse().map(serializeSummary),
        };
      }, dependencies);
      res.json(result);
    } catch (error) {
      const safe = publicMailError(error);
      res.status(safe.statusCode).json({ error: safe.message });
    }
  });

  router.get('/messages/:uid', async (req, res) => {
    try {
      const folder = validateMailboxPath(req.query.folder);
      requireFolderAccess(folder, mailAccessForRequest(req, dependencies));
      const uid = parsePositiveInteger(req.params.uid, null);
      if (!uid) {
        const error = new Error('邮件编号不合法');
        error.statusCode = 400;
        throw error;
      }
      const result = await withClient(async (client) => {
        await client.mailboxOpen(folder, { readOnly: true });
        const metadata = await client.fetchOne(uid, {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
        }, { uid: true });
        if (!metadata) {
          const error = new Error('邮件不存在或已被移除');
          error.statusCode = 404;
          throw error;
        }
        if (Number(metadata.size || 0) > MAX_MESSAGE_BYTES) {
          const error = new Error('这封邮件超过 10 MB，第一阶段暂不在网页中展开');
          error.statusCode = 413;
          throw error;
        }
        const full = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!full || !full.source) {
          const error = new Error('邮件正文不可用');
          error.statusCode = 404;
          throw error;
        }
        const parsed = await simpleParser(full.source, {
          maxHtmlLengthToParse: MAX_MESSAGE_BYTES,
        });
        return serializeParsedMessage(metadata, parsed);
      }, dependencies);
      res.json({ folder, message: result });
    } catch (error) {
      const safe = publicMailError(error);
      res.status(safe.statusCode).json({ error: safe.message });
    }
  });

  return router;
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_MESSAGE_BYTES,
  parsePositiveInteger,
  validateMailboxPath,
  calculateSequenceRange,
  formatAddresses,
  toIsoString,
  imapTransportOptions,
  sanitizeMessageHtml,
  serializeSummary,
  serializeParsedMessage,
  folderAllowed,
  createMailRouter,
};
