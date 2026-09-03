const test = require('node:test');
const assert = require('node:assert/strict');

const { applySourceAuthentication, oauthRefreshCommand } = require('../server/imapsync-auth');

const credentials = {
  sourcePassPath: (id) => `/secrets/${id}/source.pass`,
  oauthAccessTokenPath: (id) => `/secrets/${id}/oauth-access.token`,
};

test('password authentication uses only a protected passfile path', () => {
  const args = applySourceAuthentication([], { id: 7, auth_type: 'password' }, { credentials });
  assert.deepEqual(args, ['--passfile1', '/secrets/7/source.pass']);
});

test('OAuth authentication exposes only token-file and refresh-command paths', () => {
  const args = applySourceAuthentication([], { id: 7, auth_type: 'oauth2' }, {
    credentials,
    nodePath: '/usr/bin/node',
    scriptPath: '/opt/mail-aggregator/server/cli-refresh-oauth.js',
  });
  assert.deepEqual(args, [
    '--oauthaccesstoken1', '/secrets/7/oauth-access.token',
    '--oauthrefreshcmd1', "'/usr/bin/node' '/opt/mail-aggregator/server/cli-refresh-oauth.js' 7",
    '--authmech1', 'XOAUTH2',
    '--notrylogin',
  ]);
  assert.equal(args.join(' ').includes('access-token-value'), false);
});

test('OAuth refresh command safely quotes fixed executable paths', () => {
  assert.equal(
    oauthRefreshCommand(9, { nodePath: "/opt/node's/bin/node", scriptPath: '/app/refresh.js' }),
    "'/opt/node'\"'\"'s/bin/node' '/app/refresh.js' 9"
  );
  assert.throws(() => oauthRefreshCommand('../1'), /账号ID无效/);
});
