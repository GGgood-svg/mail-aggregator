'use strict';
const { gzipSync } = require('node:zlib');

// A real POSIX ustar stream, kept in JS so this fixture also works with BusyBox tar.
function ustarFixture(files) {
  const blocks = [];
  for (const [name, value] of Object.entries(files)) {
    if (Buffer.byteLength(name) > 100) throw new Error('Fixture entry name is too long');
    const body = Buffer.from(value), header = Buffer.alloc(512);
    const octal = (offset, width, number) => header.write(number.toString(8).padStart(width - 1, '0'), offset, 'ascii');
    header.write(name, 0);
    octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0);
    octal(124, 12, body.length); octal(136, 12, 0);
    header.fill(32,148,156);
    header.write('0',156); header.write('ustar\x0000',257);
    header.write(header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6,'0')+'\x00 ',148,'ascii');
    blocks.push(header,body,Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));
}
module.exports = { ustarFixture };
