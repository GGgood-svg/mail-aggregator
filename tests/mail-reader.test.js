const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { simpleParser } = require('mailparser');

const {
  parsePositiveInteger,
  validateMailboxPath,
  calculateSequenceRange,
  formatAddresses,
  toIsoString,
  imapTransportOptions,
  sanitizeMessageHtml,
  serializeSummary,
  serializeParsedMessage,
  createMailRouter,
} = require('../server/mail-reader');

test('mail query numbers are strict and bounded', () => {
  assert.equal(parsePositiveInteger('2', 1), 2);
  assert.equal(parsePositiveInteger('999', 1, 50), 50);
  assert.equal(parsePositiveInteger('1x', 1), 1);
  assert.equal(parsePositiveInteger('-1', 1), 1);
  assert.equal(parsePositiveInteger('', 1), 1);
});

test('mailbox path accepts unicode but rejects command separators', () => {
  assert.equal(validateMailboxPath('归档/工作'), '归档/工作');
  assert.equal(validateMailboxPath(undefined), 'INBOX');
  assert.throws(() => validateMailboxPath('INBOX\r\nBAD'), /不合法/);
  assert.throws(() => validateMailboxPath('x'.repeat(513)), /不合法/);
});

test('pagination calculates newest-first IMAP sequence windows', () => {
  assert.equal(calculateSequenceRange(75, 1, 30), '46:75');
  assert.equal(calculateSequenceRange(75, 2, 30), '16:45');
  assert.equal(calculateSequenceRange(75, 3, 30), '1:15');
  assert.equal(calculateSequenceRange(75, 4, 30), null);
  assert.equal(calculateSequenceRange(0, 1, 30), null);
});

test('address and message summaries expose only display fields', () => {
  assert.equal(formatAddresses([{ name: 'Alice', address: 'a@example.com' }, { address: 'b@example.com' }]), 'Alice <a@example.com>, b@example.com');
  assert.deepEqual(serializeSummary({
    uid: 9,
    envelope: { subject: 'Hello', from: [{ address: 'a@example.com' }], date: new Date('2026-01-02T03:04:05Z') },
    flags: new Set(['\\Seen', '\\Flagged']),
    size: 123,
  }), {
    uid: 9,
    subject: 'Hello',
    from: 'a@example.com',
    to: '',
    date: '2026-01-02T03:04:05.000Z',
    size: 123,
    seen: true,
    flagged: true,
  });
});

test('invalid message dates do not break an entire mailbox page', () => {
  assert.equal(toIsoString('not-a-date'), null);
  assert.equal(serializeSummary({ uid: 1, envelope: { date: 'bad' } }).date, null);
});

test('IMAP transport keeps loopback local and requires encryption off-host', () => {
  assert.deepEqual(imapTransportOptions({ host: '127.0.0.1', port: 143 }), { secure: false, doSTARTTLS: false });
  assert.deepEqual(imapTransportOptions({ host: 'localhost', port: 1143 }), { secure: false, doSTARTTLS: false });
  assert.deepEqual(imapTransportOptions({ host: 'imap.example.com', port: 143 }), { secure: false, doSTARTTLS: true });
  assert.deepEqual(imapTransportOptions({ host: 'imap.example.com', port: 993 }), { secure: true });
});

test('message HTML preserves safe layout and images without auto-loading remote content', () => {
  const details = {};
  const clean = sanitizeMessageHtml(`
    <style>body{display:none}</style><script>alert(1)</script>
    <form action="https://evil.example"><input name="password"></form>
    <p style="color:#123456; margin:8px; position:fixed; background-image:url(https://tracker.example/bg)" onclick="alert(2)">Safe
    <img src="data:image/png;base64,AAAA" alt="inline"><img src="https://tracker.example/pixel" width="600" alt="remote">
    <a href="javascript:alert(3)">bad</a> <a href="https://example.com">good</a></p>
  `, details);
  assert.doesNotMatch(clean, /script|<form|<input|onclick|position|background-image|javascript:/i);
  assert.match(clean, /style="[^"]*color:\s*#123456/i);
  assert.match(clean, /src="data:image\/png;base64,AAAA"/i);
  assert.match(clean, /data-remote-src="https:\/\/tracker\.example\/pixel"/i);
  assert.doesNotMatch(clean, /<img[^>]*\ssrc="https:\/\/tracker\.example\/pixel"/i);
  assert.equal(details.remoteImageCount, 1);
  assert.match(clean, /href="https:\/\/example\.com"/);
  assert.match(clean, /target="_blank"/);
  assert.match(clean, /rel="noopener noreferrer"/);
});

test('parsed message returns attachment metadata without attachment contents', () => {
  const result = serializeParsedMessage(
    { uid: 3, envelope: {}, flags: new Set(), size: 42 },
    {
      subject: 'Report',
      from: { text: 'Sender <sender@example.com>' },
      text: 'body',
      html: '<b>body</b>',
      attachments: [{ filename: 'report.pdf', contentType: 'application/pdf', size: 2048, content: Buffer.from('secret') }],
    }
  );
  assert.equal(result.attachments[0].filename, 'report.pdf');
  assert.equal(result.attachments[0].size, 2048);
  assert.equal(Object.hasOwn(result.attachments[0], 'content'), false);
  assert.equal(result.remoteImageCount, 0);
});

test('multipart CID images become safe embedded data images', async () => {
  const raw = [
    'Subject: CID image',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="mail-boundary"',
    '',
    '--mail-boundary',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<table style="width:600px; background-color:#ffffff"><tr><td><img src="cid:logo-image" width="120"></td></tr></table>',
    '--mail-boundary',
    'Content-Type: image/png; name="logo.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <logo-image>',
    'Content-Disposition: inline; filename="logo.png"',
    '',
    'iVBORw0KGgo=',
    '--mail-boundary--',
    '',
  ].join('\r\n');
  const parsed = await simpleParser(Buffer.from(raw));
  const result = serializeParsedMessage({ uid: 7, envelope: {}, flags: new Set(), size: raw.length }, parsed);
  assert.match(result.html, /<table style="[^"]*width:600px/i);
  assert.match(result.html, /<img[^>]+src="data:image\/png;base64,/i);
  assert.equal(result.remoteImageCount, 0);
  assert.equal(result.attachments[0].inline, true);
});

test('read-only mail API exposes folders, newest-first list, and sanitized detail', async (t) => {
  const clients = [];
  const createClient = () => {
    const client = {
      usable: true,
      connected: false,
      openedReadOnly: [],
      async connect() { this.connected = true; },
      async logout() { this.usable = false; },
      async list() {
        return [{ path: 'Work/INBOX', name: 'INBOX', delimiter: '/', flags: new Set(), status: { messages: 2, unseen: 1 } }];
      },
      async mailboxOpen(folder, options) {
        this.openedReadOnly.push(options.readOnly);
        return { path: folder, exists: 2 };
      },
      async fetchAll() {
        return [
          { uid: 10, envelope: { subject: 'Older' }, flags: new Set(), size: 10 },
          { uid: 11, envelope: { subject: 'Newest' }, flags: new Set(), size: 20 },
        ];
      },
      async fetchOne(uid, query) {
        if (query.source) {
          return { uid, source: Buffer.from('Subject: Safe\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>hello<script>bad()</script><img src="https://track.invalid/p"></p>') };
        }
        return { uid, envelope: { subject: 'Safe' }, flags: new Set(), size: 150 };
      },
    };
    clients.push(client);
    return client;
  };

  const app = express();
  app.use('/api/mail', createMailRouter({ createClient }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/mail`;

  const folders = await fetch(`${base}/folders`).then((response) => response.json());
  assert.equal(folders.folders[0].unseen, 1);
  assert.equal(folders.folders[0].delimiter, '/');

  const page = await fetch(`${base}/messages?folder=INBOX&page=1&pageSize=30`).then((response) => response.json());
  assert.deepEqual(page.messages.map((message) => message.uid), [11, 10]);

  const detail = await fetch(`${base}/messages/11?folder=INBOX`).then((response) => response.json());
  assert.match(detail.message.html, /hello/);
  assert.doesNotMatch(detail.message.html, /script|<img[^>]*\ssrc="https:\/\/track\.invalid/i);
  assert.match(detail.message.html, /data-remote-src="https:\/\/track\.invalid\/p"/i);
  assert.equal(detail.message.remoteImageCount, 1);
  assert.ok(clients.every((client) => client.connected && client.usable === false));
  assert.ok(clients.flatMap((client) => client.openedReadOnly).every(Boolean));
});
