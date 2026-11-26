'use strict';
// Synthetic RFC 822 only. Run alone; this is a local measurement, not a Linux acceptance test.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const express = require('express');
const { createMailRouter } = require('../server/mail-reader');
const { mailParser } = require('../server/mail-parser-pool');
const MiB = 1024 * 1024;
function htmlSource(bytes) {
  const header = 'Subject: Synthetic benchmark\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n';
  const fragment = '<p>synthetic <b>mail</b> content <a href="https://example.invalid">link</a></p>';
  return Buffer.from(header + fragment.repeat(Math.ceil((bytes - header.length) / fragment.length)).slice(0, bytes - header.length));
}
function normalSource() {
  const header = 'Subject: Normal 4 MiB fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\n';
  const html = htmlSource(MiB).toString().replace(/^Subject:[^\n]*\nMIME-Version:[^\n]*\n/, '');
  const attachment = '\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="fixture.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n';
  const tail = '\r\n--b--\r\n', pad = 4 * MiB - Buffer.byteLength(header + html + attachment + tail);
  return Buffer.from(header + html + attachment + 'A'.repeat(pad - pad % 4) + tail + ' '.repeat(pad % 4));
}
function cidSource() {
  return Buffer.from('Subject: CID amplification fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n' + '<img src="cid:large">'.repeat(128) + '\r\n--b\r\nContent-Type: image/png\r\nContent-ID: <large>\r\nContent-Disposition: inline; filename="image.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.alloc(65536, 1).toString('base64') + '\r\n--b--\r\n');
}
async function main() {
  let source = Buffer.from('Subject: warmup\r\n\r\nfixture');
  const app = express(); app.get('/lightweight', (_, res) => res.json({ ok: true }));
  app.use((req, res, next) => { req.user = { id: 1 }; next(); });
  app.use('/mail', createMailRouter({ mailAccessForRequest: () => ({ all: true }), createClient: () => ({
    async connect() {}, async logout() {}, close() {},
    async mailboxOpen() { return { uidValidity: '77' }; },
    async fetchOne(_uid, fields) { return fields.source ? { source } : { uid: 7, size: source.length, flags: new Set() }; },
  }) }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function detail() {
    const response = await fetch(`${base}/mail/messages/7?folder=INBOX&uidValidity=77`);
    if (!response.ok) throw Error(`detail response ${response.status}: ${await response.text()}`);
    return response.json();
  }
  const results = [];
  try {
    await detail();
    for (const [name, make, omitted] of [['html-1MiB', () => htmlSource(MiB), false], ['normal-4MiB', normalSource, false],
      ['html-9.5MiB', () => htmlSource(9.5 * MiB), true], ['repeated-cid', cidSource, true], ['after-amplification', () => htmlSource(4096), false]]) {
      source = make();
      let previous = performance.now(), maxGapMs = 0, done = false, peakRssBytes = process.memoryUsage().rss;
      const timer = setInterval(() => { const current = performance.now(); maxGapMs = Math.max(maxGapMs, current - previous); previous = current; peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 10);
      const latency = [], started = performance.now();
      let data;
      try {
        const pending = detail().finally(() => { done = true; });
        pending.catch(() => {});
        while (!done) {
          const pingStart = performance.now(), response = await fetch(`${base}/lightweight`); await response.arrayBuffer();
          assert.ok(response.ok); latency.push(performance.now() - pingStart); await delay(5);
        }
        data = await pending; await delay(15);
      } finally { clearInterval(timer); }
      latency.sort((a, b) => a - b);
      assert.equal(Boolean(data.message.bodyOmitted), omitted, name);
      assert.ok(Buffer.byteLength(JSON.stringify(data.message)) <= 4 * MiB + 128, name);
      const result = { name, sourceBytes: source.length, totalMs: Math.round(performance.now() - started),
        maxMainThreadGapMs: Math.round(maxGapMs), lightweightSamples: latency.length,
        lightweightP95Ms: Math.round(latency[Math.ceil(latency.length * .95) - 1] || 0),
        htmlBytes: Buffer.byteLength(data.message.html), bodyOmitted: Boolean(data.message.bodyOmitted), omittedReason: data.message.omittedReason || null,
        peakRssBytes, sanitized: !/<script/i.test(data.message.html) };
      results.push(result); console.log(JSON.stringify(result));
    }
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version,
      platform: process.platform, method: 'isolated same-process HTTP fixture, actual detail route and production worker; synthetic MIME; sampled process RSS includes worker', results }, null, 2) + '\n');
    const normal = results.find(item => item.name === 'normal-4MiB');
    assert.ok(normal.maxMainThreadGapMs <= 100 && normal.lightweightP95Ms <= 200, '4 MiB local responsiveness target exceeded');
  } finally { await mailParser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
