'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { InstallSession, installOptions, receiveLines } = require('../scripts/install-web/protocol');
const { isPrivateIp, hasLanAddress, listeningPorts, hasCapacity } = require('../scripts/install-web/host');

const form = { username: '示例-Admin', password: 'fictional + $ setup pass', webPort: 8080, language: 'zh-CN' };

function fixture() {
  let now = 0, available = true;
  const starts = [];
  const wizard = new InstallSession({ ip: '192.168.50.150', now: () => now,
    preflight: port => [{ id: 'web_port', ok: available && port !== 8181 }],
    start: (options, password) => starts.push({ options, password }),
  });
  const op = (op, data, use = {}) => wizard.handle({ op, data, ...use });
  const pair = () => {
    const result = op('pair', { code: wizard.printedCode() });
    assert.equal(result.status, 200);
    const credentials = { session: result.cookie, csrf: result.body.csrf };
    return (name, data) => op(name, data, credentials);
  };
  return { wizard, op, pair, starts, at: timestamp => { now = timestamp; }, makeUnavailable: () => { available = false; } };
}

test('setup code expires and cannot be reused in another browser', () => {
  const expired = fixture(), code = expired.wizard.printedCode();
  expired.at(15 * 60_000);
  assert.deepEqual(expired.op('pair', { code }), { status: 410, body: { error: 'expired' } });
  const active = fixture(), activeCode = active.wizard.printedCode();
  active.pair();
  assert.equal(active.op('pair', { code: activeCode }).status, 409);
  assert.equal(active.op('status').status, 401);
  const limited = fixture(), limitedCode = limited.wizard.printedCode();
  for (let attempt = 0; attempt < 12; attempt++) assert.equal(limited.op('pair', { code: 'wrong' }).status, 401);
  assert.equal(limited.op('pair', { code: limitedCode }).status, 429);
});

test('preflight is refreshed at submission, and invalid options or sessions cannot launch a job', () => {
  const { op, pair, starts, makeUnavailable } = fixture();
  const send = pair();
  const fakeSession = 'b'.repeat(64);
  assert.equal(op('install', form, { session: fakeSession, csrf: fakeSession }).status, 401);
  const active = fixture();
  const pairing = active.op('pair', { code: active.wizard.printedCode() });
  assert.equal(active.op('install', form, { session: pairing.cookie }).status, 403);
  assert.equal(send('install', { ...form, webPort: 8090 }).status, 400);
  assert.equal(send('install', { ...form, language: 'xx-XX' }).status, 400);
  assert.equal(send('install', { ...form, command: 'unexpected' }).status, 400);
  assert.equal(send('preflight', { webPort: 8080 }).body.checks[0].ok, true);
  makeUnavailable();
  const blocked = send('install', form);
  assert.equal(blocked.body.error, 'preflight_blocked');
  assert.equal(blocked.body.checks[0].ok, false);
  assert.equal(starts.length, 0);
  assert.equal(installOptions({ ...form, password: '界'.repeat(25) }), null);
  assert.equal(installOptions({ ...form, username: ' Ａdmin ' }).username, 'Admin');
});

test('refresh uses the same job and progress, and the separate IMAP password can be retrieved once', () => {
  const { wizard, pair, starts } = fixture();
  const send = pair();
  assert.equal(send('install', form).status, 202);
  wizard.progress(1);
  assert.equal(send('status').body.step, 1);
  assert.equal(send('install', form).status, 409);
  assert.equal(send('finish', {}).status, 409);
  assert.equal(send('reveal', {}).status, 409);
  assert.equal(starts.length, 1);
  assert.match(starts[0].password, /^[a-f0-9]{32}$/);
  assert.notEqual(starts[0].password, form.password);
  wizard.complete(true);
  const result = send('status');
  assert.equal(result.body.panel, 'http://192.168.50.150:8080/');
  assert.equal(result.body.passwordAvailable, true);
  for (const secret of [form.password, starts[0].password]) assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(send('reveal', {}).body, { user: 'mailuser', password: starts[0].password });
  assert.equal(send('reveal', {}).status, 409);
  assert.equal(send('install', form).status, 409);
  assert.equal(send('finish', {}).close, true);
  assert.equal(send('status').status, 410);
});

test('failure stays inspectable without a secret or a retry, then the session expires', () => {
  const { wizard, pair, at, starts } = fixture();
  const send = pair();
  send('install', form);
  wizard.progress(1);
  wizard.complete(false, 'preflight_changed');
  assert.equal(send('status').body.phase, 'failed');
  assert.equal(send('status').body.error, 'preflight_changed');
  assert.equal(send('status').body.passwordAvailable, false);
  assert.equal(send('reveal', {}).status, 409);
  assert.equal(send('install', form).status, 409);
  assert.equal(starts.length, 1);
  at(5 * 60_000);
  assert.equal(send('status').status, 410);
});

test('preflight sees IPv4 and IPv6 listeners, rejects public addresses and checks free inodes', () => {
  assert.equal(isPrivateIp('172.31.0.5'), true);
  for (const address of ['172.32.0.5', '127.0.0.1', '0.0.0.0', '192.168.050.150', '::1']) {
    assert.equal(isPrivateIp(address), false);
  }
  assert.equal(hasLanAddress('192.168.50.150', { eth0: [{ address: '192.168.50.151', internal: false }] }), false);
  const listeners = listeningPorts(['header\n  0: 0100007F:008F  00000000:0000 0A\n 1: 0100007F:0001 00000000:0000 01',
    'header\n 0: 00000000000000000000000000000000:1F90 0000:0000 0A']);
  assert.deepEqual([...listeners], [143, 8080]);
  const capacity = { bsize: 4096n, bavail: 900_000n, ffree: 8000n };
  assert.equal(hasCapacity(() => capacity), true);
  assert.equal(hasCapacity(name => name === '/var/log' ? { ...capacity, ffree: 0n } : capacity), false);
});

test('private pipe parser preserves split frames and stops on oversized input', () => {
  const received = [];
  let invalid = 0;
  const pipe = new PassThrough();
  receiveLines(pipe, line => received.push(line), () => invalid++, 8);
  pipe.write(Buffer.from('first\nsec'));
  pipe.write(Buffer.from('ond\n'));
  pipe.write(Buffer.from('oversized\nignored\n'));
  pipe.end();
  assert.deepEqual(received, ['first', 'second']);
  assert.equal(invalid, 1);
});

const shellPlatform = path.resolve(__dirname, '../scripts/lib/install-platform.sh');
const linuxShell = { skip: process.platform !== 'linux' };

function platformShell(code, ...args) {
  const run = spawnSync('/bin/sh', ['-ec', `. "$1"; shift; ${code}`, 'sh', shellPlatform, ...args], { encoding: 'utf8', timeout: 4000 });
  assert.ifError(run.error);
  assert.equal(run.signal, null);
  assert.ok(run.status === 0 || run.status === 1, run.stderr);
  return run.status === 0;
}

test('the CLI and wizard accept the shared release matrix and reject unsupported branches', linuxShell, () => {
  for (const [distro, version, expected] of [
    ['alpine', '3.21.9', true], ['alpine', '3.24.4', true], ['alpine', '3.20.5', false], ['alpine', '4.0', false],
    ['debian', '12', true], ['debian', '13.2', true], ['debian', '14', false],
    ['ubuntu', '22.04', true], ['ubuntu', '24.04', true], ['ubuntu', '26.04', true], ['ubuntu', '20.04', false],
    ['fedora', '44', false], ['alpine', '3.24_rc1', false],
  ]) assert.equal(platformShell('install_platform_supported "$1" "$2"', distro, version), expected, `${distro} ${version}`);
});

test('configured apt Node packages must satisfy the service runtime floor', linuxShell, t => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-agg-apt-cache-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, 'apt-cache'), `#!/bin/sh\nprintf '  Candidate: %s\\n' "$CANDIDATE"\n`, { mode: 0o700 });
  for (const [candidate, expected] of [
    ['18.20.8+dfsg-1', false], ['20.19.0+dfsg-1', false], ['22.9.0-1', false],
    ['1:22.12.0-1', true], ['24.22.3-1nodesource1', true], ['(none)', false],
  ]) assert.equal(platformShell('export PATH="$1:$PATH" CANDIDATE="$2"; apt_node_candidate_supported', bin, candidate), expected, candidate);
});

const shellHost = path.resolve(__dirname, '../scripts/lib/web-install-host.sh').replace(/\\/g, '/');
const lanShell = { skip: process.platform !== 'linux' && !process.env.MAIL_TEST_POSIX_SH };
const addrHeader = '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP';
const ignoredAddresses = `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN
    inet 127.0.0.1/8 scope host lo
    inet 192.168.1.5/32 scope global lo
3: eth1: <BROADCAST,MULTICAST> mtu 1500 state DOWN
    inet 10.1.2.3/24 scope global eth1
4: eth2: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP
    inet 198.51.100.2/24 scope global eth2
    inet 169.254.10.11/16 scope link eth2
    inet 10.1.2.4/32 scope host eth2
    inet6 fe80::abcd/64 scope link`;

function addressShell(inventory, ...args) {
  const run = spawnSync(process.env.MAIL_TEST_POSIX_SH || '/bin/sh', ['-ec', `
    . "$1"; shift
    ip() { [ "$*" = "-4 addr show" ] && printf '%s\\n' "$LAN_FIXTURE"; }
    addresses=$(web_install_lan_addresses)
    if [ "$1" = scan ]; then printf '%s\\n' "$addresses"; else web_install_select_lan "$addresses" "$1" "$2"; fi
  `, 'sh', shellHost, ...args], {
    env: { ...process.env, LAN_FIXTURE: inventory }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 4000,
  });
  assert.ifError(run.error);
  assert.equal(run.signal, null);
  return { status: run.status, stdout: run.stdout.replace(/\r\n/g, '\n'), stderr: run.stderr };
}

test('the wizard discovers the current assigned IPv4 on each launch', lanShell, () => {
  for (const address of ['192.168.50.150', '192.168.50.151']) {
    const run = addressShell(`${ignoredAddresses}\n${addrHeader}\n    inet ${address}/24 brd 192.168.50.255 scope global eth0`, 'auto', '');
    assert.deepEqual(run, { status: 0, stdout: `${address}\n`, stderr: '' });
  }
  assert.deepEqual(addressShell(ignoredAddresses, 'scan'), { status: 0, stdout: '\n', stderr: '' });
});

test('unattended detection lists multiple addresses; the override must match a listed private IPv4', lanShell, () => {
  const inventory = `${addrHeader}
    inet 10.0.2.15/24 brd 10.0.2.255 scope global dynamic eth0
    inet 10.0.2.15/24 scope global secondary eth0:0
5: veth0@if7: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP
    inet 172.31.7.5/24 brd 172.31.7.255 scope global veth0`;
  const multi = addressShell(inventory, 'auto', '');
  assert.equal(multi.status, 2);
  assert.equal(multi.stdout, '');
  assert.match(multi.stderr, /1\) 10\.0\.2\.15 \(eth0\)/);
  assert.match(multi.stderr, /2\) 172\.31\.7\.5 \(veth0@if7\)/);
  assert.match(multi.stderr, /--listen/);
  assert.deepEqual(addressShell(inventory, '--listen', '172.31.7.5'), { status: 0, stdout: '172.31.7.5\n', stderr: '' });
  for (const invalid of ['', '0.0.0.0', '198.51.100.2', '172.31.7.6', '172.31.007.5']) {
    const rejected = addressShell(inventory, '--listen', invalid);
    assert.equal(rejected.status, 2, invalid);
    assert.equal(rejected.stdout, '', invalid);
  }
});

const alpineReposHelper = path.resolve(__dirname, '../scripts/lib/alpine-repositories.sh').replace(/\\/g, '/');
const alpineMain = 'http://mirrors.aliyun.com/alpine/v3.21/main';
const alpineCommunity = 'http://mirrors.aliyun.com/alpine/v3.21/community';

function repositoryShell(code, ...args) {
  const run = spawnSync(process.env.MAIL_TEST_POSIX_SH || '/bin/sh', ['-ec', `. "$1"; shift; ${code}`, 'sh', alpineReposHelper, ...args],
    { encoding: 'utf8', timeout: 5000 });
  assert.ifError(run.error);
  assert.equal(run.signal, null);
  return run;
}

function repositoriesFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-agg-repositories-'));
  const filename = path.join(directory, 'repositories');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, filename };
}

test('Alpine community is derived from the active same-release mirror; existing and custom sources are respected', lanShell, t => {
  const { filename } = repositoriesFixture(t);
  const cases = [
    [`#/media/cdrom/apks\n${alpineMain}`, '3.21.7', 0, alpineCommunity],
    [` ${alpineMain}/\t # current mirror\n#${alpineCommunity}\n`, '3.21.9', 0, alpineCommunity],
    [`${alpineMain}\n${alpineCommunity}/\n`, '3.21.9', 0, ''],
    [`${alpineMain}\nhttps://mirror.example/alpine/v3.21/community\n`, '3.21.9', 0, ''],
    ['https://mirror.example/alpine/v3.24/main\n', '3.24.4', 0, 'https://mirror.example/alpine/v3.24/community'],
    [`${alpineMain}\n@testing https://mirror.example/alpine/edge/testing\n`, '3.21.7', 0, alpineCommunity],
    [`${alpineMain}\nhttps://mirror.example/alpine/v3.24/community\n`, '3.21.7', 2, ''],
    ['https://mirror.example/alpine/v3.210/main\n', '3.21.7', 2, ''],
    ['@local https://mirror.example/alpine/v3.21/main\n/media/cdrom/apks\n', '3.21.7', 2, ''],
  ];
  for (const [contents, version, status, url] of cases) {
    fs.writeFileSync(filename, contents);
    const probe = repositoryShell('alpine_community_candidate "$1" "$2"', filename.replace(/\\/g, '/'), version);
    assert.equal(probe.status, status, probe.stderr || contents);
    assert.equal(probe.stdout.trim(), url);
    assert.equal(fs.readFileSync(filename, 'utf8'), contents);
  }
});

test('Alpine keeps the original software sources if index refresh fails, and preserves a backup when it succeeds', lanShell, t => {
  const { directory, filename } = repositoriesFixture(t);
  const original = `# local configuration\n${alpineMain}`;
  const updated = `${original}\n${alpineCommunity}\n`;
  fs.writeFileSync(filename, original, { mode: 0o600 });
  const config = `
    repos=$1
    result=$2
    before=$3
    proposed=$4
    apk() {
      [ "$#" -eq 3 ] && [ "$1" = --repositories-file ] && [ "$3" = update ] &&
        [ "$(cat "$repos")" = "$before" ] && [ "$(cat "$2")" = "$proposed" ] || return 19
      printf '%s\\n' 'refresh received staged sources'
      return "$result"
    }
    candidate=$(alpine_community_candidate "$repos" 3.21.7)
    [ -z "$candidate" ] || alpine_enable_community "$repos" "$candidate" 3.21.7
  `;
  const apply = result => repositoryShell(config, filename.replace(/\\/g, '/'), String(result), original, updated.trimEnd());
  const failed = apply(1);
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /refresh received staged sources/);
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  const success = apply(0);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /refresh received staged sources/);
  assert.equal(fs.readFileSync(filename, 'utf8'), updated);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  const artifacts = fs.readdirSync(directory).filter(name => name !== 'repositories');
  assert.ok(artifacts.length > 0);
  assert.ok(artifacts.every(name => name.startsWith('repositories.mail-aggregator.bak.') &&
    fs.readFileSync(path.join(directory, name), 'utf8') === original));
  assert.deepEqual([apply(0).status, fs.readFileSync(filename, 'utf8')], [0, updated]);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name !== 'repositories'), artifacts);
});
