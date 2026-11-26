const express = require('express');
const { ImapFlow } = require('imapflow');
const { formatAddresses, toIsoString, sanitizeMessageHtml, serializeSummary, serializeParsedMessage, encodeMailDetail } = require('./mail-content');
const { mailParser } = require('./mail-parser-pool');
const { imapTransportOptions } = require('./target-transport');
const { pipeline } = require('node:stream/promises');
const { MAX_DOWNLOAD_BYTES, SEARCH_FILTER_KEYS, mailError, searchCriteria, safeFilename, attachmentParts,
  boundedAttachmentMetadata, checkUidValidity, downloadLimiter } = require('./mail-tools');
const { registerSavedSearchRoutes } = require('./saved-searches');
const { createSeenJobManager } = require('./mail-seen-jobs');
const { createMailTaskService } = require('./mail-tasks');
const { track } = require('./update-activity');
const { registerRuleRoutes } = require('./mail-rules');
const { newestUids, scanNewestUids, highUid, matchingCount, MAX_UID, SEARCH_BUDGET } = require('./mail-search-uids');
const { FILTER_KEYS: ATTACHMENT_FILTERS, MAX_CANDIDATES, attachmentCriteria, attachmentMatch } = require('./mail-attachment-search');
const { registerMailLabelRoutes, labelAccount, ownedLabel, matchingLabels } = require('./mail-labels');
const { conversationTokens } = require('./mail-conversations');
const { createSearchCursors } = require('./mail-search-cursor');

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 50;
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_MAIL_CLIENTS = 8;
const MAX_MAIL_CLIENTS_PER_USER = 3;
const MAIL_REQUEST_TIMEOUT_MS = 45_000;
const UNREAD_FOLDERS_PER_PAGE = 10;
const UNREAD_PREVIEW_SIZE = 5;
const SEARCH_FOLDERS_PER_PAGE = 8;
const SEARCH_PREVIEW_SIZE = 5;
const SEARCH_FOLDER_TIMEOUT_MS = 12_000;
const MAIL_CLIENT_COUNTS = new Map();
let activeMailClients = 0;

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
    maxLineLength: 2 * 1024 * 1024,
    maxLiteralSize: 12 * 1024 * 1024,
    maxResponseSize: 16 * 1024 * 1024,
  });
  // ImapFlow may emit asynchronous connection errors after connect() has resolved.
  // Always install a listener so a broken local socket can never crash the Web process.
  client.on('error', () => {});
  return client;
}

async function withClient(work, dependencies = {}, req = {}, timeoutMs = MAIL_REQUEST_TIMEOUT_MS, authorize = null) {
  const owner = String(req.user?.id ?? req.sessionID ?? 'anonymous');
  const ownerCount = MAIL_CLIENT_COUNTS.get(owner) || 0;
  if (activeMailClients >= MAX_MAIL_CLIENTS || ownerCount >= MAX_MAIL_CLIENTS_PER_USER) {
    throw mailError('邮箱请求较多，请稍后重试', 429);
  }
  activeMailClients += 1;
  MAIL_CLIENT_COUNTS.set(owner, ownerCount + 1);
  let client;
  let timer;
  let timedOut = false;
  let disconnected = false;
  let onClose;
  let onAbort;
  const response = req.res;
  let result;
  try {
    authorize?.();
    if (req.signal?.aborted || (response?.destroyed && !response.writableFinished)) throw mailError('请求已取消', 499);
    client = dependencies.createClient ? dependencies.createClient() : createClient();
    const disconnectedRequest = new Promise((_, reject) => {
      onAbort = () => {
        disconnected = true;
        reject(mailError('请求已取消', 499));
        try { client?.close(); } catch (_) {}
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      if (req.signal?.aborted) onAbort();
      if (response && typeof response.once === 'function') {
        onClose = () => { if (!response.writableFinished) onAbort(); };
        response.once('close', onClose);
        if (response.destroyed) onClose();
      }
    });
    const operation = Promise.resolve().then(async () => {
      if (disconnected) { try { client.close(); } catch (_) {} throw mailError('请求已取消', 499); }
      await client.connect();
      if (timedOut || disconnected) {
        try { client.close(); } catch (_) {}
        throw mailError(disconnected ? '请求已取消' : '邮箱请求超时，请稍后重试', disconnected ? 499 : 504);
      }
      const ensureActive = () => {
        if (timedOut || disconnected || req.signal?.aborted) throw mailError(disconnected || req.signal?.aborted ? '请求已取消' : '邮箱请求超时，请稍后重试', disconnected || req.signal?.aborted ? 499 : 504);
        authorize?.();
      };
      ensureActive();
      return work(client, ensureActive);
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(mailError('邮箱请求超时，请稍后重试', 504));
        try { client.close(); } catch (_) {}
      }, timeoutMs);
      timer.unref?.();
    });
    result = await Promise.race([operation, timeout, disconnectedRequest]);
  } finally {
    clearTimeout(timer);
    if (onClose) response.removeListener('close', onClose);
    if (onAbort) req.signal?.removeEventListener('abort', onAbort);
    if (client && !timedOut && !disconnected && client.usable !== false) {
      let logoutTimer;
      try {
        await Promise.race([
          client.logout(),
          new Promise((resolve) => { logoutTimer = setTimeout(() => { try { client.close(); } catch (_) {} resolve(); }, 2_000); logoutTimer.unref?.(); }),
        ]);
      } catch (_) { try { client.close(); } catch (_) {} }
      finally { clearTimeout(logoutTimer); }
    }
    activeMailClients -= 1;
    const remaining = (MAIL_CLIENT_COUNTS.get(owner) || 1) - 1;
    if (remaining > 0) MAIL_CLIENT_COUNTS.set(owner, remaining);
    else MAIL_CLIENT_COUNTS.delete(owner);
  }
  authorize?.();
  return result;
}

function publicMailError(error) {
  if (error && error.statusCode) return error;
  const wrapped = new Error('读取本地邮箱失败，请确认 Dovecot 正常运行后重试');
  wrapped.statusCode = 502;
  return wrapped;
}

function searchFailure(error) {
  return [SEARCH_BUDGET, 'SEARCH_CURSOR_INVALID'].includes(error?.code) ? { code: error.code, error: error.message } : {};
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

function currentSearchAccess(req, dependencies) {
  if (dependencies.mailAccessForRequest) return mailAccessForRequest(req, dependencies);
  const expected = Number(req.user?.id);
  const user = require('./auth').assertCurrentUser(req);
  if (Number(user.id) !== expected) throw mailError('未登录', 401);
  return mailAccessForRequest({ ...req, user }, dependencies);
}

function createMailRouter(dependencies = {}) {
  const internalPreview = Symbol('internalAutomaticPreview');
  const autoPreviews = require('./mail-auto-preview');
  const localUser = () => dependencies.labelLocalUser || require('./config').localDovecot().user;
  function currentAccess(req, folder) {
    const source = req[internalPreview];
    if (!source) return currentSearchAccess(req, dependencies);
    const root = autoPreviews.automaticScope(getTaskDb(), source, localUser(), folder);
    return { all: false, roots: [root], allowUnscoped: false, deniedRoots: [] };
  }
  const router = express.Router();
  const cursors = createSearchCursors(dependencies.searchCursors);
  function scopedSearch(req, criteria, attachment, conversations, label) {
    const access = () => currentAccess(req);
    const scope = cursors.scope(req, access());
    const query = cursors.query(label ? [criteria, attachment, !!conversations, 'label', label.id]
      : conversations ? [criteria, attachment, 'conversations'] : attachment ? [criteria, attachment] : criteria);
    return { access, scope, query, check() { if (cursors.scope(req, access()) !== scope) throw cursors.invalid(); } };
  }
  async function scanFolder(req, folder, criteria, state, scope, size, type, checkpoint, timeoutMs, attachment = null, conversations = false, label = null) {
    const access = scope.access();
    requireFolderAccess(folder, access);
    const account = label ? resolveLabelAccount(req, folder, false) : null;
    if (state?.accountId && Number(state.accountId) !== Number(account?.id)) throw cursors.invalid();
    return withMailClient(async (client, ensureActive) => {
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      const uidValidity = String(mailbox.uidValidity);
      if (!/^[1-9]\d*$/.test(uidValidity)) throw new Error('Missing UIDVALIDITY');
      if (state?.uidValidity && state.uidValidity !== uidValidity) throw Object.assign(cursors.invalid(), { mailboxChanged: true });
      const ceiling = state?.ceiling ?? await highUid(client, mailbox, null, ensureActive);
      const before = state?.before ?? ceiling + 1;
      const initialCount = state?.initialCount ?? (Number.isSafeInteger(mailbox.exists) ? mailbox.exists : null);
      const position = { folder, ceiling, uidValidity, before, initialCount, ...(account ? { accountId: account.id } : {}) };
      checkpoint?.(position);
      const limit = attachment ? Math.min(size, MAX_CANDIDATES) : size;
      let scanned, range;
      if (label) {
        const candidates = account ? getTaskDb().prepare(`SELECT uid FROM mail_label_messages
          WHERE label_id=? AND owner_user_id=? AND account_id=? AND folder=? AND uid_validity=? AND uid<? AND uid<=?
          ORDER BY uid DESC LIMIT ?`).all(label.id, req.user.id, account.id, folder, uidValidity, before, ceiling, limit + 1).map(row => row.uid) : [];
        range = candidates.slice(0, limit);
        const hasMore = candidates.length > limit;
        scanned = { exhausted: !hasMore, nextBeforeUid: range.at(-1), reason: hasMore ? 'page_limit' : null };
        if (range.length && Object.keys(criteria).length) {
          ensureActive();
          const matches = await client.search({ ...criteria, uid: range.join(',') }, { uid: true });
          if (!Array.isArray(matches)) throw mailError('无法搜索标签邮件，请稍后重试', 502);
          const allowed = new Set(matches);
          range = range.filter(uid => allowed.has(uid));
        }
      } else {
        scanned = await scanNewestUids(client, criteria, mailbox, before, limit, ensureActive);
        range = scanned.uids;
      }
      const fetched = range.length ? await client.fetchAll(range, { uid: true, envelope: true, flags: true, internalDate: true, size: true,
        ...(attachment ? { bodyStructure: true } : {}), ...(conversations ? { headers: ['references'] } : {}) }, { uid: true }) : [];
      if (!Array.isArray(fetched)) throw new Error('Unable to fetch messages');
      const selected = new Set(range);
      let messages = fetched.filter(message => selected.delete(message.uid)).sort((a, b) => b.uid - a.uid).flatMap(message => {
        const match = attachment ? attachmentMatch(message, attachment) : {};
        if (!match) return [];
        return [{ ...serializeSummary(message), receivedAt: toIsoString(message.internalDate), ...match,
          ...(conversations ? { threadTokens: conversationTokens(message, folder, access.roots, scope.scope) } : {}) }];
      });
      scope.check();
      requireFolderAccess(folder, scope.access());
      if (label) {
        ownedLabel(getTaskDb(), req.user.id, label.id);
        if (resolveLabelAccount(req, folder, false)?.id !== account?.id) throw cursors.invalid();
        if (account) {
          const stillAssigned = matchingLabels(getTaskDb(), label.id, req.user.id, account.id, folder, uidValidity, messages.map(message => message.uid));
          messages = messages.filter(message => stillAssigned.has(message.uid));
        }
      }
      return { folder, uidValidity, ok: true, hasMore: !scanned.exhausted, mailboxTotal: Number(mailbox.exists || 0),
        state: scanned.exhausted ? 'complete' : 'limited', reason: scanned.reason, messages, initialCount,
        ...(type === 'group' ? { scanCeiling: ceiling, scanBefore: before, scanAfter: scanned.exhausted ? 0 : scanned.nextBeforeUid } : {}),
        ...(attachment ? { inspectedCandidates: range.length } : {}),
        ...(type === 'folder' ? { pageCursor: cursors.issue(type, scope.scope, scope.query, position) } : {}),
        resumeCursor: scanned.exhausted ? null : cursors.issue(type, scope.scope, scope.query, { ...position, before: scanned.nextBeforeUid }) };
    }, dependencies, req, timeoutMs);
  }
  registerSavedSearchRoutes(router, {
    getDb: () => dependencies.savedSearchDb || require('./db').db,
    authorize: req => currentAccess(req), allowed: folderAllowed,
    write: work => dependencies.savedSearchDb ? work() : require('./state-lock').withStateLock(require('./db').DIRS.root, work),
  });
  async function withMailClient(work, deps, req, timeoutMs) {
    const folders = new Set();
    const authorize = () => {
      const access = currentAccess(req);
      for (const folder of folders) requireFolderAccess(folder, req[internalPreview] ? currentAccess(req, folder) : access);
    };
    return withClient(async (client, ensureActive) => {
      const checkedMethods = new Set(['list', 'mailboxOpen', 'search', 'fetchAll', 'fetchOne', 'download', 'messageFlagsAdd', 'messageFlagsRemove']);
      const guarded = new Proxy(client, { get(target, key) {
        const value = target[key];
        if (typeof value !== 'function') return value;
        if (!checkedMethods.has(key)) return value.bind(target);
        return async (...args) => {
          if (key === 'mailboxOpen') folders.add(args[0]);
          ensureActive();
          const result = await value.apply(target, args);
          ensureActive();
          return result;
        };
      } });
      return work(guarded, ensureActive);
    }, deps, req, timeoutMs, authorize);
  }
  let taskService;
  const getTaskDb = () => dependencies.taskDb || dependencies.savedSearchDb || require('./db').db;
  const writeMailState = work => dependencies.taskDb ? work() : require('./state-lock').withStateLock(require('./db').DIRS.root, work);
  function resolveLabelAccount(req, folder, required = true) {
    requireFolderAccess(folder, currentAccess(req));
    const user = dependencies.labelLocalUser || require('./config').localDovecot().user;
    const account = labelAccount(getTaskDb(), req.user.id, user, folder);
    if (!account && required) throw mailError('此文件夹不支持个人标签', 409);
    return account;
  }
  function requestedLabel(req, query) {
    if (query.labelId === undefined) return null;
    if (query.continuation !== true || (dependencies.mailAccessForRequest && !dependencies.taskDb)) throw mailError('标签筛选需要使用可继续搜索');
    getTaskService();
    return ownedLabel(getTaskDb(), req.user.id, query.labelId);
  }
  const getTaskService = () => {
    if (!taskService) {
      if (dependencies.mailAccessForRequest && !dependencies.taskDb) throw mailError('邮件任务数据库未配置', 503);
      const automaticPreviews = autoPreviews.supportsAutomaticPreviews(getTaskDb()) ? {
        blocked: dependencies.automaticPreviewBlocked || (() => false), localUser,
        revoked: error => error.code === 'AUTO_PREVIEW_REVOKED',
        context(source) { return { [internalPreview]: source, user: { id: source.owner } }; },
        onError(error) { console.error('[mail auto preview]', error.code || error.name); },
      } : null;
      taskService = createMailTaskService({ db: getTaskDb(), newestUids, scanNewestUids, automaticPreviews,
        write: writeMailState, resolveLabelAccount,
        authorize(context, folder) {
          const access = currentAccess(context, folder);
          if (folder) requireFolderAccess(folder, access);
        },
        folderVisibility(context) {
          const access = currentAccess(context);
          return folder => folderAllowed(folder, access);
        },
        listFolders(context, signal) {
          return withMailClient(async (client, check) => {
            const entries = await client.list(); check();
            const access = currentAccess(context);
            return entries.filter(entry => !entry.flags?.has('\\Noselect') && folderAllowed(entry.path, access)).map(entry => entry.path).sort();
          }, dependencies, { ...context, signal });
        },
        withFolder(context, folder, readOnly, signal, work, timeoutMs = 15 * 60 * 1000) {
          return withMailClient(async (client, check) => {
            const mailbox = await client.mailboxOpen(folder, { readOnly }); check();
            return work(client, mailbox, check);
          }, dependencies, { ...context, signal }, timeoutMs);
        },
      });
    }
    return taskService;
  };
  Object.defineProperty(router, 'mailTasks', { get: getTaskService });
  registerRuleRoutes(router, { getDb: getTaskDb, getService: getTaskService,
    authorize: req => currentAccess(req), allowed: folderAllowed,
    write: writeMailState });
  registerMailLabelRoutes(router, { getDb: () => { getTaskService(); return getTaskDb(); },
    authorize: req => currentAccess(req), write: writeMailState, resolveAccount: resolveLabelAccount,
    validateRef(query, rawUid) {
      const uid = parsePositiveInteger(rawUid, null, MAX_UID);
      if (!uid || typeof query.uidValidity !== 'string' || !/^[1-9]\d{0,19}$/.test(query.uidValidity)) throw mailError('邮件标签定位参数不合法');
      return { uid, folder: validateMailboxPath(query.folder), validity: query.uidValidity };
    },
    withReadOnly(req, ref, work) {
      return withMailClient(async (client, check) => {
        const mailbox = await client.mailboxOpen(ref.folder, { readOnly: true }); check();
        checkUidValidity(mailbox, ref.validity, true);
        const message = await client.fetchOne(ref.uid, { uid: true }, { uid: true }); check();
        if (!message || Number(message.uid) !== ref.uid) throw mailError('邮件不存在或已被移除', 404);
        return work();
      }, dependencies, req);
    },
  });
  const downloads = new Map();
  let activeDownloads = 0;
  const legacySeenJobs = createSeenJobManager({
    async runFolder(originalReq, folder, onProgress) {
      // Ownership and user/session status may change after a long job starts.
      const authorizedRequest = () => {
        let activeReq = originalReq;
        if (!dependencies.mailAccessForRequest) {
          const user = require('./auth').assertCurrentUser(originalReq);
          if (!user || Number(user.id) !== Number(originalReq.user?.id)) throw mailError('用户会话已失效', 401);
          activeReq = { ...originalReq, user };
        }
        requireFolderAccess(folder, mailAccessForRequest(activeReq, dependencies));
        return activeReq;
      };
      const activeReq = authorizedRequest();
      return withMailClient(async (client, ensureActive) => {
        const mailbox = await client.mailboxOpen(folder, { readOnly: false });
        let beforeUid = null, missing = 0;
        for (;;) {
          ensureActive();
          const selected = await newestUids(client, { seen: false }, mailbox, beforeUid, 501, ensureActive);
          const batch = selected.slice(0, 500);
          if (!batch.length) break;
          ensureActive();
          authorizedRequest();
          if (!await client.messageFlagsAdd(batch, ['\\Seen'], { uid: true })) throw new Error('Flag update failed');
          ensureActive();
          const verified = await client.fetchAll(batch, { uid: true, flags: true }, { uid: true });
          if (!Array.isArray(verified)) throw new Error('Cannot verify flags');
          const confirmed = new Set(verified.filter(item => batch.includes(item.uid) && item.flags instanceof Set && item.flags.has('\\Seen')).map(item => item.uid)).size;
          onProgress(confirmed);
          missing += batch.length - confirmed;
          beforeUid = batch[batch.length - 1];
          if (selected.length <= 500) break;
        }
        return { ok: missing === 0, missing };
      }, dependencies, activeReq, 15 * 60 * 1000);
    },
  });
  // Keep the old response contract; production jobs use the durable service.
  const seenJobs = dependencies.mailAccessForRequest && !dependencies.taskDb ? legacySeenJobs : {
    start: (owner, folders, context) => getTaskService().createSeen(owner, folders, context),
    get: (owner, id) => { try { return getTaskService().get(owner, id); } catch (error) { if (error.statusCode === 404) return null; throw error; } },
    getActive: owner => getTaskService().getActive(owner, 'seen_all'),
  };

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
      await withMailClient(async (client, ensureActive) => {
        let content;
        const cancel = () => { if (!res.writableFinished) { content?.destroy(); client.close(); } };
        res.once('close', cancel);
        const accessTimer = setInterval(() => {
          try { ensureActive(); } catch (_) { content?.destroy(); client.close(); if (!res.destroyed) res.destroy(); }
        }, 1000);
        accessTimer.unref();
        const timeout = setTimeout(() => { content?.destroy(mailError('下载超时', 504)); client.close(); }, 120000);
        timeout.unref();
        try {
          const mailbox = await client.mailboxOpen(folder, { readOnly: true });
          ensureActive();
          checkUidValidity(mailbox, req.query.uidValidity, true);
          const metadata = await client.fetchOne(uid, { uid: true, size: true, envelope: true, bodyStructure: true }, { uid: true });
          ensureActive();
          if (!metadata) throw mailError('邮件不存在或已被移除', 404);
          const file = attachment ? attachmentParts(metadata.bodyStructure).find(item => item.part === req.params.part) : null;
          if (attachment && !file) throw mailError('附件不存在', 404);
          if (Number(attachment ? file.size : metadata.size) > MAX_DOWNLOAD_BYTES) throw mailError('下载超过100 MB上限', 413);
          ensureActive();
          const download = await client.download(uid, attachment ? file.part : undefined, { uid: true, maxBytes: MAX_DOWNLOAD_BYTES + 1 });
          if (!download?.content) throw mailError('下载内容不可用', 404);
          content = download.content;
          if (res.destroyed) { content.destroy(); return; }
          const filename = attachment ? file.filename : `${safeFilename(metadata.envelope?.subject, 'message')}-${uid}.eml`;
          res.attachment(filename);
          res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" });
          await pipeline(content, downloadLimiter(), res);
        } finally { clearTimeout(timeout); clearInterval(accessTimer); res.removeListener('close', cancel); }
      }, dependencies, req, 120_000);
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

  router.put('/messages/flags', track(async (req, res) => {
    try {
      const { messages, flag, value } = req.body || {};
      if (!Array.isArray(messages) || !messages.length || messages.length > 100 ||
          !['seen', 'flagged'].includes(flag) || typeof value !== 'boolean') {
        throw mailError('邮件操作参数不合法');
      }
      const access = mailAccessForRequest(req, dependencies);
      const groups = new Map();
      for (const message of messages) {
        if (!message || typeof message.folder !== 'string' || !message.folder ||
            typeof message.uidValidity !== 'string' || !/^[1-9]\d*$/.test(message.uidValidity) ||
            !Number.isSafeInteger(message.uid) || message.uid < 1 || message.uid > MAX_UID) {
          throw mailError('邮件操作参数不合法');
        }
        const folder = validateMailboxPath(message.folder);
        requireFolderAccess(folder, access);
        const group = groups.get(folder) || { folder, uidValidity: message.uidValidity, uids: new Set() };
        if (group.uidValidity !== message.uidValidity) throw mailError('邮件列表已过期，请刷新后重试', 409);
        group.uids.add(message.uid);
        groups.set(folder, group);
      }
      const results = await withMailClient(async (client, ensureActive) => {
        const results = [];
        for (const group of groups.values()) {
          ensureActive();
          let writeStarted = false;
          try {
            const mailbox = await client.mailboxOpen(group.folder, { readOnly: false });
            checkUidValidity(mailbox, group.uidValidity, true);
            const uids = [...group.uids];
            const existing = await client.fetchAll(uids, { uid: true }, { uid: true });
            if (!Array.isArray(existing)) throw new Error('Unable to fetch messages');
            const present = [...new Set(existing.map(item => item.uid).filter(uid => group.uids.has(uid)))];
            const imapFlag = flag === 'seen' ? '\\Seen' : '\\Flagged';
            let verified = [];
            if (present.length) {
              ensureActive();
              const method = value ? 'messageFlagsAdd' : 'messageFlagsRemove';
              writeStarted = true;
              if (!await client[method](present, [imapFlag], { uid: true })) throw new Error('Flag update failed');
              ensureActive();
              verified = await client.fetchAll(present, { uid: true, flags: true }, { uid: true });
              if (!Array.isArray(verified)) throw new Error('Unable to verify flags');
            }
            const confirmed = new Set(verified.filter(item => present.includes(item.uid) && item.flags instanceof Set && item.flags.has(imapFlag) === value).map(item => item.uid));
            const remaining = new Set(verified.filter(item => present.includes(item.uid)).map(item => item.uid));
            const missing = uids.length - remaining.size;
            results.push({ folder: group.folder, ok: confirmed.size === uids.length, updated: confirmed.size, missing, failed: remaining.size - confirmed.size });
          } catch (error) {
            ensureActive();
            results.push({ folder: group.folder, ok: false, updated: writeStarted ? null : 0, missing: 0,
              error: error.statusCode === 409 ? '邮箱已重建，请刷新邮件列表' : '邮件操作结果无法确认，请刷新后重试' });
          }
        }
        return results;
      }, dependencies, req);
      res.json({ results });
    } catch (error) {
      if (!res.destroyed) { const safe = publicMailError(error); res.status(safe.statusCode).json({ error: safe.message }); }
    }
  }));

  router.get('/unread', async (req, res) => {
    try {
      if (req.query.after !== undefined && (typeof req.query.after !== 'string' || !req.query.after)) throw mailError('分页游标不合法');
      const after = req.query.after === undefined ? '' : validateMailboxPath(req.query.after);
      const access = mailAccessForRequest(req, dependencies);
      const result = await withMailClient(async (client, ensureActive) => {
        const entries = (await client.list({ statusQuery: { messages: true, unseen: true } }))
          .filter(entry => !entry.flags?.has('\\Noselect') && folderAllowed(entry.path, access) && Number(entry.status?.unseen) > 0)
          .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const remaining = entries.filter(entry => entry.path > after);
        const current = remaining.slice(0, UNREAD_FOLDERS_PER_PAGE);
        const groups = [];
        for (const entry of current) {
          ensureActive();
          try {
            const mailbox = await client.mailboxOpen(entry.path, { readOnly: true });
            const uidValidity = String(mailbox.uidValidity);
            if (!/^[1-9]\d*$/.test(uidValidity)) throw new Error('Missing UIDVALIDITY');
            const selected = await newestUids(client, { seen: false }, mailbox, null, UNREAD_PREVIEW_SIZE + 1, ensureActive);
            const range = selected.slice(0, UNREAD_PREVIEW_SIZE);
            const messages = range.length ? await client.fetchAll(range, { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true }) : [];
            ensureActive();
            if (!Array.isArray(messages)) throw new Error('Unable to fetch messages');
            groups.push({ folder: entry.path, uidValidity, unread: Number(entry.status.unseen), ok: true,
              hasMore: selected.length > UNREAD_PREVIEW_SIZE,
              messages: messages.sort((a, b) => b.uid - a.uid).map(serializeSummary) });
          } catch (error) {
            ensureActive();
            groups.push({ folder: entry.path, unread: Number(entry.status.unseen), ok: false, messages: [], ...searchFailure(error) });
          }
        }
        return { groups, totalUnread: entries.reduce((sum, entry) => sum + Number(entry.status.unseen), 0),
          totalFolders: entries.length, nextAfter: remaining.length > current.length ? current[current.length - 1].path : null };
      }, dependencies, req);
      const accessNow = currentAccess(req);
      result.groups.forEach(group => requireFolderAccess(group.folder, accessNow));
      if (result.groups.length && result.groups.every(group => group.code === SEARCH_BUDGET)) {
        return res.status(503).json({ ...result, code: SEARCH_BUDGET, error: result.groups[0].error });
      }
      res.json(result);
    } catch (error) {
      if (!res.destroyed) { const safe = publicMailError(error); res.status(safe.statusCode).json({ error: safe.message }); }
    }
  });

  router.post('/search', async (req, res) => {
    try {
      const query = req.body;
      if (!query || typeof query !== 'object' || Array.isArray(query)) throw mailError('搜索参数不合法');
      if (Object.keys(query).some(key => !['after', 'continuation', 'cursor', 'conversations', 'labelId', ...ATTACHMENT_FILTERS].includes(key) && !SEARCH_FILTER_KEYS.includes(key)) ||
          (query.conversations !== undefined && (query.conversations !== true || query.continuation !== true)) ||
          (query.continuation !== undefined && query.continuation !== true) ||
          (query.cursor !== undefined && query.continuation !== true) || (query.continuation && query.after !== undefined)) throw mailError('搜索参数不合法');
      if (query.after !== undefined && (typeof query.after !== 'string' || !query.after)) throw mailError('分页游标不合法');
      const after = query.after === undefined ? '' : validateMailboxPath(query.after);
      const criteria = searchCriteria(query);
      const attachment = attachmentCriteria(query);
      if (attachment && query.continuation !== true) throw mailError('附件筛选需要使用可继续搜索');
      const label = requestedLabel(req, query);
      if (!attachment && !label && !Object.keys(criteria).length) throw mailError('请至少填写一个搜索条件');
      if (query.continuation === true) {
        const scope = scopedSearch(req, criteria, attachment, query.conversations, label);
        const token = query.cursor === undefined ? null : cursors.read(query.cursor,
          ['folders', 'group', 'retry'], scope.scope, scope.query);
        const getGroup = async (folder, state) => {
          let retry = state || { folder };
          try {
            return await scanFolder(req, folder, criteria, state, scope, SEARCH_PREVIEW_SIZE, 'group',
              position => { retry = position; }, dependencies.searchFolderTimeoutMs || SEARCH_FOLDER_TIMEOUT_MS, attachment, query.conversations, label);
          } catch (error) {
            if (error.mailboxChanged) return { folder, ok: false, state: 'failed', reason: 'mailbox_changed', messages: [],
              retryCursor: cursors.issue('retry', scope.scope, scope.query, { folder }) };
            if (error.code === 'SEARCH_CURSOR_INVALID' || error.statusCode === 401 || error.statusCode === 404) throw error;
            return { folder, ok: false, state: 'failed', reason: error.statusCode === 503 ? 'busy' : 'folder_unavailable', messages: [],
              retryCursor: cursors.issue('retry', scope.scope, scope.query, retry) };
          }
        };
        if (token && token.type !== 'folders') {
          const folder = token.position.folder;
          requireFolderAccess(folder, scope.access());
          const group = await getGroup(folder, token.position);
          scope.check();
          if (!res.destroyed) res.json({ groups: [group], nextFoldersCursor: null, scopeTag: scope.scope });
          return;
        }
        const access = scope.access();
        const labelFolders = label ? new Set(getTaskDb().prepare('SELECT DISTINCT folder FROM mail_label_messages WHERE label_id=? AND owner_user_id=?')
          .all(label.id, req.user.id).map(row => row.folder)) : null;
        const entries = await withMailClient(async client => (await client.list())
          .filter(entry => !entry.flags?.has('\\Noselect') && folderAllowed(entry.path, access))
          .map(entry => entry.path).filter(folder => !labelFolders || labelFolders.has(folder)).sort(), dependencies, req);
        scope.check();
        const position = token?.position || { after: '', last: entries.at(-1) || '' };
        const range = entries.filter(folder => folder > position.after && folder <= position.last);
        const page = range.slice(0, SEARCH_FOLDERS_PER_PAGE);
        const groups = new Array(page.length);
        let index = 0;
        const worker = async () => {
          while (index < page.length && !res.destroyed) {
            const current = index++;
            groups[current] = await getGroup(page[current]);
          }
        };
        await Promise.all(Array.from({ length: Math.min(2, page.length) }, worker));
        scope.check();
        if (res.destroyed) return;
        const nextAfter = range.length > page.length ? page.at(-1) : null;
        res.json({ groups: groups.filter(group => !group.ok || group.messages.length || group.hasMore),
          emptyGroups: groups.filter(group => group.ok && !group.messages.length && !group.hasMore), scopeTag: scope.scope,
          totalFolders: entries.filter(folder => folder <= position.last).length,
          scannedFolders: entries.filter(folder => folder <= (page.at(-1) || position.after)).length, nextAfter,
          pageCursor: cursors.issue('folders', scope.scope, scope.query, position),
          nextFoldersCursor: nextAfter ? cursors.issue('folders', scope.scope, scope.query, { after: nextAfter, last: position.last }) : null });
        return;
      }
      const accessNow = () => currentAccess(req);
      const access = accessNow();
      const entries = await withMailClient(async client => (await client.list())
        .filter(entry => !entry.flags?.has('\\Noselect') && folderAllowed(entry.path, access))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), dependencies, req);
      const remaining = entries.filter(entry => entry.path > after);
      const page = remaining.slice(0, SEARCH_FOLDERS_PER_PAGE);
      const groups = new Array(page.length);
      let position = 0;
      const worker = async () => {
        while (!res.destroyed) {
          const index = position++;
          if (index >= page.length) return;
          const folder = page[index].path;
          try {
            requireFolderAccess(folder, accessNow());
            groups[index] = await withMailClient(async (client, ensureActive) => {
              const mailbox = await client.mailboxOpen(folder, { readOnly: true });
              ensureActive();
              const uidValidity = String(mailbox.uidValidity);
              if (!/^[1-9]\d*$/.test(uidValidity)) throw new Error('Missing UIDVALIDITY');
              const selected = await newestUids(client, criteria, mailbox, null, SEARCH_PREVIEW_SIZE + 1, ensureActive);
              const range = selected.slice(0, SEARCH_PREVIEW_SIZE);
              const messages = range.length ? await client.fetchAll(range, { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true }) : [];
              ensureActive();
              if (!Array.isArray(messages)) throw new Error('Unable to fetch messages');
              requireFolderAccess(folder, accessNow());
              return { folder, uidValidity, ok: true, hasMore: selected.length > SEARCH_PREVIEW_SIZE,
                messages: messages.sort((a, b) => b.uid - a.uid).map(serializeSummary) };
            }, dependencies, req, dependencies.searchFolderTimeoutMs || SEARCH_FOLDER_TIMEOUT_MS);
          } catch (error) {
            if (!res.destroyed) groups[index] = { folder, ok: false, messages: [], ...searchFailure(error) };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, page.length) }, worker));
      if (res.destroyed) return;
      const latestAccess = accessNow();
      if (entries.some(entry => !folderAllowed(entry.path, latestAccess))) throw mailError('邮箱访问权限已变化，请重新搜索', 409);
      if (groups.length && groups.every(group => group?.code === SEARCH_BUDGET)) {
        return res.status(503).json({ ...searchFailure({ code: SEARCH_BUDGET, message: groups[0].error }), groups });
      }
      res.json({
        groups: groups.filter(group => group && (!group.ok || group.messages.length || group.hasMore)),
        totalFolders: entries.length,
        scannedFolders: entries.filter(entry => entry.path <= (page.at(-1)?.path || after)).length,
        nextAfter: remaining.length > page.length ? page[page.length - 1].path : null,
      });
    } catch (error) {
      if (!res.destroyed) { const safe = publicMailError(error); res.status(safe.statusCode).json({ error: safe.message, ...searchFailure(safe) }); }
    }
  });

  router.legacyMailWritesBusy = legacySeenJobs.busy;
  router.post('/seen-jobs', (req, res) => {
    try {
      const owner = Number(req.user?.id);
      if (!Number.isSafeInteger(owner) || owner < 1) throw mailError('未登录', 401);
      const input = req.body?.folders;
      if (!Array.isArray(input) || !input.length || input.length > 500 ||
          input.some(folder => typeof folder !== 'string' || !folder.trim())) throw mailError('文件夹列表不合法');
      const folders = [...new Set(input.map(validateMailboxPath))];
      const access = mailAccessForRequest(req, dependencies);
      folders.forEach(folder => requireFolderAccess(folder, access));
      res.status(202).json(seenJobs.start(owner, folders, { user: req.user, sessionID: req.sessionID, session: req.session && { userId: req.session.userId, sessionVersion: req.session.sessionVersion } }));
    } catch (error) {
      const safe = publicMailError(error); res.status(safe.statusCode).json({ error: safe.message });
    }
  });

  router.get('/seen-jobs/active', (req, res) => {
    res.json({ job: seenJobs.getActive(Number(req.user?.id)) });
  });

  router.get('/seen-jobs/:id', (req, res) => {
    const job = seenJobs.get(Number(req.user?.id), req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    res.json(job);
  });

  router.put('/seen-all', track(async (req, res) => {
    try {
      const access = mailAccessForRequest(req, dependencies);
      const input = req.body?.folders;
      if (!Array.isArray(input) || !input.length || input.length > 500 ||
          input.some((path) => typeof path !== 'string' || !path.trim())) {
        return res.status(400).json({ error: 'Invalid folder list' });
      }
      const folders = [...new Set(input.map(validateMailboxPath))];
      folders.forEach((folder) => requireFolderAccess(folder, access));
      const results = await withMailClient(async (client, ensureActive) => {
        const available = new Set((await client.list()).filter((entry) => !entry.flags?.has('\\Noselect')).map((entry) => entry.path));
        if (folders.some((folder) => !available.has(folder))) {
          const error = new Error('文件夹不存在，请刷新后重试'); error.statusCode = 400; throw error;
        }
        const results = [];
        for (const folder of folders) {
          ensureActive();
          try {
            const mailbox = await client.mailboxOpen(folder, { readOnly: false });
            let updated = 0, beforeUid = null;
            for (;;) {
              const batch = await newestUids(client, { seen: false }, mailbox, beforeUid, 500, ensureActive);
              if (!batch.length) break;
              if (!await client.messageFlagsAdd(batch, ['\\Seen'], { uid: true })) throw new Error('Flag update failed');
              updated += batch.length;
              if (batch.length < 500) break;
              beforeUid = batch.at(-1);
            }
            results.push({ folder, ok: true, updated });
          } catch (_) { ensureActive(); results.push({ folder, ok: false }); }
        }
        return results;
      }, dependencies, req);
      res.json({ results });
    } catch (error) {
      const safe = publicMailError(error);
      res.status(safe.statusCode).json({ error: safe.message });
    }
  }));

  router.put('/messages/:uid/seen', track(async (req, res) => {
    try {
      const folder = validateMailboxPath(req.query.folder);
      requireFolderAccess(folder, mailAccessForRequest(req, dependencies));
      const uid = parsePositiveInteger(req.params.uid, null);
      if (!uid || typeof req.body?.seen !== 'boolean') {
        return res.status(400).json({ error: 'Invalid UID or seen state' });
      }
      const seen = await withMailClient(async (client, ensureActive) => {
        const mailbox = await client.mailboxOpen(folder, { readOnly: false });
        checkUidValidity(mailbox, req.query.uidValidity, true);
        const message = await client.fetchOne(uid, { flags: true }, { uid: true });
        if (!message) { const error = new Error('邮件不存在或已被移除'); error.statusCode = 404; throw error; }
        const method = req.body.seen ? 'messageFlagsAdd' : 'messageFlagsRemove';
        ensureActive();
        await client[method](uid, ['\\Seen'], { uid: true });
        const updated = await client.fetchOne(uid, { flags: true }, { uid: true });
        if (!updated || updated.flags.has('\\Seen') !== req.body.seen) throw new Error('Flag update failed');
        return updated.flags.has('\\Seen');
      }, dependencies, req);
      res.json({ folder, uid, seen });
    } catch (error) {
      const safe = publicMailError(error);
      res.status(safe.statusCode).json({ error: safe.message });
    }
  }));

  router.get('/folders', async (req, res) => {
    try {
      const access = mailAccessForRequest(req, dependencies);
      const folders = await withMailClient(async (client, ensureActive) => {
        const entries = await client.list({ statusQuery: { messages: true, unseen: true } });
        ensureActive();
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
      }, dependencies, req);
      const accessNow = currentAccess(req);
      res.json({ folders: folders.filter(folder => folderAllowed(folder.path, accessNow)) });
    } catch (error) {
      const safe = publicMailError(error);
      res.status(safe.statusCode).json({ error: safe.message });
    }
  });

  async function listMessages(req, res, query) {
    try {
      const folder = validateMailboxPath(query.folder);
      requireFolderAccess(folder, mailAccessForRequest(req, dependencies));
      const label = requestedLabel(req, query);
      const page = parsePositiveInteger(query.page, 1);
      const pageSize = parsePositiveInteger(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const attachment = attachmentCriteria(query);
      if (attachment && query.continuation !== true) throw mailError('附件筛选需要使用可继续搜索');
      if (query.continuation === true) {
        const criteria = searchCriteria(query);
        const scope = scopedSearch(req, criteria, attachment, query.conversations, label);
        const token = query.cursor === undefined ? null : cursors.read(query.cursor, ['folder'], scope.scope, scope.query);
        if ((token && token.position.folder !== folder) || (page > 1 && !token)) throw cursors.invalid();
        const result = await scanFolder(req, folder, criteria, token?.position || (query.uidValidity ? { uidValidity: query.uidValidity } : null), scope, pageSize, 'folder', undefined, undefined, attachment, query.conversations, label);
        if (query.uidValidity !== undefined && query.uidValidity !== result.uidValidity) throw cursors.invalid();
        scope.check();
        const total = !attachment && !label && !Object.keys(criteria).length ? result.initialCount : null;
        if (!res.destroyed) res.json({ ...result, page, pageSize, total,
          totalPages: total === null ? null : Math.max(1, Math.ceil(total / pageSize)) });
        return;
      }
      const beforeUid = query.beforeUid === undefined ? null : parsePositiveInteger(query.beforeUid, null, 4294967295);
      if (query.beforeUid !== undefined && beforeUid === null) return res.status(400).json({ error: '分页游标不合法' });
      if (page > 1 && !beforeUid) return res.status(400).json({ error: '请刷新页面以使用稳定的邮件分页' });
      const knownTotal = query.knownTotal === undefined ? null : parsePositiveInteger(query.knownTotal, null, 1_000_000_000);
      if (query.knownTotal !== undefined && knownTotal === null) return res.status(400).json({ error: '邮件总数参数不合法' });
      const criteria = searchCriteria(query);
      const result = await withMailClient(async (client, ensureActive) => {
        const mailbox = await client.mailboxOpen(folder, { readOnly: true });
        ensureActive();
        const uidValidity = String(mailbox.uidValidity);
        if (query.uidValidity !== undefined && query.uidValidity !== uidValidity) {
          throw Object.assign(new Error('邮箱已重建，请刷新邮件列表'), { statusCode: 409 });
        }
        let total;
        if (beforeUid && knownTotal !== null) total = knownTotal;
        else if (!Object.keys(criteria).length && Number.isSafeInteger(mailbox.exists)) total = mailbox.exists;
        else total = await matchingCount(client, criteria, mailbox, ensureActive);
        const selected = await newestUids(client, criteria, mailbox, beforeUid, pageSize + 1, ensureActive);
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
        ensureActive();
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
      }, dependencies, req);
      requireFolderAccess(folder, currentAccess(req));
      res.json(result);
    } catch (error) {
      if (!res.destroyed) { const safe = publicMailError(error); res.status(safe.statusCode).json({ error: safe.message, ...searchFailure(safe) }); }
    }
  }

  router.get('/messages', (req, res) => listMessages(req, res, req.query));
  router.post('/messages/search', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: '搜索参数不合法' });
    const allowed = new Set([...SEARCH_FILTER_KEYS, ...ATTACHMENT_FILTERS, 'folder', 'page', 'pageSize', 'beforeUid', 'knownTotal', 'uidValidity', 'continuation', 'cursor', 'conversations', 'labelId']);
    if (Object.keys(req.body).some(key => !allowed.has(key)) || typeof req.body.folder !== 'string' || !req.body.folder.trim() ||
        (req.body.conversations !== undefined && (req.body.conversations !== true || req.body.continuation !== true)) ||
        (req.body.continuation !== undefined && req.body.continuation !== true) ||
        (req.body.cursor !== undefined && req.body.continuation !== true) ||
        (req.body.continuation && (req.body.beforeUid !== undefined || req.body.knownTotal !== undefined)) ||
        (req.body.uidValidity !== undefined && (typeof req.body.uidValidity !== 'string' || !/^[1-9]\d*$/.test(req.body.uidValidity)))) {
      return res.status(400).json({ error: '搜索参数不合法' });
    }
    return listMessages(req, res, req.body);
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
      const result = await withMailClient(async (client, ensureActive) => {
        const mailbox = await client.mailboxOpen(folder, { readOnly: true });
        ensureActive();
        const uidValidity = checkUidValidity(mailbox, req.query.uidValidity);
        const metadata = await client.fetchOne(uid, {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
          bodyStructure: true,
        }, { uid: true });
        ensureActive();
        if (!metadata) {
          const error = new Error('邮件不存在或已被移除');
          error.statusCode = 404;
          throw error;
        }
        if (Number(metadata.size || 0) > MAX_MESSAGE_BYTES) {
          return { ...serializeSummary(metadata), uidValidity, bodyOmitted: true, text: '', html: '',
            ...boundedAttachmentMetadata(attachmentParts(metadata.bodyStructure)), remoteImageCount: 0 };
        }
        const full = await client.fetchOne(uid, { source: { start: 0, maxLength: MAX_MESSAGE_BYTES + 1 } }, { uid: true });
        ensureActive();
        if (!full || !full.source) {
          const error = new Error('邮件正文不可用');
          error.statusCode = 404;
          throw error;
        }
        const sourceBytes = Buffer.isBuffer(full.source)
          ? full.source.length
          : Buffer.byteLength(String(full.source));
        if (sourceBytes > MAX_MESSAGE_BYTES) {
          throw mailError('这封邮件的实际大小超过 10 MB，暂不在网页中展开', 413);
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.once('close', cancel);
        const authorizationTimer = setInterval(() => {
          try { ensureActive(); } catch (_) { controller.abort(); }
        }, 250); authorizationTimer.unref?.();
        let result;
        try {
          const { bodyStructure, ...summaryMetadata } = metadata;
          result = await (dependencies.parseMessage || ((meta, source, options) => mailParser.parse(meta, source, options)))(summaryMetadata, full.source, { signal: controller.signal });
        } catch (error) { ensureActive(); throw error; }
        finally { clearInterval(authorizationTimer); res.removeListener('close', cancel); }
        ensureActive();
        result.uidValidity = uidValidity;
        if (metadata.bodyStructure) Object.assign(result, boundedAttachmentMetadata(attachmentParts(metadata.bodyStructure)));
        else result.attachmentsOmittedCount ??= 0;
        return result;
      }, dependencies, req);
      res.type('json').send(encodeMailDetail(folder, result));
    } catch (error) {
      const safe = publicMailError(error);
      res.status(safe.statusCode).json({ error: safe.message });
    }
  });

  return router;
}

module.exports = {
  withClient,
  newestUids,
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
