'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCappedLog } = require('../server/capped-log');

test('small logs are unchanged and created with owner-only permissions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-agg-log-'));
  const file = path.join(dir, 'job.log');
  const log = createCappedLog(file, { maxBytes: 4096, tailBytes: 1024 });
  log.write('hello\n');
  await new Promise((resolve) => log.end(resolve));
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('oversized logs retain a bounded head and tail with a marker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-agg-log-'));
  const file = path.join(dir, 'job.log');
  const log = createCappedLog(file, { maxBytes: 4096, tailBytes: 1024 });
  log.write(Buffer.alloc(5000, 'A'));
  log.write(Buffer.alloc(2000, 'Z'));
  await new Promise((resolve) => log.end(resolve));
  const content = fs.readFileSync(file);
  assert.ok(content.length <= 4096);
  assert.match(content.toString(), /earlier log output truncated/);
  assert.equal(content.subarray(-1024).equals(Buffer.alloc(1024, 'Z')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
