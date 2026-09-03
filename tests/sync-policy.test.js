const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeFolderRules,
  normalizeSyncPolicy,
  applySyncPolicy,
} = require('../server/sync-policy');

test('folder rules normalize whitespace, duplicates, and line endings', () => {
  assert.deepEqual(
    normalizeFolderRules(' INBOX\r\nSent\nINBOX\n\n项目 '),
    ['INBOX', 'Sent', '项目']
  );
});

test('sync policy defaults preserve the existing non-destructive behavior', () => {
  const result = normalizeSyncPolicy({ destination_mode: 'flat' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.normalized, {
    folder_includes: '',
    folder_excludes: '',
    max_age_days: null,
    max_size_mb: null,
    deletion_mode: 'archive',
  });
  assert.deepEqual(applySyncPolicy([], result.normalized), []);
});

test('sync policy generates exact folder, age, and byte-size arguments', () => {
  const account = {
    folder_includes: 'INBOX\nProject [A]',
    folder_excludes: 'Trash.*',
    max_age_days: 90,
    max_size_mb: 25,
    deletion_mode: 'archive',
  };
  assert.deepEqual(applySyncPolicy([], account), [
    '--include', '^INBOX$',
    '--include', '^Project \\[A\\]$',
    '--exclude', '^Trash\\.\\*$',
    '--maxage', '90',
    '--maxsize', String(25 * 1024 * 1024),
  ]);
});

test('connection tests apply folder selection but no message or deletion options', () => {
  const args = applySyncPolicy([], {
    folder_includes: 'INBOX',
    folder_excludes: 'Trash',
    max_age_days: 30,
    max_size_mb: 5,
    deletion_mode: 'mirror_messages',
  }, { justFolders: true });
  assert.deepEqual(args, ['--include', '^INBOX$', '--exclude', '^Trash$']);
});

test('mirror deletion requires isolation and unrestricted message selection', () => {
  const flat = normalizeSyncPolicy({
    destination_mode: 'flat',
    deletion_mode: 'mirror_messages',
  });
  assert.match(flat.errors.join('; '), /账号文件夹隔离/);

  const limited = normalizeSyncPolicy({
    destination_mode: 'subfolder',
    deletion_mode: 'mirror_messages',
    max_age_days: 30,
  });
  assert.match(limited.errors.join('; '), /不能与时间或邮件大小限制同时启用/);

  const valid = normalizeSyncPolicy({
    destination_mode: 'subfolder',
    deletion_mode: 'mirror_messages',
  });
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(applySyncPolicy([], valid.normalized), ['--delete2']);
});
