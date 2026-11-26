'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MailParserPool } = require('../server/mail-parser-pool');
function fakeWorkers() {
  const workers = [];
  return { workers, createWorker() {
    const worker = new EventEmitter(); worker.ref = worker.unref = () => {};
    worker.postMessage = message => { worker.message = message; };
    worker.terminate = async () => { worker.stopping = true; };
    workers.push(worker); return worker;
  } };
}
const valid = { html: '<p>ok</p>', attachments: [] };

test('preview byte budget also bounds Unicode attachment metadata', () => {
  const { serializeParsedMessage, MAX_RENDER_BYTES } = require('../server/mail-content');
  const parsed = { text: 'small body', attachments: Array.from({ length: 3000 }, () => ({ filename: '测'.repeat(1024), contentType: 'application/octet-stream' })) };
  const result = serializeParsedMessage({ uid: 1 }, parsed);
  assert.equal(result.text, 'small body');
  assert.ok(result.attachmentsOmittedCount > 0);
  assert.equal(result.attachments.length + result.attachmentsOmittedCount, 3000);
  assert.ok(Buffer.byteLength(JSON.stringify(result.attachments)) <= 512 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_RENDER_BYTES);
});

test('repeated CID references degrade inside the worker and subsequent parsing remains usable', async () => {
  const pool = new MailParserPool();
  try {
    const source = Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n' +
      '<img src="cid:large">'.repeat(128) + '\r\n--b\r\nContent-Type: image/png\r\nContent-ID: <large>\r\nContent-Disposition: inline; filename="image.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.alloc(65536, 1).toString('base64') + '\r\n--b--\r\n');
    const result = await pool.parse({ uid: 1 }, source);
    assert.equal(result.bodyOmitted, true); assert.equal(result.omittedReason, 'inline_limit');
    assert.equal(result.html, ''); assert.equal(result.attachments[0].filename, 'image.png');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4 * 1024 * 1024);
    const next = await pool.parse({ uid: 2 }, Buffer.from('Subject: next\r\n\r\nSmall message'));
    assert.match(next.text, /Small message/);
    const large = await pool.parse({}, Buffer.from('Content-Type: text/plain\r\n\r\n' + 'x'.repeat(5 * 1024 * 1024)));
    assert.equal(large.bodyOmitted, true); assert.equal(large.omittedReason, 'render_limit');
  } finally { await pool.close(); }
});

test('real MIME worker preserves metadata and inline images while removing scripts and remote requests', async () => {
  const pool = new MailParserPool();
  try {
    const source = Buffer.from('From: Example <sender@example.invalid>\r\nSubject: Fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello</p><script>alert(1)</script><img src="https://tracking.invalid/x"><img src="cid:tiny">\r\n--b\r\nContent-Type: image/png\r\nContent-ID: <tiny>\r\nContent-Disposition: inline; filename="pixel.png"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--b--\r\n');
    const parsed = await pool.parse({ uid: 7, flags: new Set(['\\Flagged']), size: source.length }, source);
    assert.equal(parsed.uid, 7); assert.equal(parsed.flagged, true);
    assert.match(parsed.html, /Hello/); assert.doesNotMatch(parsed.html, /<script|onerror|\ssrc="https:/);
    assert.match(parsed.html, /data-remote-src="https:\/\/tracking.invalid/); assert.match(parsed.html, /data:image\/png;base64/);
    assert.equal(parsed.remoteImageCount, 1); assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].content, undefined, 'worker must not return attachment bytes');
  } finally { await pool.close(); }
});

test('MIME pool bounds source and queue, cancels queued work, and retains crashed workers until exit', async () => {
  const fake = fakeWorkers(), pool = new MailParserPool({ size: 1, maxQueue: 1, createWorker: fake.createWorker });
  try {
    await assert.rejects(pool.parse({}, Buffer.alloc(10 * 1024 * 1024 + 1)), { statusCode: 413 });
    const first = pool.parse({}, Buffer.from('secret fixture'));
    const failed = assert.rejects(first, error => error.statusCode === 503 && !error.message.includes('secret'));
    const controller = new AbortController();
    const queued = pool.parse({}, Buffer.from('queued'), { signal: controller.signal });
    const cancelled = assert.rejects(queued, { statusCode: 499 });
    await assert.rejects(pool.parse({}, Buffer.from('third')), { statusCode: 503 });
    controller.abort(); await cancelled; assert.equal(pool.queue.length, 0);
    fake.workers[0].emit('error', Error('secret parser detail')); await failed;
    const next = pool.parse({}, Buffer.from('next')); assert.equal(fake.workers.length, 1);
    fake.workers[0].emit('exit', 1); assert.equal(fake.workers.length, 2);
    const worker = fake.workers[1]; worker.emit('message', { id: worker.message.id, result: valid });
    assert.deepEqual(await next, valid);
  } finally { await pool.close(); }
});

test('MIME running cancellation, deadline and invalid output settle once and keep resource slots until exit', async () => {
  for (const reason of ['abort', 'timeout', 'invalid']) {
    const fake = fakeWorkers(), pool = new MailParserPool({ size: 1, timeoutMs: 30, createWorker: fake.createWorker });
    try {
      const controller = new AbortController(), pending = pool.parse({}, Buffer.from('fixture'), { signal: controller.signal });
      const rejected = assert.rejects(pending, { statusCode: reason === 'abort' ? 499 : 503 });
      if (reason === 'abort') controller.abort();
      if (reason === 'invalid') fake.workers[0].emit('message', { id: 999, result: valid });
      await rejected; assert.equal(fake.workers[0].stopping, true);
      const next = pool.parse({}, Buffer.from('next')); assert.equal(fake.workers.length, 1);
      fake.workers[0].emit('message', { id: 1, result: valid }); assert.equal(fake.workers.length, 1);
      fake.workers[0].emit('exit', 1);
      const worker = fake.workers[1]; worker.emit('message', { id: worker.message.id, result: valid }); await next;
    } finally { await pool.close(); }
    await assert.rejects(pool.parse({}, Buffer.from('closed')), { statusCode: 503 });
  }
});
