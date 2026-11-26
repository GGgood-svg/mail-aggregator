'use strict';
// Runs from the root-owned maintenance directory, never the Web deployment.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const config = '/etc/dovecot';
const marker = '/etc/mail-aggregator/owned-dovecot.json';
const packages = { alpine: ['dovecot', 'dovecot-openrc'], apt: ['dovecot-core', 'dovecot-imapd'] };
const packageName = /^[a-z0-9][a-z0-9+.-]*$/;
const userName = /^[a-z_][a-z0-9_-]{0,31}$/;
const mutable = new Set(['users', 'users.mail-aggregator-backup']);
const check = (ok) => { if (!ok) throw new Error('Dovecot ownership or package removal could not be verified'); };
function exists(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function command(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' } });
  check(result.status === 0 && !result.error);
  return result.stdout;
}
function installed(platform) {
  if (platform === 'alpine') return command('apk', ['info']).split('\n').filter(x => packageName.test(x)).sort();
  return command('dpkg-query', ['-W', '-f=${Package}\t${db:Status-Status}\n']).split('\n')
    .map(line => line.split('\t')).filter(([name, status]) => packageName.test(name) && status === 'installed')
    .map(([name]) => name).sort();
}
function readConfig(user, { partial = false } = {}) {
  const state = Object.create(null);
  const root = exists(config);
  if (!root && partial) return { state, root: null };
  check(root?.isDirectory());
  // Include bind mounts on the same device. A symlink is recorded, never followed.
  check(!fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line => {
    const p = line.split(' ')[4];
    return p === config || p?.startsWith(`${config}/`);
  }));
  function walk(relative, stat) {
    check(stat.uid === 0 && stat.dev === root.dev && Object.keys(state).length < 512);
    const full = path.join(config, relative);
    if (stat.isSymbolicLink()) {
      check(!mutable.has(relative));
      state[relative] = `link:${fs.readlinkSync(full)}`;
      return;
    }
    check((stat.mode & 0o022) === 0);
    if (stat.isDirectory()) {
      if (relative) state[relative] = 'directory';
      for (const item of fs.readdirSync(full)) {
        const child = path.join(relative, item);
        walk(child, fs.lstatSync(path.join(config, child)));
      }
      return;
    }
    check(stat.isFile() && stat.nlink === 1 && stat.size <= 4 * 1024 * 1024);
    const bytes = fs.readFileSync(full);
    if (mutable.has(relative)) {
      // The app legitimately replaces this hash; any extra user or directive
      // makes the entire install ineligible for automatic removal.
      const lines = bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
      check(lines.length === 1 && lines[0].startsWith(`${user}:`) && /^\{[A-Z0-9-]+\}[^:\s]+$/.test(lines[0].slice(user.length + 1)));
      if (relative === 'users.mail-aggregator-backup') return;
      state[relative] = 'managed-user';
      return;
    }
    state[relative] = createHash('sha256').update(bytes).digest('hex');
  }
  walk('', root);
  return { state, root: `${root.dev}:${root.ino}` };
}
function removals(platform, output, expected, allowed) {
  const found = [];
  for (const line of output.split('\n')) {
    if (platform === 'alpine' && /^\(\s*\d+\/\d+\)/.test(line)) {
      const match = /^\(\s*(\d+)\/(\d+)\) Purging ([a-z0-9][a-z0-9+.-]*) \([^\r\n]+\)$/.exec(line);
      check(match && Number(match[1]) === found.length + 1);
      found.push({ name: match[3], total: Number(match[2]) });
    } else if (platform === 'apt' && /^(Purg|Remv|Inst|Conf)\s/.test(line)) {
      const match = /^Purg ([a-z0-9][a-z0-9+.-]*)(?:\s|$)/.exec(line);
      check(match);
      found.push({ name: match[1] });
    }
  }
  const names = found.map(item => item.name);
  check(new Set(names).size === names.length && expected.every(name => names.includes(name)) &&
    found.every(item => allowed.includes(item.name) && (platform !== 'alpine' || item.total === found.length)));
}
function readOwnership() {
  const file = exists(marker);
  check(file?.isFile() && file.nlink === 1 && file.uid === 0 && (file.mode & 0o777) === 0o600 && file.size < 128 * 1024);
  const data = JSON.parse(fs.readFileSync(marker, 'utf8'));
  check(Object.hasOwn(packages, data.platform) && userName.test(data.user) && Array.isArray(data.added) && data.added.every(name => packageName.test(name)) &&
    data.config && typeof data.config === 'object' && typeof data.root === 'string');
  return data;
}
function validate(data, partial = false) {
  const current = readConfig(data.user, { partial });
  check(current.root === data.root || (partial && current.root === null));
  const oldKeys = Object.keys(data.config).sort();
  const newKeys = Object.keys(current.state).sort();
  check((partial || oldKeys.length === newKeys.length) && newKeys.every(key => Object.hasOwn(data.config, key) && data.config[key] === current.state[key]));
  return current;
}
function plan(data) {
  validate(data);
  const expected = packages[data.platform];
  const current = installed(data.platform);
  check(expected.every(name => data.added.includes(name) && current.includes(name)) &&
    current.filter(name => /^dovecot(?:-|$)/.test(name)).every(name => expected.includes(name)));
  const simulation = data.platform === 'alpine'
    ? command('apk', ['del', '--simulate', '--no-progress', ...expected])
    : command('apt-get', ['-s', 'purge', ...expected]);
  removals(data.platform, simulation, expected, data.platform === 'alpine' ? data.added : expected);
}
function assertStopped() {
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    let executable;
    try { executable = fs.readlinkSync(`/proc/${pid}/exe`); }
    catch (error) { if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) continue; throw error; }
    check(!/^\/usr\/(?:sbin\/dovecot(?: |$)|lib(?:exec)?\/dovecot\/)/.test(executable));
  }
}
function remove(data) {
  plan(data);
  const expected = packages[data.platform];
  if (data.platform === 'alpine') {
    if (exists('/etc/init.d/dovecot')) command('rc-service', ['--ifstarted', 'dovecot', 'stop']);
    const runlevels = command('rc-update', ['show']).split('\n')
      .find(line => /^\s*dovecot\s+\|/.test(line))?.split('|')[1].trim().split(/\s+/).filter(Boolean) || [];
    if (runlevels.length) command('rc-update', ['del', 'dovecot', ...runlevels]);
  } else {
    command('systemctl', ['disable', '--now', 'dovecot.service']);
    check(command('systemctl', ['show', '-p', 'MainPID', '--value', 'dovecot.service']).trim() === '0');
  }
  assertStopped();
  plan(data);
  if (data.platform === 'alpine') command('apk', ['del', '--no-progress', ...expected]);
  else command('apt-get', ['-y', 'purge', ...expected]);
  const remaining = installed(data.platform);
  check(expected.every(name => !remaining.includes(name)));
  assertStopped();
  const { state, root } = validate(data, true);
  if (root !== null) {
    const backup = 'users.mail-aggregator-backup';
    if (exists(path.join(config, backup))) fs.unlinkSync(path.join(config, backup));
    for (const key of Object.keys(state).sort((a, b) => b.split('/').length - a.split('/').length)) {
      const full = path.join(config, key);
      if (state[key] === 'directory') fs.rmdirSync(full);
      else fs.unlinkSync(full);
    }
    fs.rmdirSync(config);
  }
  check(!exists(config));
}
function main([action, platform, user, before]) {
  check(process.getuid?.() === 0);
  if (action === 'packages') {
    check(Object.hasOwn(packages, platform));
    process.stdout.write(installed(platform).join('\n') + '\n');
    return;
  }
  if (action === 'record') {
    check(Object.hasOwn(packages, platform) && userName.test(user) && typeof before === 'string' && !exists(marker));
    const prior = new Set(before.split('\n').filter(Boolean));
    check(![...prior].some(name => /^dovecot(?:-|$)/.test(name)));
    const added = installed(platform).filter(name => !prior.has(name));
    check(packages[platform].every(name => added.includes(name)));
    const current = readConfig(user);
    check(current.state.users === 'managed-user');
    fs.writeFileSync(marker, JSON.stringify({ platform, user, added, root: current.root, config: current.state }) + '\n', { flag: 'wx', mode: 0o600 });
    return;
  }
  const data = readOwnership();
  if (action === 'eligible') validate(data);
  else if (action === 'plan') plan(data);
  else if (action === 'remove') remove(data);
  else check(false);
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (_) { process.exitCode = 1; }
}
module.exports = { removals };
