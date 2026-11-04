const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withStateLock } = require('../server/state-lock');

test('state lock permits nested work but excludes unrelated requests and child processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-lock-'));
  let release;
  try {
    const pending = withStateLock(root, async () => {
      assert.equal(withStateLock(root, () => 42), 42);
      const child = spawnSync(process.execPath, ['-e',
        `const {withStateLock}=require(process.argv[1]);try{withStateLock(process.argv[2],()=>{});process.exit(2)}catch(e){process.exit(e.statusCode===409?0:3)}`,
        require.resolve('../server/state-lock'), root]);
      assert.equal(child.status, 0, child.stderr.toString());
      await new Promise((resolve) => { release = resolve; });
    });
    assert.throws(() => withStateLock(root, () => assert.fail('must not enter')), { statusCode: 409 });
    release(); await pending;
    assert.equal(withStateLock(root, () => 'released'), 'released');
    assert.throws(() => withStateLock(root, () => { throw new Error('fixture'); }), /fixture/);
    assert.equal(fs.existsSync(path.join(root, '.state-write.lock')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('state lock releases after an asynchronous error and refuses an unknown stale owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-lock-error-'));
  try {
    await assert.rejects(withStateLock(root, async () => { throw new Error('fixture'); }), /fixture/);
    fs.writeFileSync(path.join(root, '.state-write.lock'), '{}');
    assert.throws(() => withStateLock(root, () => {}), { statusCode: 409 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
