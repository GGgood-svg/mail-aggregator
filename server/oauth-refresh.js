'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { refreshOAuthTokens, isAccessTokenFresh } = require('./oauth-core');
const { accountGeneration } = require('./account-generation');
const { journalPresent } = require('./restore-journal');
const { withStateLock } = require('./state-lock');

const LEASE_MS = 90000;
const WAIT_MS = 35000;
const FAILED_COOLDOWN_MS = 5000;
const initialized = new WeakSet();
const messages = {
  authorization_required: 'OAuth2账号尚未授权，请重新授权',
  oauth_stale: '账号、授权或恢复状态已变化，请重新操作',
  oauth_busy: '账号正刷新授权，请稍后重试',
  invalid_grant: 'OAuth2授权已失效，请重新授权',
  invalid_client: 'OAuth2客户端配置未通过服务商验证',
  oauth_timeout: 'OAuth2令牌请求超时',
  oauth_network: '无法连接OAuth2令牌服务',
  oauth_request_failed: 'OAuth2令牌服务暂时不可用',
};

function oauthError(code) {
  const statusCode = ['oauth_stale', 'oauth_busy'].includes(code) ? 409 : 400;
  return Object.assign(new Error(messages[code] || messages.oauth_request_failed), { code, statusCode });
}

function credentialGeneration(tokens) {
  if (!tokens) return null;
  return tokens.tokenGeneration || digest(tokens);
}
function grantGeneration(tokens) { return tokens?.grantGeneration || (tokens ? 'legacy' : null); }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function initializeLeases(database) {
  if (initialized.has(database)) return;
  database.exec(`CREATE TABLE IF NOT EXISTS oauth_refresh_leases (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    lease TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    until_ms INTEGER NOT NULL,
    failure_code TEXT
  )`);
  initialized.add(database);
}

function createOAuthRefresh({
  database, root, clock = Date.now, sleep = delay, stateLock = withStateLock,
  loadClient = (...args) => require('./oauth-store').getOAuthClient(...args),
  loadTokens = (...args) => require('./credentials').readOAuthTokens(...args),
  persistTokens = (...args) => require('./credentials').saveOAuthTokens(...args),
  writeAccess = (...args) => require('./credentials').syncOAuthAccessFile(...args),
  refresh = refreshOAuthTokens, restorePending = journalPresent,
} = {}) {
  async function shortStateStep(work, until, signal) {
    for (;;) {
      signal?.throwIfAborted();
      let entered = false;
      try {
        return stateLock(root, () => {
          entered = true;
          if (restorePending(root)) throw oauthError('oauth_stale');
          return work();
        });
      } catch (error) {
        if (entered || error.statusCode !== 409) throw error;
        if (clock() >= until) throw oauthError('oauth_busy');
      }
      await sleep(150, undefined, { signal });
    }
  }

  return async function ensureAccountOAuthToken(account, { force = false, fetchImpl, authorize, signal } = {}) {
    const id = Number(account?.id);
    if (!Number.isSafeInteger(id) || id < 1) throw oauthError('authorization_required');
    const until = clock() + WAIT_MS;
    const owner = account.owner_user_id;
    const lease = randomUUID();
    let baseline;
    function snapshot() {
      authorize?.();
      const current = database.prepare(`SELECT a.* FROM accounts a JOIN admin_users u ON u.id=a.owner_user_id
        WHERE a.id=? AND u.enabled=1`).get(id);
      if (!current || (owner !== undefined && Number(owner) !== Number(current.owner_user_id)) || current.auth_type !== 'oauth2') {
        throw oauthError('oauth_stale');
      }
      const tokens = loadTokens(id);
      if (!tokens?.refreshToken) throw oauthError(baseline ? 'oauth_stale' : 'authorization_required');
      const client = loadClient(current.provider);
      const context = digest([accountGeneration(database, id), current.owner_user_id,
        current.username, current.provider, current.host, current.port, current.ssl, client, grantGeneration(tokens)]);
      const generation = credentialGeneration(tokens);
      return { current, client, tokens, context, generation, version: digest([context, generation]) };
    }
    let prepared;
    for (;;) {
      prepared = await shortStateStep(() => {
        initializeLeases(database);
        const current = snapshot();
        if (baseline && current.context !== baseline.context) throw oauthError('oauth_stale');
        baseline ||= { context: current.context, generation: current.generation };
        if (isAccessTokenFresh(current.tokens, clock()) && (!force || current.generation !== baseline.generation)) {
          return { path: writeAccess(id, current.tokens) };
        }
        const lock = database.prepare('SELECT * FROM oauth_refresh_leases WHERE account_id=?').get(id);
        if (lock?.until_ms > clock()) {
          if (!lock.failure_code) return null; // Another process is refreshing this account.
          if (lock.snapshot === current.version) throw oauthError(lock.failure_code);
        }
        database.prepare(`INSERT INTO oauth_refresh_leases(account_id,lease,snapshot,until_ms,failure_code) VALUES(?,?,?,?,NULL)
          ON CONFLICT(account_id) DO UPDATE SET lease=excluded.lease,snapshot=excluded.snapshot,
          until_ms=excluded.until_ms,failure_code=NULL`).run(id, lease, current.version, clock() + LEASE_MS);
        return current;
      }, until, signal);
      if (prepared?.path) return prepared.path;
      if (prepared) break;
      if (clock() >= until) throw oauthError('oauth_busy');
      await sleep(200, undefined, { signal });
    }

    let providerFailure, refreshed, retainedFailure = false;
    try {
      // The only network request happens outside the shared configuration lock.
      try {
        refreshed = await refresh({ accountProvider: prepared.current.provider, client: prepared.client,
          tokens: prepared.tokens, fetchImpl });
      } catch (error) {
        providerFailure = Object.hasOwn(messages, error?.code) ? error.code : 'oauth_request_failed';
      }
      // A disconnected caller does not throw away an already-rotated token. We
      // still require the same live account, authorization and restore generations.
      return await shortStateStep(() => {
        const current = snapshot();
        const held = database.prepare('SELECT lease,until_ms FROM oauth_refresh_leases WHERE account_id=?').get(id);
        if (held?.lease !== lease || held.until_ms <= clock() || current.version !== prepared.version) throw oauthError('oauth_stale');
        if (providerFailure) {
          database.prepare('UPDATE oauth_refresh_leases SET until_ms=?,failure_code=? WHERE account_id=? AND lease=?')
            .run(clock() + FAILED_COOLDOWN_MS, providerFailure, id, lease);
          retainedFailure = true;
          throw oauthError(providerFailure);
        }
        persistTokens(id, refreshed, { grantGeneration: grantGeneration(prepared.tokens) });
        return writeAccess(id, refreshed);
      }, clock() + WAIT_MS);
    } finally {
      if (!retainedFailure) {
        try { database.prepare('DELETE FROM oauth_refresh_leases WHERE account_id=? AND lease=?').run(id, lease); }
        catch (_) { /* A stale lease expires on its own; do not mask the credential outcome. */ }
      }
    }
  };
}

let refreshAccount;
function ensureAccountOAuthToken(account, options) {
  if (!refreshAccount) {
    const { db, DIRS } = require('./db');
    refreshAccount = createOAuthRefresh({ database: db, root: DIRS.root });
  }
  return refreshAccount(account, options);
}

module.exports = { ensureAccountOAuthToken, createOAuthRefresh, credentialGeneration, grantGeneration };
