'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { imapQuote } = require('../server/cli-imap-login-check');

test('installer IMAP login check safely quotes credentials', () => {
  assert.equal(imapQuote('plain'), '"plain"');
  assert.equal(imapQuote('space and "quote" \\ slash'), '"space and \\"quote\\" \\\\ slash"');
  assert.throws(() => imapQuote('line\r\nbreak'), /forbidden control character/);
});
