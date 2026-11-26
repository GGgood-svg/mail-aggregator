const test = require('node:test');
const assert = require('node:assert/strict');
const { categorizeSyncFailure } = require('../server/sync-output');

test('sync diagnostics classify actual failures without treating routine login output as failure', () => {
  assert.equal(categorizeSyncFailure('Host1 login authentication successful', 'failed'), 'unknown');
  assert.equal(categorizeSyncFailure('AUTHENTICATIONFAILED invalid credentials', 'failed'), 'auth_failed');
  assert.equal(categorizeSyncFailure('network is unreachable', 'failed'), 'network');
  assert.equal(categorizeSyncFailure('无法解析源 IMAP 服务器地址', 'failed'), 'network');
  assert.equal(categorizeSyncFailure('源 IMAP 服务器解析到了本机、局域网或保留地址，已拒绝连接', 'failed'), 'unknown');
  assert.equal(categorizeSyncFailure('certificate verify failed', 'failed'), 'tls_failed');
  assert.equal(categorizeSyncFailure('login failed', 'timed_out'), 'timeout');
});

const { parseSummary, createOutputCollector, categorizeTestError } = require('../server/sync-output');

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

test('streaming collector keeps bounded diagnostics and counters split across chunks', () => {
  const collector = createOutputCollector({ tailChars: 64 });
  collector.push(`Host1: folder [INBOX] has 10 messages in total\n${'noise'.repeat(40)}\nMess`, 'stdout');
  collector.push('ages transferred : 3\n', 'stdout');
  collector.push('Detected 0 er', 'stderr');
  collector.push('rors\n', 'stderr');
  const result = collector.finish();
  assert.equal(result.summary.host1Messages, 10);
  assert.equal(result.summary.host1Folders, 1);
  assert.equal(result.summary.messagesTransferred, 3);
  assert.equal(result.summary.errors, 0);
  assert.ok(result.tail.length <= 64);
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


test('only explicit source IMAP throttling is kept as cooldown evidence, even after the tail rotates', () => {
  const source = 'Host1 failure: Error login on [imap.example]: NO [LIMIT] Too many simultaneous connections';
  const target = 'Host2 failure: Error login on [target.example]: NO [LIMIT] Too many simultaneous connections';
  assert.equal(categorizeSyncFailure(source, 'failed'), 'provider_rate_limited');
  assert.equal(categorizeSyncFailure(target, 'failed'), 'unknown');
  assert.equal(categorizeSyncFailure('Host1: folder [RATE-LIMIT] has 7 messages in total', 'failed'), 'unknown');
  assert.equal(categorizeSyncFailure(source, 'timed_out'), 'timeout');
  assert.equal(parseSummary(source + '\nMessages transferred : 1').messagesTransferred, 1);
  const collector = createOutputCollector({ tailChars: 30 });
  collector.push(source.slice(0, 48), 'stderr'); collector.push(source.slice(48) + '\n', 'stderr');
  collector.push('Unrelated log output. '.repeat(20));
  const { tail, sourceRateLimited } = collector.finish();
  assert.doesNotMatch(tail, /Host1/);
  assert.equal(categorizeSyncFailure(tail, 'failed', sourceRateLimited), 'provider_rate_limited');
});
