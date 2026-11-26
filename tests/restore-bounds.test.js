const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { receiveArchive } = require('../server/restore');
const { withStateLock } = require('../server/state-lock');
const maintenance = require('../server/maintenance-lock');

test('restore uploads enforce idle, total, declared and streamed size limits and clean up after closing', async t => {
  for (const mode of ['idle', 'total', 'declared', 'size', 'abort', 'empty', 'success']) await t.test(mode, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-upload-')), target = path.join(root, 'archive');
    const request = new PassThrough(); request.headers = mode === 'declared' ? { 'content-length': '10' } : {};
    const controller = new AbortController();
    const timeLimits = mode === 'idle' ? { idleMs: 50, totalMs: 500 }
      : mode === 'total' ? { idleMs: 800, totalMs: 250 } : {};
    // The receiver unrefs its deadlines. Non-timeout cases use production
    // limits so a slow filesystem cannot turn a success assertion into an idle test.
    const keepingAlive = ['idle', 'total'].includes(mode) && setTimeout(() => request.end(), 1000);
    let trickle;
    try {
      const pending = receiveArchive(request, target, 8, { signal: controller.signal, ...timeLimits });
      if (mode === 'success') request.end('fixture');
      else if (mode === 'size') request.end('123456789');
      else if (mode === 'empty') request.end();
      else if (mode === 'abort') { request.write('x'); controller.abort(); }
      else if (mode === 'total') trickle = setInterval(() => request.write('x'), 50);
      if (mode === 'success') { assert.equal(await pending, 7); assert.equal(fs.readFileSync(target, 'utf8'), 'fixture'); }
      else {
        await assert.rejects(pending, error => ['idle', 'total'].includes(mode) ? error.statusCode === 408 : ['size', 'declared'].includes(mode) ? error.statusCode === 413 : true);
        assert.equal(fs.existsSync(target), false);
      }
    } finally { clearInterval(trickle); clearTimeout(keepingAlive); request.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

test('restore maintenance blocks normal writes while allowing explicit session revocation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-maintenance-'));
  assert.equal(maintenance.acquire('restore'), true);
  try {
    assert.throws(() => withStateLock(root, () => {}), { statusCode: 409 });
    assert.equal(withStateLock(root, () => 'revoked', { allowDuringRestore: true }), 'revoked');
  } finally { maintenance.release('restore'); fs.rmSync(root, { recursive: true, force: true }); }
});
