'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { managedUserFile, removals } = require('../scripts/lib/owned-dovecot');
const { createUninstallHost } = require('../server/uninstall-host');

test('the installer passwd-file remains eligible after its password changes, but extra users or overrides do not', () => {
  const original = 'mailuser:{SHA512-CRYPT}$6$salt$hash::::::\n';
  assert.equal(managedUserFile(original, 'mailuser'), true);
  assert.equal(managedUserFile(original.replace('$hash', '$changed'), 'mailuser'), true);
  assert.equal(managedUserFile(original, 'different_user'), false);
  assert.equal(managedUserFile(original + original.replace('mailuser:', 'another:'), 'mailuser'), false);
  assert.equal(managedUserFile(original.replace('::::::', ':1234:::::'), 'mailuser'), false);
  assert.equal(managedUserFile(original.replace('::::::', '::::::userdb_mail_path=/srv/other'), 'mailuser'), false);
});

const alpine = ['dovecot-openrc', 'dovecot'];
const alpinePlan = `( 1/3) Purging dovecot-openrc (2.4.5-r0)
( 2/3) Purging dovecot (2.4.5-r0)
( 3/3) Purging libsodium (1.0.22-r0)
OK: 549.6 MiB in 180 packages`;
test('Alpine removal can include only dependencies introduced by the Dovecot install', () => {
  assert.doesNotThrow(() => removals('alpine', alpinePlan, alpine, [...alpine, 'libsodium']));
  assert.throws(() => removals('alpine', alpinePlan, alpine, alpine));
  assert.throws(() => removals('alpine', alpinePlan.replace('3/3', '3/4'), alpine, [...alpine, 'libsodium']));
  assert.throws(() => removals('alpine', alpinePlan.replace('Purging libsodium', 'Installing libsodium'), alpine, [...alpine, 'libsodium']));
  assert.throws(() => removals('alpine', 'OK: 549.6 MiB in 180 packages', alpine, alpine));
});
test('Apt removal has to purge both expected packages and leave other packages alone', () => {
  const expected = ['dovecot-imapd', 'dovecot-core'];
  const plan = 'Purg dovecot-imapd [1:2.3.19]\nPurg dovecot-core [1:2.3.19]\n';
  assert.doesNotThrow(() => removals('apt', plan, expected, expected));
  for (const extra of ['Remv exim4-daemon-heavy [4.96]', 'Purg dovecot-ldap [1:2.3.19]', 'Inst openssl (3.0)']) {
    assert.throws(() => removals('apt', plan + extra, expected, expected));
  }
  assert.throws(() => removals('apt', plan.replace('Purg dovecot-core', 'Remv dovecot-core'), expected, expected));
});
test('Host eligibility is separate from application uninstall; refusal keeps the operation ID', async () => {
  const id = '1d5279ff-3f84-4f45-823b-2007c2c0ec72';
  const host = createUninstallHost({ exists: () => true, run: async (_command, args) => {
    const [action, mode] = args.slice(2);
    if (action === 'dovecot-eligible') throw Error('no provenance');
    if (action === 'queue' && mode === 'purge-dovecot') {
      return { stdout: JSON.stringify({ id, mode, state: 'failed', code: 'dovecot_unverified' }) };
    }
    assert.equal(mode, 'purge');
    return { stdout: JSON.stringify({ id, mode, state: 'accepted' }) };
  } });
  assert.equal(await host.dovecotEligible(), false);
  await assert.rejects(host.queue('purge-dovecot'), { statusCode: 409, operationId: id });
  assert.equal((await host.queue('purge')).dovecot, 'retained');
});
