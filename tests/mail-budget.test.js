'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createMailRouter } = require('../server/mail-reader');
const { newestUids, matchingCount } = require('../server/mail-search-uids');
const { MAX_RENDER_BYTES } = require('../server/mail-content');

test('ESEARCH transfers at most one bounded UID array at a time across million-message and sparse ranges', async () => {
  const mailbox = { uidNext: 4_000_000_000, exists: 1_000_000 };
  const calls = [];
  const client = {
    capabilities: new Map([['IMAP4rev2', true], ['IMAP4rev1', true]]), enabled: new Set(['IMAP4REV2']),
    async search(criteria, options) {
      calls.push(options.returnOptions?.[0] || 'window');
      if (options.returnOptions?.includes('COUNT')) return { count: 1_000_000 };
      const [low, high] = criteria.uid.split(':').map(Number);
      if (options.returnOptions?.includes('MAX')) return { max: Math.min(high, 1_000_000) };
      assert.ok(high - low < 4096);
      return Array.from({ length: high - low + 1 }, (_, offset) => low + offset);
    },
  };
  assert.equal(await matchingCount(client, { seen: false }, mailbox), 1_000_000);
  const top = await newestUids(client, { seen: false }, mailbox, null, 200);
  assert.equal(top.length, 200);
  assert.equal(top[0], 1_000_000);
  assert.equal(top.at(-1), 999_801);
  assert.deepEqual(calls, ['COUNT', 'MAX', 'window']);
});

test('the complete mail response respects 4 MiB after IMAP attachments and retains export metadata', async t => {
  const manyParts = Array.from({ length: 1200 }, (_, index) => ({ part: String(index + 1), type: 'application/octet-stream',
    disposition: 'attachment', dispositionParameters: { filename: '测'.repeat(150) }, size: 100 }));
  const app = express();
  app.use(createMailRouter({
    mailAccessForRequest: () => ({ all: true }),
    createClient: () => ({ async connect() {}, async logout() {}, close() {},
      async mailboxOpen() { return { uidValidity: 77n }; },
      async fetchOne(uid, fields) {
        if (fields.source) {
          assert.ok(fields.source.maxLength <= 10 * 1024 * 1024 + 1);
          return { source: Buffer.from('synthetic') };
        }
        return { uid, size: 9, bodyStructure: { type: 'multipart/mixed', childNodes: manyParts } };
      },
    }),
    parseMessage: async () => ({ subject: 'Synthetic', html: '', text: 'a'.repeat(MAX_RENDER_BYTES - 4096), attachments: [] }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/messages/7?folder=INBOX&uidValidity=77`);
  assert.equal(response.status, 200);
  const payload = Buffer.from(await response.arrayBuffer());
  assert.ok(payload.length <= MAX_RENDER_BYTES);
  const { message } = JSON.parse(payload);
  assert.equal(message.bodyOmitted, true);
  assert.equal(message.omittedReason, 'render_limit');
  assert.equal(message.html + message.text, '');
  assert.equal(message.uidValidity, '77');
  assert.equal(message.attachments[0].part, '1');
  assert.ok(message.attachmentsOmittedCount > 0);
  assert.equal(message.attachments.length + message.attachmentsOmittedCount, 1200);
  assert.ok(Buffer.byteLength(JSON.stringify(message.attachments)) <= 512 * 1024);
});
