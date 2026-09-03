const path = require('path');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function oauthRefreshCommand(accountId, {
  nodePath = process.execPath,
  scriptPath = path.join(__dirname, 'cli-refresh-oauth.js'),
} = {}) {
  if (!Number.isSafeInteger(Number(accountId)) || Number(accountId) < 1) {
    throw new Error('OAuth2账号ID无效');
  }
  return `${shellQuote(nodePath)} ${shellQuote(scriptPath)} ${Number(accountId)}`;
}

function applySourceAuthentication(args, account, options = {}) {
  const credentials = options.credentials || require('./credentials');
  if (account.auth_type === 'oauth2') {
    args.push(
      '--oauthaccesstoken1', credentials.oauthAccessTokenPath(account.id),
      '--oauthrefreshcmd1', oauthRefreshCommand(account.id, options),
      '--authmech1', 'XOAUTH2',
      '--notrylogin'
    );
  } else {
    args.push('--passfile1', credentials.sourcePassPath(account.id));
  }
  return args;
}

module.exports = { shellQuote, oauthRefreshCommand, applySourceAuthentication };
