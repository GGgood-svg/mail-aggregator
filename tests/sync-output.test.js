const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSummary, categorizeTestError } = require('../server/sync-output');

test('parseSummary extracts all supported imapsync counters, including zero', () => {
  const output = `
Host1 Nb folders: 12 folders
Host2 Nb folders: 10 folders
Host1 Nb messages: 345 messages
Host2 Nb messages: 340 messages
Messages transferred : 5
Messages skipped : 0
Detected 0 errors
`;

  assert.deepEqual(parseSummary(output), {
    host1Messages: 345,
    host2Messages: 340,
    host1Folders: 12,
    host2Folders: 10,
    messagesTransferred: 5,
    messagesSkipped: 0,
    errors: 0,
  });
});

test('parseSummary returns null for counters absent from output', () => {
  assert.deepEqual(parseSummary('Messages transferred : 2'), {
    host1Messages: null,
    host2Messages: null,
    host1Folders: null,
    host2Folders: null,
    messagesTransferred: 2,
    messagesSkipped: null,
    errors: null,
  });
});

test('parseSummary reconstructs totals from imapsync 2.290 per-folder output', () => {
  const output = `
Host1: folder [INBOX] has 4868 messages in total (mentioned by SELECT)
Host2: folder [QQ.INBOX] has 4868 messages in total (mentioned by SELECT)
Host1: folder [Drafts] has 4 messages in total (mentioned by SELECT)
Host2: folder [QQ.Drafts] has 4 messages in total (mentioned by SELECT)
Host2: folder [QQ.INBOX] has 4868 messages in total (mentioned by SELECT)
Messages transferred : 0
Messages skipped : 4872
Detected 0 errors
`;
  assert.deepEqual(parseSummary(output), {
    host1Messages: 4872,
    host2Messages: 4872,
    host1Folders: 2,
    host2Folders: 2,
    messagesTransferred: 0,
    messagesSkipped: 4872,
    errors: 0,
  });
});

test('categorizeTestError gives timeout precedence over process output', () => {
  assert.equal(categorizeTestError('SSL authentication failed', true).category, 'timeout');
});

test('categorizeTestError recognizes common failure classes', () => {
  const cases = [
    ['TLS handshake failed', 'tls_failed'],
    ['LOGIN failed: bad password', 'auth_failed'],
    ['connection refused', 'network_unreachable'],
    ['could not list mailbox folders', 'folder_failed'],
    ['unexpected imapsync failure', 'unknown'],
  ];

  for (const [output, expected] of cases) {
    assert.equal(categorizeTestError(output, false).category, expected);
  }
});
