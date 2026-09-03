const express = require('express');
const crypto = require('crypto');
const { db } = require('./db');
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
const { saveOAuthTokens } = require('./credentials');

const router = express.Router();
const FLOW_TTL_MS = 10 * 60 * 1000;

function safeStateEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function callbackUri(baseUrl, oauthProvider) {
  return `${baseUrl}/api/oauth/callback/${oauthProvider}`;
}

router.get('/config', (req, res) => {
  try { res.json(publicOAuthConfig()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/config', (req, res) => {
  try { res.json({ ok: true, ...saveOAuthConfig(req.body || {}) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/accounts/:id/start', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
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
    req.session.oauthFlow = {
      state,
      verifier,
      accountId: account.id,
      accountProvider: account.provider,
      oauthProvider,
      redirectUri,
      createdAt: Date.now(),
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
    res.json({ authorizationUrl, redirectUri });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/callback/:provider', async (req, res) => {
  const flow = req.session.oauthFlow;
  delete req.session.oauthFlow;
  if (!flow
    || flow.oauthProvider !== req.params.provider
    || Date.now() - flow.createdAt > FLOW_TTL_MS
    || !safeStateEqual(req.query.state, flow.state)) {
    return res.status(400).send('OAuth2授权状态无效或已过期，请返回账号页面重新授权。');
  }

  const redirect = (status, message = '') => {
    const params = new URLSearchParams({ oauth: status });
    if (message) params.set('message', String(message).replace(/[\r\n\0]/g, ' ').slice(0, 300));
    res.redirect(`/account-edit.html?id=${flow.accountId}&${params}`);
  };

  if (req.query.error) return redirect('error', req.query.error_description || req.query.error);
  if (typeof req.query.code !== 'string' || !req.query.code) return redirect('error', '授权服务器没有返回授权码');

  try {
    const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(flow.accountId);
    if (!account || account.auth_type !== 'oauth2' || account.provider !== flow.accountProvider) {
      throw new Error('账号已删除或认证方式已经改变');
    }
    const active = db.prepare("SELECT 1 FROM sync_jobs WHERE account_id=? AND status IN ('queued','running')").get(account.id);
    if (active) throw new Error('账号正在同步或排队中，授权结果未写入，请结束任务后重试');
    const client = getOAuthClient(account.provider);
    const tokens = await exchangeAuthorizationCode({
      accountProvider: account.provider,
      client,
      redirectUri: flow.redirectUri,
      code: req.query.code,
      codeVerifier: flow.verifier,
    });
    saveOAuthTokens(account.id, tokens);
    db.prepare("UPDATE accounts SET updated_at=datetime('now') WHERE id=?").run(account.id);
    redirect('success');
  } catch (error) {
    console.error(`[oauth] 授权回调失败: ${String(error.message).replace(/[\r\n]/g, ' ').slice(0, 400)}`);
    redirect('error', error.message);
  }
});

module.exports = router;
