const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validNewPassword } = require('../server/password-policy');
const { childEnvironment } = require('../server/child-environment');
const { preserveSecretOwnership } = require('../server/restore');
const { applyTargetTransport, imapTransportOptions } = require('../server/target-transport');
const { applySourceTransport } = require('../server/source-transport');
const { syncDiskCapacity } = require('../server/resource-limits');
const { applyDestinationStrategy } = require('../server/folder-strategy');

test('new passwords enforce bcrypt byte boundary including multibyte Unicode', () => {
  assert.equal(validNewPassword('a'.repeat(72)), true);
  assert.equal(validNewPassword('a'.repeat(73)), false);
  assert.equal(validNewPassword('密'.repeat(24)), true);
  assert.equal(validNewPassword('密'.repeat(25)), false);
  assert.equal(validNewPassword('short'), false);
});

test('OAuth child environment carries an absolute data directory without unrelated secrets', () => {
  assert.deepEqual(childEnvironment('./fixture', { PATH: '/bin', SESSION_SECRET: 'do-not-forward' }), {
    PATH: '/bin', MAIL_AGG_DATA_DIR: path.resolve('./fixture'),
  });
});

test('restored secret ownership uses the live uid/gid recursively, including the directory', () => {
  const changes = [];
  const entry = (name, directory) => ({ name, isDirectory: () => directory, isFile: () => !directory });
  const io = { readdirSync: (dir) => dir === '/prepared' ? [entry('account', true), entry('local.pass', false)] : [entry('source.pass', false)],
    chownSync: (filename, uid, gid) => changes.push({ filename, uid, gid }) };
  preserveSecretOwnership('/prepared', { uid: 1001, gid: 1002 }, io, 'linux');
  assert.equal(changes.length, 4);
  assert.ok(changes.every((item) => item.uid === 1001 && item.gid === 1002));
  assert.equal(changes.at(-1).filename, '/prepared');
});

test('target transport requires verified TLS off-host and source pinning retains DNS identity', () => {
  assert.deepEqual(imapTransportOptions({ host: 'remote.example', port: 143 }), { secure: false, doSTARTTLS: true });
  const args = applyTargetTransport([], { host: 'remote.example', port: 143 });
  assert.ok(args.includes('--tls2'));
  assert.ok(args.includes('SSL_verify_mode=1'));
  assert.ok(args.includes('SSL_verifycn_name=remote.example'));
  assert.deepEqual(applyTargetTransport([], { host: '127.0.0.1', port: 143 }), ['--nossl2', '--notls2']);
  const source = applySourceTransport(['--host1', '93.184.216.34'], { ssl: 1, host: 'mail.example' });
  assert.ok(source.includes('SSL_hostname=mail.example'));
  assert.ok(source.includes('SSL_verifycn_name=mail.example'));
  assert.ok(source.includes('SSL_verifycn_scheme=imap'));
});

test('runtime destination guard refuses a corrupted isolated account set to flat', () => {
  assert.throws(() => applyDestinationStrategy([], { destination_mode: 'flat', mailbox_folder: 'U2-A7' }), /公共目录/);
});

test('mail disk guard checks the target independently and fails closed on helper errors', () => {
  const db = { prepare: () => ({ get: () => ({ value: '512' }) }) };
  const local = { host: '127.0.0.1', user: 'mailuser' };
  const dirs = { root: '/data', cache: '/cache', tmp: '/tmp' };
  const statfs = () => ({ bavail: 1024, bsize: 1024 * 1024 });
  const seen = [];
  const deps = { env: {}, statfs, run: (cmd, args) => { seen.push([cmd, args]); return '1024\n100\n'; } };
  assert.equal(syncDiskCapacity(db, dirs, local, deps).ok, false, 'mail disk is full even though app disk is free');
  assert.equal(seen[0][1].at(-1), 'mailuser');
  assert.equal(syncDiskCapacity(db, dirs, local, { ...deps, run: () => '1048576\n0\n' }).ok, false, 'no inodes');
  assert.equal(syncDiskCapacity(db, dirs, local, { ...deps, run: () => { throw Error('missing helper'); } }).availableMb, null);
  assert.equal(syncDiskCapacity(db, dirs, local, { ...deps, run: () => '1048576\n12345\n' }).ok, true);
});
