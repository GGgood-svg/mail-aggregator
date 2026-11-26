const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withBackupLock } = require('../server/maildir-backup');

test('backup retention is exclusive and never removes a replaced lock', async t => {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'maildir-lock-test-'));
  t.after(() => {
    const actual = fs.realpathSync(root);
    if (path.dirname(actual) !== base || !path.basename(actual).startsWith('maildir-lock-test-')) throw new Error('Unexpected cleanup path');
    fs.rmSync(actual, { recursive: true, force: true });
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = withBackupLock(root, () => gate);
  await assert.rejects(withBackupLock(root, async () => {}), /已有任务或残留锁/);
  release(); await first;
  assert.equal(fs.existsSync(path.join(root, '.maildir-backup.lock')), false);
  await assert.rejects(withBackupLock(root, async () => {
    fs.writeFileSync(path.join(root, '.maildir-backup.lock'), JSON.stringify({ token: 'different' }));
  }), /所有者发生变化/);
  assert.equal(fs.existsSync(path.join(root, '.maildir-backup.lock')), true);
});
