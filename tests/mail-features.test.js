const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable, Writable, PassThrough } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { once } = require('node:events');
const { createMailRouter, MAX_MESSAGE_BYTES } = require('../server/mail-reader');
const { searchCriteria, safeFilename, attachmentParts, downloadLimiter, MAX_DOWNLOAD_BYTES } = require('../server/mail-tools');

const structure = { type: 'multipart/mixed', childNodes: [
  { part: '1', type: 'text/plain', size: 4 },
  { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: '季度报告.pdf' }, size: 9 },
] };
async function fixture(t, customize = {}) {
  const calls = [], streams = [];
  const source = Buffer.from('Subject: original\r\nX-Test: preserve\r\n\r\nraw\x00bytes\r\n');
  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = { id: Number(req.get('x-test-user') || 1) }; next(); });
  app.use(createMailRouter({
    mailAccessForRequest: () => ({ roots: ['U1-A1'], all: false }),
    createClient: () => ({ usable: true,
      async connect() { calls.push('connect'); }, async logout() { calls.push('logout'); }, close() { calls.push('close'); },
      async mailboxOpen(folder, options) { calls.push(['open', folder, options]); return { uidValidity: 77n, exists: 3 }; },
      async fetchOne(uid, query) {
        calls.push(['fetch', uid, query]);
        if (uid !== 7) return false;
        if (query.source) return { source: Buffer.from('Subject: small\r\n\r\nhello') };
        return { uid, size: 55, envelope: { subject: '测试原件' }, flags: new Set(), bodyStructure: structure };
      },
      async search(query) { calls.push(['search', query]); return [3, 7]; },
      async fetchAll(uids) { return uids.map(uid => ({ uid, envelope: {}, flags: new Set() })); },
      async download(uid, part, options) {
        calls.push(['download', uid, part, options]);
        const content = Readable.from(part ? [Buffer.from('%PDF-test')] : [source.subarray(0, 10), source.subarray(10)]);
        streams.push(content); return { content, meta: {} };
      },
      ...customize,
    }),
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { streams.forEach(s => s.destroy()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, calls, source, streams };
}
const query = '?folder=U1-A1.INBOX&uidValidity=77';

test('mail search combines text, received-date and seen filters with an inclusive end day', () => {
  const criteria = searchCriteria({ from: ' sender@example.org ', subject: '季度', since: '2024-02-29', until: '2024-02-29', seen: 'unread' });
  assert.equal(criteria.from, 'sender@example.org'); assert.equal(criteria.subject, '季度'); assert.equal(criteria.seen, false);
  assert.equal(criteria.since.toISOString(), '2024-02-29T00:00:00.000Z'); assert.equal(criteria.before.toISOString(), '2024-03-01T00:00:00.000Z');
  for (const input of [{ since: '2025-02-29' }, { since: '2025-03-02', until: '2025-03-01' }, { from: ['a', 'b'] }, { subject: 'bad\r\n' }, { subject: 'a'.repeat(201) }, { seen: 'maybe' }]) assert.throws(() => searchCriteria(input), { statusCode: 400 });
});

test('attachment enumeration excludes message body and sanitizes unsafe filenames', () => {
  assert.deepEqual(attachmentParts(structure).map(item => item.part), ['2']);
  assert.equal(attachmentParts(structure)[0].filename, '季度报告.pdf');
  const forwarded = { part: '3', type: 'message/rfc822', disposition: 'attachment', childNodes: structure.childNodes };
  assert.deepEqual(attachmentParts(forwarded).map(item => item.part), ['3']);
  const safe = safeFilename('../bad\\name\r\n\u202E.exe');
  assert.doesNotMatch(safe, /[\\/\r\n\u202E]/); assert.ok(!safe.startsWith('.'));
  assert.equal(safeFilename('CON.txt'), '_CON.txt'); assert.equal(safeFilename(''), 'attachment');
});

test('search endpoint uses IMAP criteria and returns matching result counts', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/messages' + query + '&from=alice&subject=report&seen=read&since=2025-01-01&pageSize=1');
  assert.equal(response.status, 200); const data = await response.json();
  assert.equal(data.total, 2); assert.equal(data.mailboxTotal, 3); assert.equal(data.hasMore, true);
  const criteria = f.calls.find(call => call[0] === 'search')[1];
  assert.equal(criteria.from, 'alice'); assert.equal(criteria.subject, 'report'); assert.equal(criteria.seen, true);
  assert.equal(criteria.since.toISOString(), '2025-01-01T00:00:00.000Z');
  const connects = f.calls.filter(call => call === 'connect').length;
  assert.equal((await fetch(f.base + '/messages' + query + '&since=not-a-date')).status, 400);
  assert.equal(f.calls.filter(call => call === 'connect').length, connects);
});

test('EML export preserves raw bytes and attachment download sends a safe Unicode filename', async t => {
  const f = await fixture(t);
  let response = await fetch(f.base + '/messages/7/export' + query);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.source);
  assert.match(response.headers.get('content-disposition'), /attachment;.*\.eml/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  response = await fetch(f.base + '/messages/7/attachments/2/download' + query);
  assert.equal(response.status, 200); assert.equal(await response.text(), '%PDF-test');
  assert.ok(response.headers.get('content-disposition').includes(encodeURIComponent('季度报告.pdf')));
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(f.calls.filter(call => call[0] === 'open').every(call => call[2].readOnly));
});

test('download rejects cross-user folders, stale UIDs, missing attachments and body-part guessing', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/messages/7/export?folder=U2-A2.INBOX&uidValidity=77')).status, 404);
  assert.equal(f.calls.length, 0);
  assert.equal((await fetch(f.base + '/messages/7/export?folder=U1-A1.INBOX')).status, 400);
  assert.equal((await fetch(f.base + '/messages/7/export?folder=U1-A1.INBOX&uidValidity=78')).status, 409);
  assert.equal((await fetch(f.base + '/messages/8/export' + query)).status, 404);
  assert.equal((await fetch(f.base + '/messages/7/attachments/1/download' + query)).status, 404);
  assert.equal((await fetch(f.base + '/messages/7/attachments/HEADER/download' + query)).status, 400);
  assert.ok(!f.calls.some(call => call[0] === 'download'));
});

test('large messages retain attachment actions without fetching the full source', async t => {
  const f = await fixture(t, { async fetchOne(uid, fields) {
    assert.equal(fields.source, undefined); return { uid, size: MAX_MESSAGE_BYTES + 1, envelope: {}, flags: new Set(), bodyStructure: structure };
  } });
  const response = await fetch(f.base + '/messages/7' + query); assert.equal(response.status, 200);
  const { message } = await response.json(); assert.equal(message.bodyOmitted, true); assert.equal(message.attachments[0].part, '2');
});

test('download has metadata and streamed byte limits, including dishonest advertised sizes', async t => {
  const f = await fixture(t, { async fetchOne() { return { size: MAX_DOWNLOAD_BYTES + 1 }; } });
  assert.equal((await fetch(f.base + '/messages/7/export' + query)).status, 413);
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(4), Buffer.alloc(3)]), downloadLimiter(6), new Writable({ write(c, e, cb) { cb(); } })), { statusCode: 413 });
});

test('concurrent downloads are bounded per user and disconnected clients release their slots', async t => {
  const live = [];
  const f = await fixture(t, { async download() {
    const content = new PassThrough(); live.push(content);
    setImmediate(() => content.write('partial'));
    return { content, meta: {} };
  } });
  t.after(() => live.forEach(stream => stream.destroy()));
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  const first = await fetch(f.base + '/messages/7/export' + query, { signal: firstAbort.signal });
  const second = await fetch(f.base + '/messages/7/export' + query, { signal: secondAbort.signal });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal((await fetch(f.base + '/messages/7/export' + query)).status, 429);
  const thirdAbort = new AbortController(), fourthAbort = new AbortController();
  const third = await fetch(f.base + '/messages/7/export' + query, { headers: { 'x-test-user': '2' }, signal: thirdAbort.signal });
  const fourth = await fetch(f.base + '/messages/7/export' + query, { headers: { 'x-test-user': '2' }, signal: fourthAbort.signal });
  assert.equal(third.status, 200); assert.equal(fourth.status, 200);
  assert.equal((await fetch(f.base + '/messages/7/export' + query, { headers: { 'x-test-user': '3' } })).status, 429);
  firstAbort.abort(); secondAbort.abort();
  thirdAbort.abort(); fourthAbort.abort();
  for (let i = 0; i < 50 && !live.every(stream => stream.destroyed); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(live.every(stream => stream.destroyed));
});
