const test = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedAddress, isLocalHostname, assertPublicImapHost, createPublicLookup, assertSecureAccountEndpoint } = require('../server/network-policy');

test('network policy blocks local, private, metadata, documentation, and mapped addresses', () => {
  for (const address of ['0.0.0.1', '10.2.3.4', '127.0.0.1', '169.254.169.254',
    '172.20.1.1', '192.168.50.150', '198.51.100.2', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
  assert.equal(isLocalHostname('localhost'), true);
  assert.equal(isLocalHostname('mail.local.'), true);
});

test('runtime DNS policy rejects any hostname answer that reaches a private network', async () => {
  await assert.rejects(
    assertPublicImapHost('mail.example', async () => [
      { address: '203.0.113.8', family: 4 },
      { address: '192.168.1.8', family: 4 },
    ]),
    /解析到了/
  );
  await assert.doesNotReject(assertPublicImapHost('mail.example', async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]));
  await assert.rejects(assertPublicImapHost('localhost', async () => []), /不能指向/);
});

test('runtime account policy rejects legacy plaintext and redirected provider records', () => {
  const preset = { host: 'imap.qq.com', port: 993, ssl: true, auth_type: 'password' };
  assert.doesNotThrow(() => assertSecureAccountEndpoint({
    provider: 'qq', host: 'IMAP.QQ.COM.', port: 993, ssl: 1, auth_type: 'password',
  }, preset));
  assert.throws(() => assertSecureAccountEndpoint({
    provider: 'custom', host: 'imap.example.com', port: 143, ssl: 0, auth_type: 'password',
  }), /SSL\/TLS/);
  assert.throws(() => assertSecureAccountEndpoint({
    provider: 'qq', host: 'attacker.example', port: 993, ssl: 1, auth_type: 'password',
  }, preset), /已被篡改/);
  assert.throws(() => assertSecureAccountEndpoint({
    provider: 'qq', host: 'imap.qq.com', port: 993, ssl: 1, auth_type: 'oauth2',
  }, preset), /已被篡改/);
});

test('HTTPS lookup pins only DNS answers that pass the public-address policy', async () => {
  const callLookup = (lookup) => new Promise((resolve, reject) => {
    lookup('hooks.example', { family: 0 }, (error, address, family) => error ? reject(error) : resolve({ address, family }));
  });
  const safe = createPublicLookup(async () => [{ address: '8.8.8.8', family: 4 }], '通知服务器');
  assert.deepEqual(await callLookup(safe), { address: '8.8.8.8', family: 4 });
  const privateLookup = createPublicLookup(async () => [{ address: '127.0.0.1', family: 4 }], '通知服务器');
  await assert.rejects(callLookup(privateLookup), /拒绝连接/);
});
