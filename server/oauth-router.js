const { stateRoute, asyncRoute, withStateLock } = require('./state-lock');
const { assertCurrentUser } = require('./auth');
const express = require('express');
const crypto = require('crypto');
const { db, DIRS } = require('./db');
const {
  createPkce,
  createOAuthState,
  oauthProviderForAccount,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
} = require('./oauth-core');
const {
  publicBaseUrl,
  publicOAuthConfig,
  saveOAuthConfig,
  getOAuthClient,
} = require('./oauth-store');
const { saveOAuthTokens, oauthAuthorizationGeneration } = require('./credentials');
const { accountGeneration } = require('./account-generation');

const router = express.Router();
const FLOW_TTL_MS = 10 * 60 * 1000;

const saveFlow = db.transaction((sid, flow) => {
  const now = Date.now();
  db.prepare('DELETE FROM oauth_flows WHERE expires<=?').run(now);
  const count = db.prepare('SELECT count(*) AS total FROM oauth_flows WHERE sid=?').get(sid).total;
  if (count >= 8) return false;
  db.prepare('INSERT INTO oauth_flows VALUES(?,?,?,?,?,?)').run(sid, flow.state,
    flow.oauthProvider, flow.ownerUserId, now + FLOW_TTL_MS, JSON.stringify(flow));
  return true;
});

const consumeFlow = db.transaction((sid, state, provider, userId) => {
  const flow = db.prepare('SELECT flow FROM oauth_flows WHERE sid=? AND state=? AND provider=? AND owner_user_id=? AND expires>?')
    .get(sid, state, provider, userId, Date.now());
  if (!flow) return null;
  db.prepare('DELETE FROM oauth_flows WHERE sid=? AND state=?').run(sid, state);
  return JSON.parse(flow.flow);
});

function clientRevision(client) {
  return crypto.createHash('sha256').update(JSON.stringify(client)).digest('hex');
}

function callbackUri(baseUrl, oauthProvider) {
  return `${baseUrl}/api/oauth/callback/${oauthProvider}`;
}

router.get('/config', (req, res) => {
  if (req.user.role !== 'admin' || !req.user.mail_access_all) return res.status(403).json({ error: '仅主管理员可以查看OAuth2系统配置' });
  try { res.json(publicOAuthConfig()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/config', stateRoute((req, res) => {
  if (req.user.role !== 'admin' || !req.user.mail_access_all) return res.status(403).json({ error: '仅主管理员可以修改OAuth2系统配置' });
  try { res.json({ ok: true, ...saveOAuthConfig(req.body || {}) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
}));

router.post('/accounts/:id/start', stateRoute((req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id=? AND owner_user_id=?').get(req.params.id, req.user.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });
  if (account.auth_type !== 'oauth2') return res.status(400).json({ error: '该账号未使用OAuth2' });
  const active = db.prepare("SELECT 1 FROM sync_jobs WHERE account_id=? AND status IN ('queued','running')").get(account.id);
  if (active) return res.status(409).json({ error: '账号正在同步或排队中，结束任务后才能重新授权' });

  try {
    const oauthProvider = oauthProviderForAccount(account.provider);
    const baseUrl = publicBaseUrl();
    if (!baseUrl) throw new Error('请先在设置页配置OAuth2公开地址和客户端凭据');
    const client = getOAuthClient(account.provider);
    const state = createOAuthState();
    const { verifier, challenge } = createPkce();
    const redirectUri = callbackUri(baseUrl, oauthProvider);
    const flow = {
      state,
      verifier,
      accountId: account.id,
      accountProvider: account.provider,
      oauthProvider,
      redirectUri,
      ownerUserId: req.user.id,
      configGeneration: accountGeneration(db, account.id),
      authorizationGeneration: oauthAuthorizationGeneration(account.id),
      clientRevision: clientRevision(client),
    };
    const authorizationUrl = buildAuthorizationUrl({
      accountProvider: account.provider,
      clientId: client.clientId,
      tenant: client.tenant,
      redirectUri,
      state,
      codeChallenge: challenge,
      loginHint: account.username,
    });
    if (!saveFlow(req.sessionID, flow)) return res.status(429).json({ error: '待完成的授权过多，请完成已有授权或稍后再试。' });
    res.set('Cache-Control', 'no-store').json({ authorizationUrl, redirectUri });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}));

router.get('/callback/:provider', asyncRoute(async (req, res) => {
  const state = req.query.state;
  const flow = typeof state === 'string' && /^[A-Za-z0-9_-]{43}$/.test(state)
    ? withStateLock(DIRS.root, () => consumeFlow(req.sessionID, state, req.params.provider, assertCurrentUser(req).id))
    : null;
  if (!flow) return res.status(400).send('OAuth2授权状态无效或已过期，请返回账号页面重新授权。');

  const redirect = (status, message = '') => {
    const params = new URLSearchParams({ oauth: status });
    if (message) params.set('message', String(message).replace(/[\r\n\0]/g, ' ').slice(0, 300));
    res.redirect(`/account-edit.html?id=${flow.accountId}&${params}`);
  };

  if (req.query.error) return redirect('error', '授权未完成，请在账号页面重新授权');
  if (typeof req.query.code !== 'string' || !req.query.code) return redirect('error', '授权服务器没有返回授权码');

  try {
    const prepared = withStateLock(DIRS.root, () => {
      const actor = assertCurrentUser(req);
      if (Number(actor.id) !== Number(flow.ownerUserId)) throw new Error('授权用户已变更');
      const account = db.prepare('SELECT * FROM accounts WHERE id=? AND owner_user_id=?').get(flow.accountId, actor.id);
      if (!account || account.auth_type !== 'oauth2' || account.provider !== flow.accountProvider) throw new Error('账号已删除或认证方式已经改变');
      if (db.prepare("SELECT 1 FROM sync_jobs WHERE account_id=? AND status IN ('queued','running')").get(account.id)) throw new Error('账号正在同步或排队中');
      const client = getOAuthClient(account.provider);
      if (accountGeneration(db, account.id) !== flow.configGeneration
          || oauthAuthorizationGeneration(account.id) !== flow.authorizationGeneration
          || clientRevision(client) !== flow.clientRevision
          || callbackUri(publicBaseUrl(), flow.oauthProvider) !== flow.redirectUri) throw new Error('账号或授权配置已变化，请重新授权');
      return { actor, account, client, baseUrl: publicBaseUrl() };
    });
    const { account, client } = prepared;
    const tokens = await exchangeAuthorizationCode({
      accountProvider: account.provider,
      client,
      redirectUri: flow.redirectUri,
      code: req.query.code,
      codeVerifier: flow.verifier,
    });
    withStateLock(DIRS.root, () => {
      assertCurrentUser(req, prepared.actor);
      const current = db.prepare('SELECT * FROM accounts WHERE id=? AND owner_user_id=?').get(account.id, prepared.actor.id);
      if (!current || accountGeneration(db, account.id) !== flow.configGeneration
          || oauthAuthorizationGeneration(account.id) !== flow.authorizationGeneration
          || clientRevision(getOAuthClient(current.provider)) !== flow.clientRevision || publicBaseUrl() !== prepared.baseUrl) throw new Error('账号或授权配置已变化，请重新授权');
      if (db.prepare("SELECT 1 FROM sync_jobs WHERE account_id=? AND status IN ('queued','running')").get(account.id)) throw new Error('账号正在同步或排队中');
      saveOAuthTokens(account.id, tokens);
      db.prepare("UPDATE accounts SET updated_at=datetime('now') WHERE id=?").run(account.id);
    });
    redirect('success');
  } catch (error) {
    console.error(`[oauth] 授权回调失败: ${String(error.message).replace(/[\r\n]/g, ' ').slice(0, 400)}`);
    redirect('error', error.message);
  }
}));

module.exports = router;
