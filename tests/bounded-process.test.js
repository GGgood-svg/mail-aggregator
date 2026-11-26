'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runBounded } = require('../server/bounded-process');

test('bounded child cancellation and synchronous input failures await actual close before rejecting', async () => {
  for (const inputFailure of [false, true]) {
    let child, settled = false, callback;
    const controller = new AbortController();
    const pending = runBounded('fictional-helper', [], { input: 'private-input', signal: controller.signal,
      execFileImpl(file, args, options, done) {
        assert.equal(options.windowsHide, true); assert.equal(options.killSignal, 'SIGKILL'); assert.equal(options.maxBuffer, 4096);
        callback = done; child = new EventEmitter(); child.stdin = new EventEmitter();
        child.stdin.end = () => { if (inputFailure) throw Error('fixture EPIPE'); };
        child.kill = () => { child.killed = true; }; return child;
      } });
    const rejected = assert.rejects(pending, inputFailure ? /EPIPE/ : /cancelled/).then(() => { settled = true; });
    if (!inputFailure) controller.abort();
    await new Promise(setImmediate); assert.equal(child.killed, true); assert.equal(settled, false);
    callback(Error('child terminated'), '', ''); child.emit('close', null, 'SIGKILL'); await rejected;
  }
});

test('real bounded child handles output overflow and deadlines without lingering process handles', async () => {
  await assert.rejects(runBounded(process.execPath, ['-e', "process.stdout.write('x'.repeat(8192))"], { maxBuffer: 64 }));
  await assert.rejects(runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }));
  const output = await runBounded(process.execPath, ['-e', "process.stdin.on('data',b=>process.stdout.write(b))"], { input: 'fixture' });
  assert.equal(output.stdout, 'fixture');
});
