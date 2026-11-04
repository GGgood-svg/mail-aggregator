const express = require('express');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');
const { pipeline } = require('node:stream/promises');
const { MAX_DOWNLOAD_BYTES, mailError, searchCriteria, safeFilename, attachmentParts, checkUidValidity, downloadLimiter } = require('./mail-tools');

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

const { imapTransportOptions } = require('./target-transport');

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
  // Fail closed even if a future route is accidentally mounted without the
  // application's authentication middleware.
  if (!req.user) return { all: false, roots: [], allowUnscoped: false, deniedRoots: [] };
  const { db } = require('./db');
  const { localDovecot } = require('./config');
  // 永久归属表是权威来源，同时合并仍在 accounts 中的活动目录，兼容测试夹具、
  // 升级中的短暂状态以及第三方导入代码。
  const rows = db.prepare(`SELECT owner_user_id, mailbox_folder
      FROM mailbox_ownership WHERE local_user=?
    UNION
    SELECT owner_user_id, COALESCE(mailbox_folder,destination_folder) AS mailbox_folder
      FROM accounts WHERE local_user=? AND destination_mode='subfolder'
        AND owner_user_id IS NOT NULL
        AND COALESCE(mailbox_folder,destination_folder) IS NOT NULL`)
    .all(localDovecot().user, localDovecot().user);
  const ownRoots = rows
    .filter((row) => Number(row.owner_user_id) === Number(req.user.id))
    .map((row) => row.mailbox_folder);

  // The first account keeps access to unscoped folders created by old flat-mode
  // installations.  This is deliberately not administrator access to every
  // mailbox: another user's isolated root always wins and is denied first.
  if (req.user.mail_access_all) {
    return {
      all: false,
      roots: ownRoots,
      allowUnscoped: true,
      deniedRoots: rows
        .filter((row) => Number(row.owner_user_id) !== Number(req.user.id))
        .map((row) => row.mailbox_folder),
    };
  }
  return { all: false, roots: ownRoots, allowUnscoped: false, deniedRoots: [] };
}

function folderWithinRoot(folder, root) {
  return folder === root || folder.startsWith(`${root}.`) || folder.startsWith(`${root}/`);
}

function folderAllowed(folder, access) {
  if (access.all) return true;
  if ((access.deniedRoots || []).some((root) => folderWithinRoot(folder, root))) return false;
  if ((access.roots || []).some((root) => folderWithinRoot(folder, root))) return true;
  // 防御旧版本留下、尚未登记进 mailbox_ownership 的孤立目录。生成式隔离根
  // 永远不能落入首位管理员的旧版“未归属目录兼容”权限。
  if (/^U\d+-A\d+(?:[./]|$)/i.test(String(folder || ''))) return false;
  return Boolean(access.allowUnscoped);
}

function requireFolderAccess(folder, access) {
  if (folderAllowed(folder, access)) return;
  const error = new Error('文件夹不存在或不属于当前用户');
  error.statusCode = 404;
  throw error;
}

function createMailRouter(dependencies = {}) {
  const router = express.Router();
  const downloads = new Map();
  let activeDownloads = 0;

  async function downloadMessage(req, res, attachment) {
    const owner = req.user?.id ?? req.sessionID ?? 'local';
    let reserved = false;
    try {
      const folder = validateMailboxPath(req.query.folder);
      requireFolderAccess(folder, mailAccessForRequest(req, dependencies));
      const uid = Number(req.params.uid);
      if (!/^[1-9]\d*$/.test(req.params.uid) || !Number.isSafeInteger(uid) || uid > 4294967295) throw mailError('邮件编号不合法');
      if (attachment && !/^[1-9]\d*(?:\.[1-9]\d*)*$/.test(req.params.part)) throw mailError('附件编号不合法');
      if (activeDownloads >= 4 || (downloads.get(owner) || 0) >= 2) throw mailError('下载任务较多，请稍后重试', 429);
      activeDownloads++; downloads.set(owner, (downloads.get(owner) || 0) + 1); reserved = true;
      await withClient(async (client) => {
        let content;
        const cancel = () => { if (!res.writableFinished) { content?.destroy(); client.close(); } };
        res.once('close', cancel);
        const timeout = setTimeout(() => { content?.destroy(mailError('下载超时', 504)); client.close(); }, 120000);
        timeout.unref();
        try {
          const mailbox = await client.mailboxOpen(folder, { readOnly: true });
          checkUidValidity(mailbox, req.query.uidValidity, true);
          const metadata = await client.fetchOne(uid, { uid: true, size: true, envelope: true, bodyStructure: true }, { uid: true });
          if (!metadata) throw mailError('邮件不存在或已被移除', 404);
          const file = attachment ? attachmentParts(metadata.bodyStructure).find(item => item.part === req.params.part) : null;
          if (attachment && !file) throw mailError('附件不存在', 404);
          if (Number(attachment ? file.size : metadata.size) > MAX_DOWNLOAD_BYTES) throw mailError('下载超过100 MB上限', 413);
          const download = await client.download(uid, attachment ? file.part : undefined, { uid: true, maxBytes: MAX_DOWNLOAD_BYTES + 1 });
          if (!download?.content) throw mailError('下载内容不可用', 404);
          content = download.content;
          if (res.destroyed) { content.destroy(); return; }
          const filename = attachment ? file.filename : `${safeFilename(metadata.envelope?.subject, 'message')}-${uid}.eml`;
          res.attachment(filename);
          res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" });
          await pipeline(content, downloadLimiter(), res);
        } finally { clearTimeout(timeout); res.removeListener('close', cancel); }
      }, dependencies);
    } catch (error) {
      if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(error); }
      else { const safe = publicMailError(error); res.status(safe.statusCode).json({ error: safe.message }); }
    } finally {
      if (reserved) {
        activeDownloads--;
        const remaining = downloads.get(owner) - 1;
        if (remaining) downloads.set(owner, remaining); else downloads.delete(owner);
      }
    }
  }

  router.get('/messages/:uid/export', (req, res) => downloadMessage(req, res, false));
  router.get('/messages/:uid/attachments/:part/download', (req, res) => downloadMessage(req, res, true));

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
        const mailbox = await client.mailboxOpen(folder, { readOnly: false });
        checkUidValidity(mailbox, req.query.uidValidity);
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
      const beforeUid = req.query.beforeUid === undefined ? null : parsePositiveInteger(req.query.beforeUid, null, 4294967295);
      if (req.query.beforeUid !== undefined && beforeUid === null) return res.status(400).json({ error: '分页游标不合法' });
      if (page > 1 && !beforeUid) return res.status(400).json({ error: '请刷新页面以使用稳定的邮件分页' });
      const criteria = searchCriteria(req.query);
      const result = await withClient(async (client) => {
        const mailbox = await client.mailboxOpen(folder, { readOnly: true });
        const uidValidity = String(mailbox.uidValidity);
        if (req.query.uidValidity !== undefined && req.query.uidValidity !== uidValidity) {
          throw Object.assign(new Error('邮箱已重建，请刷新邮件列表'), { statusCode: 409 });
        }
        const uids = await client.search({ ...criteria, uid: '1:*' }, { uid: true });
        const total = (uids || []).length;
        const selected = (uids || []).filter((uid) => !beforeUid || uid < beforeUid).sort((a, b) => b - a);
        const range = selected.slice(0, pageSize);
        const messages = range.length
          ? await client.fetchAll(range, {
              uid: true,
              envelope: true,
              flags: true,
              internalDate: true,
              size: true,
            }, { uid: true })
          : [];
        return {
          folder,
          page,
          pageSize,
          total,
          mailboxTotal: Number(mailbox.exists || 0),
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
          uidValidity,
          hasMore: selected.length > pageSize,
          nextBeforeUid: range.length ? range[range.length - 1] : null,
          messages: messages.sort((a, b) => b.uid - a.uid).map(serializeSummary),
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
        const mailbox = await client.mailboxOpen(folder, { readOnly: true });
        const uidValidity = checkUidValidity(mailbox, req.query.uidValidity);
        const metadata = await client.fetchOne(uid, {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
          bodyStructure: true,
        }, { uid: true });
        if (!metadata) {
          const error = new Error('邮件不存在或已被移除');
          error.statusCode = 404;
          throw error;
        }
        if (Number(metadata.size || 0) > MAX_MESSAGE_BYTES) {
          return { ...serializeSummary(metadata), uidValidity, bodyOmitted: true, text: '', html: '', attachments: attachmentParts(metadata.bodyStructure), remoteImageCount: 0 };
        }
        const full = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!full || !full.source) {
          const error = new Error('邮件正文不可用');
          error.statusCode = 404;
          throw error;
        }
        const sourceBytes = Buffer.isBuffer(full.source)
          ? full.source.length
          : Buffer.byteLength(String(full.source));
        if (sourceBytes > MAX_MESSAGE_BYTES) {
          const error = new Error('这封邮件超过 10 MB，第一阶段暂不在网页中展开');
          error.statusCode = 413;
          throw error;
        }
        const parsed = await simpleParser(full.source, {
          maxHtmlLengthToParse: MAX_MESSAGE_BYTES,
        });
        const result = serializeParsedMessage(metadata, parsed);
        result.uidValidity = uidValidity;
        if (metadata.bodyStructure) result.attachments = attachmentParts(metadata.bodyStructure);
        return result;
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
  mailAccessForRequest,
  folderAllowed,
  createMailRouter,
};
