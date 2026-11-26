const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { validateMaildirTar } = require('../server/maildir-tar');

function header(name, type, size) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, 'utf8'); b.write('0000600\0', 100, 'ascii'); b.write('0000000\0', 108, 'ascii'); b.write('0000000\0', 116, 'ascii');
  b.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii'); b.write('00000000000\0', 136, 'ascii');
  b.fill(32, 148, 156); b[156] = type.charCodeAt(0); b.write('ustar\0', 257, 'ascii'); b.write('00', 263, 'ascii');
  const sum = b.reduce((a, n) => a + n, 0); b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return b;
}
function entry(name, type = '0', content = Buffer.alloc(0)) {
  return Buffer.concat([header(name, type, content.length), content, Buffer.alloc((512 - content.length % 512) % 512)]);
}
function pax(key, value) {
  const body = Buffer.from(`${key}=${value}\n`);
  let n = body.length + 2;
  while (Buffer.byteLength(String(n)) + 1 + body.length !== n) n = Buffer.byteLength(String(n)) + 1 + body.length;
  return Buffer.concat([Buffer.from(`${n} `), body]);
}
function archive(...entries) { return Readable.from([zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))]); }

test('Maildir archive validation accepts normal and long PAX paths', async () => {
  const long = `cur/${'x'.repeat(160)}`;
  const summary = await validateMaildirTar(archive(entry('./', '5'), entry('cur/', '5'), entry('new/', '5'), entry('tmp/', '5'), entry('PaxHeaders/x', 'x', pax('path', long)), entry('cur/x', '0', Buffer.from('mail'))));
  assert.equal(summary.entries, 5); assert.equal(summary.bytes, 4);
});

test('Maildir archive validation rejects traversal, links, duplicate paths and unsafe PAX', async () => {
  for (const content of [
    [entry('../outside', '0')],
    [entry('/absolute', '0')],
    [entry('cur/link', '2')],
    [entry('cur/a', '0'), entry('./cur/a', '0')],
    [entry('PaxHeaders/x', 'x', pax('path', '../../outside')), entry('cur/x', '0')],
    [entry('PaxHeaders/x', 'x', pax('linkpath', '/outside')), entry('cur/x', '0')],
  ]) await assert.rejects(validateMaildirTar(archive(...content)));
});

test('Maildir expanded-byte guard includes tar headers, metadata and trailing padding', async () => {
  const small = [entry('./', '5'), entry('cur/', '5'), entry('new/', '5'), entry('tmp/', '5')];
  const summary = await validateMaildirTar(archive(...small), { maxExpandedBytes: 4096 });
  assert.equal(summary.bytes, 0); assert.equal(summary.expandedBytes, 3072);
  await assert.rejects(validateMaildirTar(archive(...small, Buffer.alloc(8192)), { maxExpandedBytes: 4096 }), /解压体积超过/);
});
