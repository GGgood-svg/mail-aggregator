const test = require('node:test');
const assert = require('node:assert/strict');
const { applySourceTransport } = require('../server/source-transport');

test('source IMAP transport requires TLS and peer certificate verification', () => {
  const args = applySourceTransport([], { ssl: 1 });
  assert.deepEqual(args, ['--ssl1', '--sslargs1', 'SSL_verify_mode=1']);
  assert.throws(() => applySourceTransport([], { ssl: 0 }), /SSL\/TLS/);
});
