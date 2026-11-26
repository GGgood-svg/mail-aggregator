'use strict';

const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const { randomBytes, createHmac, timingSafeEqual } = require('node:crypto');
const { accountGeneration } = require('./account-generation');
const { assertPublicImapHost, assertSecureAccountEndpoint } = require('./network-policy');
const { getProvider } = require('./providers');
const { imapTransportOptions } = require('./target-transport');
const { destinationRoot } = require('./folder-strategy');
const { syncImpact, targetScope } = require('./sync-impact');
const { encodePath, decodePath } = require('imapflow/lib/tools');

const MAX_FOLDERS = 1500;
const MAX_WIRE_BYTES = 512 * 1024;
const SIDE_TIMEOUT_MS = 12000;
const TEST_TIMEOUT_MS = 55000;
const PLAN_TTL_MS = 5 * 60 * 1000;
const PLAN_PAGE_ROWS = 100;
const PLAN_PAGE_BYTES = 256 * 1024;
const PLAN_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const PLAN_CACHE_BYTES = 8 * 1024 * 1024;
const PLAN_CACHE_COUNT = 16;
const messages = {
  busy: '同步或连接测试正在运行，请稍后重试',
  maintenance: '服务正在维护或关闭，请稍后重试',
  interrupted: '连接测试已中断',
  not_found: '账号不存在',
  scope_denied: '无法确认目标目录归属，请检查账号配置',
  credential_missing: '未找到可用的邮箱密码',
  authorization_required: 'OAuth2账号尚未授权，请重新授权',
  auth_failed: '认证失败，请检查用户名和密码或重新授权',
  timeout: '连接或读取目录超时',
  tls_failed: 'TLS证书或加密连接验证失败',
  network_unreachable: '无法连接到邮箱服务器',
  endpoint_rejected: '邮箱地址无法验证或不符合连接要求',
  folder_failed: '已连接，但无法读取文件夹列表',
  folder_limit: '文件夹列表超过本次检查上限',
  plan_list_limit: '服务器目录列表超过预演上限，可改为只检查所选源目录',
  plan_list_timeout: '服务器目录列表读取超时，可重试或只检查所选源目录',
  plan_limit: '预演结果超过安全上限，请缩小同步范围后重试',
  plan_scope_invalid: '请输入完整源目录名称，不能包含 *、% 或控制字符',
  plan_scope_flat: '服务器未提供可用的目录层级，请改用精确名称查询',
  plan_scope_missing: '找不到指定的源父目录，请检查完整名称',
  plan_scope_limit: '所选范围内目录过多，请输入更具体的源目录名称',
  config_changed: '账号或邮件目标配置已变化，请重新检查',
  oauth_busy: '账号正在刷新授权，请稍后重试',
  oauth_network: '无法连接OAuth2令牌服务',
  oauth_request_failed: 'OAuth2令牌服务暂时不可用',
  test_failed: '连接检查未完成，请检查设置',
};

function probeError(code) { return Object.assign(new Error(messages[code]), { probeCode: code }); }
function publicSide({ ok = false, step = 'not_checked', reason = null, elapsedMs = 0, folders = null } = {}) {
  return { ok, step, reason, elapsedMs, folders };
}
function probeUnavailable(category) {
  return { ok: false, mode: 'read_only', category, message: messages[category] || messages.test_failed,
    source: publicSide(), target: publicSide(), writeAccess: 'not_checked' };
}
function categoryFor(error, step) {
  if (error?.probeCode) return error.probeCode;
  const code = String(error?.code || '');
  if (code === 'oauth_stale') return 'config_changed';
  if (code === 'oauth_timeout') return 'timeout';
  if (code === 'invalid_grant') return 'authorization_required';
  if (code === 'invalid_client') return 'oauth_request_failed';
  if (Object.hasOwn(messages, code)) return code;
  if (error?.name === 'TimeoutError' || /timeout/i.test(code)) return 'timeout';
  if (error?.name === 'AbortError') return 'interrupted';
  if (/TLS|SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return 'tls_failed';
  if (error?.authenticationFailed || /AUTHENTICATIONFAILED/i.test(String(error?.serverResponseCode || ''))) return 'auth_failed';
  if (step === 'list') return 'folder_failed';
  return step === 'connect' ? 'network_unreachable' : 'test_failed';
}

function abortable(work, signal, stop = () => {}) {
  signal.throwIfAborted();
  let fail;
  const abort = new Promise((_, reject) => { fail = reject; });
  const onAbort = () => { fail(signal.reason); stop(); };
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), abort])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

function transport(host, address, port, options = {}) {
  const name = String(host).replace(/\.$/, '').replace(/^\[(.*)]$/, '$1');
  return {
    host: address, port: Number(port), servername: net.isIP(name) ? false : name,
    ...options,
    tls: { rejectUnauthorized: true, checkServerIdentity: (_socketName, certificate) => tls.checkServerIdentity(name, certificate) },
  };
}

function closeClient(client) { try { client?.close(); } catch (_) {} }

function validScopePath(value) {
  return typeof value === 'string' && Boolean(value.trim()) && Buffer.byteLength(value) <= 1024 && !/[\x00-\x1f\x7f%*]/.test(value);
}
function checkedScope(input) {
  if (input?.kind === 'root' && input.path === undefined) return { kind: 'root' };
  if (['exact', 'children'].includes(input?.kind) && validScopePath(input.path)) return { kind: input.kind, path: input.path };
  throw probeError('plan_scope_invalid');
}
const realDelimiter = value => typeof value === 'string' && /^[\x21-\x7e]$/.test(value) && !/[%*"\\]/.test(value);
const sameMailbox = (left, right) => left === right || (/^inbox$/i.test(left) && /^inbox$/i.test(right));

// ImapFlow's public list() always emits LIST "" "*". Use the same encoder
// and command executor as the pinned ImapFlow LIST command, with an explicitly
// empty reference name to avoid introducing an implicit namespace prefix.
async function scopedList(client, scope, signal, guard, close) {
  async function query(pattern, matches, describeRoot = false) {
    let seen = 0, bytes = 0, over = false;
    const rows = [];
    await abortable(async () => {
      const response = await client.exec('LIST', ['', encodePath(client, pattern)], { untagged: { LIST: async ({ attributes }) => {
        if (++seen > MAX_FOLDERS) { over = true; return; }
        const raw = attributes?.[2]?.value;
        if (typeof raw !== 'string') return;
        const path = decodePath(client, raw);
        const delimiter = attributes?.[1]?.value;
        if (!matches(path, delimiter) || rows.some(row => row.path === path)) return;
        const row = { path, canBrowseChildren: realDelimiter(delimiter) && validScopePath(path) };
        bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (rows.length >= PLAN_PAGE_ROWS || bytes > PLAN_PAGE_BYTES) { over = true; return; }
        rows.push(describeRoot ? { ...row, delimiter } : row);
      } } });
      response.next();
    }, signal, close);
    guard();
    if (over) throw probeError('plan_scope_limit');
    return rows;
  }
  if (scope.kind === 'exact') {
    return query(scope.path, path => sameMailbox(path, scope.path));
  }
  let parent = '', delimiter;
  if (scope.kind === 'root') {
    const rows = await query('', () => true, true);
    if (rows.length === 1) delimiter = rows[0].delimiter;
  } else {
    const rows = await query(scope.path, path => sameMailbox(path, scope.path), true);
    if (rows.length !== 1) throw probeError('plan_scope_missing');
    ({ path: parent, delimiter } = rows[0]);
  }
  if (!realDelimiter(delimiter)) throw probeError('plan_scope_flat');
  const prefix = parent ? `${parent}${delimiter}` : '';
  return query(`${prefix}%`, (path, resultDelimiter) => {
    if (resultDelimiter !== delimiter || !path.startsWith(prefix)) return false;
    const child = path.slice(prefix.length);
    return Boolean(child) && !child.includes(delimiter);
  });
}

async function probeSide(endpoint, makeClient, signal, guard, listOnly, scope = null) {
  const started = Date.now();
  let client, socket, onData, wireError, step = 'credentials';
  try {
    guard();
    const auth = await endpoint.auth();
    guard();
    const sideSignal = AbortSignal.any([signal, AbortSignal.timeout(SIDE_TIMEOUT_MS)]);
    sideSignal.throwIfAborted();
    step = 'connect';
    client = makeClient({ ...endpoint.transport, auth, logger: false, logRaw: false,
      disableAutoIdle: true, disableAutoEnable: true, disableCompression: true,
      connectionTimeout: SIDE_TIMEOUT_MS, greetingTimeout: SIDE_TIMEOUT_MS, socketTimeout: SIDE_TIMEOUT_MS,
      maxLineLength: 16 * 1024, maxLiteralSize: 32 * 1024, maxResponseSize: 64 * 1024 });
    client.on?.('error', () => {});
    await abortable(() => client.connect(), sideSignal, () => closeClient(client));
    guard();
    step = 'list';
    socket = client.socket;
    onData = () => {
      if (socket.bytesRead > MAX_WIRE_BYTES && !wireError) { wireError = probeError('folder_limit'); closeClient(client); }
    };
    if (socket) { socket.on('data', onData); onData(); }
    const rows = scope ? await scopedList(client, scope, sideSignal, guard, () => closeClient(client))
      : await abortable(() => client.list({ listOnly }), sideSignal, () => closeClient(client));
    guard();
    if (wireError || rows.length > MAX_FOLDERS) throw wireError || probeError('folder_limit');
    return { side: publicSide({ ok: true, step: 'list', elapsedMs: Date.now() - started, folders: rows.length }),
      folders: rows, namespace: client.namespace };
  } catch (error) {
    // A revoked session or removed account is an API error; no part of the
    // already-read folder inventory is returned to that caller.
    if ([401, 403, 404].includes(error?.statusCode)) throw error;
    const category = categoryFor(wireError || error, step);
    const reason = !listOnly && step === 'list'
      ? ({ folder_limit: 'plan_list_limit', timeout: 'plan_list_timeout' }[category] || category) : category;
    return { side: publicSide({ step, reason, elapsedMs: Date.now() - started }) };
  } finally {
    if (socket && onData) socket.removeListener('data', onData);
    closeClient(client);
  }
}

function readSecret(file) {
  let value;
  try { value = fs.readFileSync(file, 'utf8').split(/\r?\n/, 1)[0]; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!value || value.length > 64 * 1024 || /[\r\n\0]/.test(value)) throw probeError('credential_missing');
  return value;
}

function createAccountImapProbe({ database, localConfig, secretForSource, secretForTarget, oauthToken, oauthGrant = () => null,
  resolvePublic = assertPublicImapHost, createClient = options => new (require('imapflow').ImapFlow)(options), clock = Date.now }) {
  const planKey = randomBytes(32);
  function accountContext(account, bindGrant = true) {
    return JSON.stringify([accountGeneration(database, account.id), localConfig(), account.owner_user_id,
      bindGrant && account.auth_type === 'oauth2' ? oauthGrant(account.id) : null]);
  }
  const snapshots = new Map();
  let cachedBytes = 0;
  const sign = (...parts) => createHmac('sha256', planKey).update(JSON.stringify(parts)).digest('hex');
  const equalMac = (mac, expected) => timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'));

  function scopeAllowed(account) {
    const owner = database.prepare('SELECT role,enabled,mail_access_all FROM admin_users WHERE id=?').get(account.owner_user_id);
    const root = destinationRoot(account);
    if (!owner?.enabled) return false;
    if (!root) return account.destination_mode === 'flat' && !account.mailbox_folder && owner.role === 'admin' && Boolean(owner.mail_access_all);
    const row = database.prepare('SELECT owner_user_id FROM mailbox_ownership WHERE local_user=? AND mailbox_folder=? COLLATE NOCASE')
      .get(account.local_user, root);
    return Number(row?.owner_user_id) === Number(account.owner_user_id);
  }

  function removeSnapshot(id) {
    cachedBytes -= snapshots.get(id).bytes;
    snapshots.delete(id);
  }
  function pruneSnapshots() {
    for (const [id, snapshot] of snapshots) if (snapshot.expires <= clock()) removeSnapshot(id);
  }
  const cursorFor = (id, offset) => `${id}.${offset}.${sign('cursor', id, offset)}`;
  function page(snapshot, offset) {
    let end = offset, bytes = 0;
    while (end < snapshot.rows.length && end - offset < PLAN_PAGE_ROWS && bytes + snapshot.sizes[end] <= PLAN_PAGE_BYTES) {
      bytes += snapshot.sizes[end++];
    }
    return { rows: snapshot.rows.slice(offset, end), offset, totalRows: snapshot.rows.length,
      nextCursor: end < snapshot.rows.length ? cursorFor(snapshot.id, end) : null };
  }
  function makePlanPage(plan, account, context, subject, expires) {
    let bytes = 0;
    const sizes = [];
    for (const row of plan.rows) {
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      bytes += size;
      if (size > PLAN_PAGE_BYTES || bytes > PLAN_SNAPSHOT_BYTES) return null;
      sizes.push(size);
    }
    const snapshot = { id: randomBytes(16).toString('hex'), accountId: account.id, context, subject,
      rows: plan.rows, sizes, bytes, expires };
    const first = page(snapshot, 0);
    if (first.nextCursor) {
      pruneSnapshots();
      while (snapshots.size >= PLAN_CACHE_COUNT || cachedBytes + bytes > PLAN_CACHE_BYTES) removeSnapshot(snapshots.keys().next().value);
      snapshots.set(snapshot.id, snapshot);
      cachedBytes += bytes;
    }
    return { ...plan, ...first, truncated: Boolean(first.nextCursor),
      pageCursor: first.nextCursor ? cursorFor(snapshot.id, 0) : null, expiresAt: new Date(expires).toISOString(),
      ticket: `${expires}.${sign('install', account.id, expires, context, subject)}` };
  }
  function readPage(account, cursor, { subject = '', authorize, assertOperational, signal } = {}) {
    try {
      signal?.throwIfAborted();
      authorize?.();
      assertOperational?.();
      pruneSnapshots();
      const [id, position, mac] = typeof cursor === 'string' && /^[a-f0-9]{32}\.(?:0|[1-9][0-9]{0,3})\.[a-f0-9]{64}$/.test(cursor)
        ? cursor.split('.') : [];
      const snapshot = snapshots.get(id);
      const offset = Number(position);
      if (!snapshot || snapshot.accountId !== account.id || snapshot.subject !== subject || offset >= snapshot.rows.length
          || !equalMac(mac, sign('cursor', id, offset)) || !scopeAllowed(account) || snapshot.context !== accountContext(account)) {
        return probeUnavailable('config_changed');
      }
      return { ok: true, ...page(snapshot, offset) };
    } catch (error) {
      if ([401, 403, 404].includes(error?.statusCode)) throw error;
      return probeUnavailable(categoryFor(error));
    }
  }
  function verifyPlan(account, ticket, { subject = '' } = {}) {
    const [expiry, mac, ...rest] = typeof ticket === 'string' && ticket.length < 100 ? ticket.split('.') : [];
    const expires = Number(expiry);
    if (rest.length || !/^\d{13}$/.test(expiry || '') || !/^[0-9a-f]{64}$/.test(mac || '')
        || expires <= clock() || expires > clock() + PLAN_TTL_MS) return false;
    return scopeAllowed(account) && equalMac(mac, sign('install', account.id, expires, accountContext(account), subject));
  }

  async function run(account, { mode = 'test', subject = '', scope: requestedScope, signal, authorize, assertOperational } = {}) {
    const timeout = AbortSignal.timeout(TEST_TIMEOUT_MS);
    const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let context;
    const guard = () => {
      operationSignal.throwIfAborted();
      authorize?.();
      assertOperational?.();
      if (context && accountContext(account, mode === 'plan') !== context) throw probeError('config_changed');
    };
    try {
      guard();
      if (!scopeAllowed(account)) return probeUnavailable('scope_denied');
      const scope = mode === 'plan' && requestedScope !== undefined ? checkedScope(requestedScope) : null;
      context = accountContext(account, mode === 'plan');
      const local = localConfig();
      const listOnly = mode !== 'plan';
      let source;
      const sourceStart = Date.now();
      try {
        assertSecureAccountEndpoint(account, getProvider(account.provider));
        const addresses = await abortable(() => resolvePublic(account.host), operationSignal);
        guard();
        const address = addresses.find(item => Number(item.family) === 4)?.address || addresses[0]?.address;
        if (!address) throw probeError('endpoint_rejected');
        source = await probeSide({ transport: transport(account.host, address, account.port, { secure: true }),
          auth: async () => account.auth_type === 'oauth2'
            ? { user: account.username, accessToken: await oauthToken(account, { signal: operationSignal, authorize }) }
            : { user: account.username, pass: secretForSource(account.id) } }, createClient, operationSignal, guard, listOnly, scope);
      } catch (error) {
        guard();
        source = { side: publicSide({ step: 'resolve', reason: error.probeCode || 'endpoint_rejected', elapsedMs: Date.now() - sourceStart }) };
      }
      guard();
      if (scope) {
        if (!scopeAllowed(account)) return probeUnavailable('scope_denied');
        const { ok, reason: category } = source.side;
        return { ok, mode: 'read_only', writeAccess: 'not_checked', category,
          message: ok ? '仅检查了指定的源目录范围，目标和整体同步影响未知' : messages[category] || messages.test_failed,
          source: source.side, target: publicSide(), folders: source.side.folders,
          ...(ok ? { plan: { status: 'partial', scope, rows: source.folders, targetState: 'unknown' } } : {}) };
      }
      const targetName = String(local.host);
      // Plain IMAP is confined to exact local addresses, including in the
      // presence of a misconfigured hosts file or DNS resolver.
      const targetHost = targetName.toLowerCase() === 'localhost' ? '127.0.0.1' : targetName.replace(/^\[(.*)]$/, '$1');
      const target = await probeSide({ transport: transport(targetName, targetHost, local.port, imapTransportOptions(local)),
        auth: () => ({ user: account.local_user, pass: secretForTarget(account.id) }) }, createClient, operationSignal, guard, listOnly);
      guard();
      if (target.side.ok) target.side.folders = targetScope(account, target.folders, target.namespace).folders.length;
      const ok = source.side.ok && target.side.ok;
      const category = source.side.reason || target.side.reason || null;
      const result = { ok, mode: 'read_only', writeAccess: 'not_checked', category,
        message: ok ? '两端连接及读取文件夹成功' : messages[category] || messages.test_failed,
        source: source.side, target: target.side, folders: source.side.folders };
      if (ok && mode === 'plan') {
        if (!scopeAllowed(account)) return probeUnavailable('scope_denied');
        const expires = clock() + PLAN_TTL_MS;
        const plan = syncImpact(account, source, target);
        result.plan = plan.status === 'estimate' ? makePlanPage(plan, account, context, subject, expires)
          : { ...plan, expiresAt: new Date(expires).toISOString() };
        if (!result.plan) return probeUnavailable('plan_limit');
      }
      return result;
    } catch (error) {
      if ([401, 403, 404].includes(error?.statusCode)) throw error;
      return probeUnavailable(categoryFor(error));
    }
  }
  return { run, readPage, verifyPlan };
}

let production;
function getProbe() {
  if (!production) {
    const { db } = require('./db');
    const { localDovecot } = require('./config');
    const { sourcePassPath, resolveTargetPassPath, oauthAuthorizationGeneration } = require('./credentials');
    const { ensureAccountOAuthToken } = require('./oauth-refresh');
    production = createAccountImapProbe({ database: db, localConfig: localDovecot,
      secretForSource: id => readSecret(sourcePassPath(id)), secretForTarget: id => readSecret(resolveTargetPassPath(id)),
      oauthGrant: oauthAuthorizationGeneration,
      oauthToken: async (account, options) => readSecret(await ensureAccountOAuthToken(account, options)) });
  }
  return production;
}

module.exports = { createAccountImapProbe, probeError, probeUnavailable,
  runAccountImapProbe: (...args) => getProbe().run(...args),
  readSyncPlanPage: (...args) => getProbe().readPage(...args), verifySyncPlan: (...args) => getProbe().verifyPlan(...args) };
