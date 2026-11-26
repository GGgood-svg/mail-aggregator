'use strict';
// Linux-only helper behavior rehearsal. No sudo and no /etc or real Maildir writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runBounded } = require('../server/bounded-process');

test('helper preserves users file on reload failure and bounds stalled reload/storage commands', { timeout: 30000 }, async () => {
  if (process.platform === 'win32') throw Error('Run this isolated helper rehearsal on Linux');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-helper-test-'));
  try {
    const users = path.join(root, 'users'), backup = path.join(root, 'users.backup'), perms = path.join(root, 'perms.sh');
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(perms, 'fix_users_permissions() { chmod 600 "$1"; }\n');
    let source = fs.readFileSync(path.join(__dirname, '../scripts/dovecot-helper.sh'), 'utf8');
    for (const [from, to] of [['USERS_FILE="/etc/dovecot/users"', `USERS_FILE="${users}"`],
      ['BACKUP_FILE="/etc/dovecot/users.mail-aggregator-backup"', `BACKUP_FILE="${backup}"`],
      ['PERMS_LIB="/usr/local/sbin/mail-aggregator-dovecot-perms.sh"', `PERMS_LIB="${perms}"`],
      ['MAIL_ROOT="/home/$1/Maildir"', `MAIL_ROOT="${root}"`]]) {
      assert.ok(source.includes(from)); source = source.replace(from, to);
    }
    const helper = path.join(root, 'helper.sh'); fs.writeFileSync(helper, source);
    const command = '#!/bin/sh\ncase "$FIXTURE_MODE" in hang) exec sleep 60;; fail) exit 1;; esac\nexit 0\n';
    for (const name of ['doveadm', 'rc-service']) fs.writeFileSync(path.join(bin, name), command, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const original = 'fixture:{SHA512-CRYPT}old:1000:1000:/fixture:::\n'; fs.writeFileSync(users, original);
    await runBounded('sh', [helper, 'set-password', 'fixture'], { env, input: '{SHA512-CRYPT}new\n', timeout: 20000 });
    assert.match(fs.readFileSync(users, 'utf8'), /fixture:\{SHA512-CRYPT\}new:1000:1000:/);
    await runBounded('sh', [helper, 'restore-backup'], { env }); assert.equal(fs.readFileSync(users, 'utf8'), original);
    await assert.rejects(runBounded('sh', [helper, 'set-password', 'fixture'], { env: { ...env, FIXTURE_MODE: 'fail' }, input: '{SHA512-CRYPT}new\n', timeout: 20000 }));
    assert.equal(fs.readFileSync(users, 'utf8'), original);
    const started = performance.now();
    await assert.rejects(runBounded('sh', [helper, 'set-password', 'fixture'], { env: { ...env, FIXTURE_MODE: 'hang' }, input: '{SHA512-CRYPT}new\n', timeout: 20000 }));
    assert.ok(performance.now() - started < 19000, 'root-side deadlines must finish before the caller deadline');
    assert.equal(fs.readFileSync(users, 'utf8'), original);
    const plain = await runBounded('sh', [helper, 'storage-status', 'fixture'], { env, timeout: 7000 });
    const detailed = await runBounded('sh', [helper, 'storage-status', 'fixture', '--include-device'], { env, timeout: 7000 });
    assert.match(plain.stdout.trim(), /^\d+\n(?:\d+|-)$/);
    assert.match(detailed.stdout.trim(), /^\d+\n(?:\d+|-)\ndev:[1-9]\d*$/);
    const mounted = await runBounded('sh', [helper, 'storage-status', 'fixture', '--include-device', '--include-mount'], { env, timeout: 7000 });
    const { readLinuxDirectory, readLinuxMountInfo } = require('../server/linux-mounts');
    const observation = await readLinuxDirectory(root);
    assert.ok((await readLinuxMountInfo()).has(observation.mount));
    assert.equal(mounted.stdout.trim().split('\n').at(-1), `mnt:${observation.mount}`);
    fs.writeFileSync(path.join(bin, 'df'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o700 });
    await assert.rejects(runBounded('sh', [helper, 'storage-status', 'fixture'], { env, timeout: 5000 }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
