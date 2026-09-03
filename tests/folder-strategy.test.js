const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDestinationFolder,
  isValidDestinationFolder,
  applyDestinationStrategy,
} = require('../server/folder-strategy');

test('destination folder names are normalized and restricted to one portable segment', () => {
  assert.equal(normalizeDestinationFolder('  我的   QQ邮箱  '), '我的 QQ邮箱');
  for (const value of ['QQ邮箱', 'Work Mail', 'account_01', 'mail-2026']) {
    assert.equal(isValidDestinationFolder(value), true, value);
  }
  for (const value of ['', '-leading', 'a/b', 'a.b', 'a\\b', 'bad\nname', 'x'.repeat(65)]) {
    assert.equal(isValidDestinationFolder(value), false, value);
  }
});

test('subfolder strategy uses imapsync native subfolder2 mapping', () => {
  const isolated = applyDestinationStrategy(['--useuid'], {
    destination_mode: 'subfolder',
    destination_folder: 'QQ邮箱',
  });
  assert.deepEqual(isolated, ['--useuid', '--subfolder2', 'QQ邮箱']);

  const flat = applyDestinationStrategy(['--useuid'], {
    destination_mode: 'flat',
    destination_folder: null,
  });
  assert.deepEqual(flat, ['--useuid']);
});
