'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { validateMaildirTar } = require('./maildir-tar');

const BACKUP_NAME = /^maildir-\d{8}T\d{6}Z-[a-f0-9]{12}\.tar\.gz\.gpg$/;

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function existingDirectory(value) {
  const absolute = fs.realpathSync(value);
  if (!fs.statSync(absolute).isDirectory()) throw new Error('指定路径不是目录');
  return absolute;
}
function passphraseFile(value) {
  const stat = fs.lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw new Error('口令文件必须是普通文件且不超过 2048 字节');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) throw new Error('口令文件必须属于当前用户且权限为 0600 或更严格');
  const bytes = fs.readFileSync(value);
  const text = bytes.toString('utf8').replace(/\r?\n$/, '');
  bytes.fill(0);
  if (Buffer.byteLength(text, 'utf8') < 16 || /[\r\n\0]/.test(text)) throw new Error('口令至少需要 16 字节且只能有一行');
  return fs.realpathSync(value);
}
function assertMaildir(directory) {
  for (const name of ['cur', 'new', 'tmp']) {
    const stat = fs.lstatSync(path.join(directory, name));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('源目录不是完整的 Maildir');
  }
}
function assertOutsideMaildir(directory) {
  let current = directory;
  for (;;) {
    if (['cur', 'new', 'tmp'].every(name => {
      try { return fs.statSync(path.join(current, name)).isDirectory(); } catch (_) { return false; }
    })) throw new Error('演练目录不能位于 Maildir 内');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function tools(options = {}) {
  return { gpg: options.gpg || 'gpg', tar: options.tar || 'tar', gpgconf: options.gpgconf || 'gpgconf',
    homeBase: options.homeBase || os.tmpdir(), toolPath: options.toolPath || (value => value) };
}
function childResult(child, label) {
  let diagnostic = '';
  child.stderr?.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4096); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${label}失败 (${code}): ${diagnostic.trim().slice(-600)}`)));
  });
}
function stop(children) { for (const child of children) { try { child.kill(); } catch (_) {} } }
async function allOrStop(promises, children) {
  try { return await Promise.all(promises); }
  catch (error) { stop(children); await Promise.allSettled(promises); throw error; }
}
async function withGpgHome(config, operation) {
  const parent = existingDirectory(config.homeBase);
  const home = fs.mkdtempSync(path.join(parent, 'mail-gnupg-'));
  fs.chmodSync(home, 0o700);
  try { return await operation(home); }
  finally {
    await new Promise(resolve => execFile(config.gpgconf, ['--homedir', config.toolPath(home), '--kill', 'gpg-agent'], { timeout: 5000 }, () => resolve()));
    const resolved = fs.realpathSync(home);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('mail-gnupg-')) throw new Error('拒绝清理非临时目录');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
function gpgArgs(config, home, key) {
  return ['--no-options', '--homedir', config.toolPath(home), '--batch', '--no-tty', '--pinentry-mode', 'loopback',
    '--no-symkey-cache', '--passphrase-file', config.toolPath(key)];
}
async function encryptTar(config, home, key, source, destination) {
  const tar = spawn(config.tar, ['--format=posix', '--hard-dereference', '-cf', '-', '-C', config.toolPath(source), '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const gpg = spawn(config.gpg, [...gpgArgs(config, home, key), '--cipher-algo', 'AES256', '--compress-algo', 'none', '--symmetric'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const pending = [childResult(tar, 'tar'), childResult(gpg, '加密'), pipeline(tar.stdout, zlib.createGzip(), gpg.stdin), pipeline(gpg.stdout, out)];
  await allOrStop(pending, [tar, gpg]);
}
async function verifyWithHome(config, home, key, archive, { onEntry, openEntry } = {}) {
  const gpg = spawn(config.gpg, [...gpgArgs(config, home, key), '--decrypt', config.toolPath(archive)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const pending = [childResult(gpg, '解密验证'), validateMaildirTar(gpg.stdout, { onEntry, openEntry })];
  const [, summary] = await allOrStop(pending, [gpg]);
  return summary;
}
async function decryptToFile(config, home, key, archive, destination) {
  const gpg = spawn(config.gpg, [...gpgArgs(config, home, key), '--decrypt', config.toolPath(archive)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  await allOrStop([childResult(gpg, '解密'), pipeline(gpg.stdout, out)], [gpg]);
}
async function extractArchive(config, archive, destination) {
  const child = spawn(config.tar, ['--extract', '--file', '-', '--directory', config.toolPath(destination),
    '--no-same-owner', '--no-same-permissions', '--keep-old-files'], { stdio: ['pipe', 'ignore', 'pipe'] });
  await allOrStop([childResult(child, '恢复演练'), pipeline(fs.createReadStream(archive), zlib.createGunzip(), child.stdin)], [child]);
}
function safeRemoveWork(parent, work) {
  const resolved = fs.realpathSync(work);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('maildir-rehearsal-')) throw new Error('拒绝清理非演练目录');
  fs.rmSync(resolved, { recursive: true, force: true });
}
function pruneBackups(directory, keep, protectedName = null) {
  if (keep === undefined || keep === null) return 0;
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Error('保留数量必须为 1 至 365');
  const items = fs.readdirSync(directory).filter(name => BACKUP_NAME.test(name)).map(name => {
    const stat = fs.lstatSync(path.join(directory, name));
    return { name, stat };
  }).filter(item => item.stat.isFile() && !item.stat.isSymbolicLink())
    .sort((a, b) => Number(b.name === protectedName) - Number(a.name === protectedName) || b.stat.mtimeMs - a.stat.mtimeMs || b.name.localeCompare(a.name));
  let removed = 0;
  for (const item of items.slice(keep)) {
    const target = path.join(directory, item.name), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    fs.unlinkSync(target); removed++;
  }
  return removed;
}

async function withBackupLock(directory, work) {
  const filename = path.join(directory, '.maildir-backup.lock');
  const token = crypto.randomBytes(18).toString('hex');
  let fd;
  try { fd = fs.openSync(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('备份目录已有任务或残留锁，请检查后重试');
    throw error;
  }
  try { fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(filename); throw error; }
  fs.closeSync(fd);
  try { return await work(); }
  finally {
    const owner = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (owner.token !== token) throw new Error('备份锁所有者发生变化');
    fs.unlinkSync(filename);
  }
}

async function createMaildirBackup({ source, directory, passphrase, stableSource, keep, ...options }) {
  if (stableSource !== true) throw new Error('请先提供稳定快照或停写后的 Maildir，并明确确认');
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1 || keep > 365)) throw new Error('保留数量必须为 1 至 365');
  const sourceDir = existingDirectory(source), backupDir = existingDirectory(directory), key = passphraseFile(passphrase);
  const config = tools(options), homeBase = existingDirectory(config.homeBase);
  assertMaildir(sourceDir);
  if (within(sourceDir, backupDir) || within(sourceDir, key) || within(sourceDir, homeBase)) throw new Error('备份目录、临时目录和口令文件不能位于源 Maildir 内');
  return withBackupLock(backupDir, async () => {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const name = `maildir-${stamp}-${crypto.randomBytes(6).toString('hex')}.tar.gz.gpg`;
    const finalPath = path.join(backupDir, name), partial = `${finalPath}.partial`;
    try {
      const summary = await withGpgHome(config, async home => {
        await encryptTar(config, home, key, sourceDir, partial);
        return verifyWithHome(config, home, key, partial, { onEntry: options.onEntry });
      });
      fs.linkSync(partial, finalPath); fs.unlinkSync(partial);
      const removed = pruneBackups(backupDir, keep, name);
      return { archive: finalPath, ...summary, removed };
    } catch (error) { try { fs.unlinkSync(partial); } catch (_) {} throw error; }
  });
}
async function verifyMaildirBackup({ archive, passphrase, ...options }) {
  const archivePath = fs.realpathSync(archive), key = passphraseFile(passphrase), config = tools(options);
  if (!fs.statSync(archivePath).isFile()) throw new Error('备份不是普通文件');
  return withGpgHome(config, home => verifyWithHome(config, home, key, archivePath, { onEntry: options.onEntry }));
}
async function rehearseMaildirBackup({ archive, directory, passphrase, ...options }) {
  const parent = existingDirectory(directory), archivePath = fs.realpathSync(archive), key = passphraseFile(passphrase), config = tools(options);
  assertOutsideMaildir(parent);
  const work = fs.mkdtempSync(path.join(parent, 'maildir-rehearsal-'));
  fs.chmodSync(work, 0o700);
  const compressed = path.join(work, 'verified.tar.gz'), destination = path.join(work, 'Maildir');
  try {
    await withGpgHome(config, home => decryptToFile(config, home, key, archivePath, compressed));
    const summary = await validateMaildirTar(fs.createReadStream(compressed));
    fs.mkdirSync(destination, { mode: 0o700 });
    await extractArchive(config, compressed, destination);
    assertMaildir(destination);
    fs.unlinkSync(compressed);
    return { directory: destination, ...summary };
  } catch (error) { safeRemoveWork(parent, work); throw error; }
}

// The selected tree is staged in a fresh private directory owned by the
// caller. Unselected entries are validated and discarded from the stream.
// The caller must publish only on success and remove staging on any failure.
async function stageMaildirSubset({ archive, directory, passphrase, select, ...options }) {
  const destination = existingDirectory(directory), archivePath = fs.realpathSync(archive);
  const key = passphraseFile(passphrase), config = tools(options);
  assertOutsideMaildir(path.dirname(destination));
  if (fs.readdirSync(destination).length || typeof select !== 'function') throw new Error('需要空的演练暂存目录');
  let active;
  try {
    const summary = await withGpgHome(config, home => verifyWithHome(config, home, key, archivePath, {
      async openEntry(entry) {
        if (!entry.path || !select(entry)) return null;
        const parts = entry.path.split('/');
        if (process.platform === 'win32' && parts.some(part => /[<>:"|?*]|[ .]$|^(?:con|prn|aux|nul|(?:com|lpt)[0-9])(?:\.|$)/i.test(part))) {
          throw new Error('选中的 Maildir 路径不适用于 Windows；请在 Linux 上演练');
        }
        const target = path.resolve(destination, ...parts);
        if (!within(destination, target) || target === destination) throw new Error('演练路径超出暂存目录');
        if (entry.directory) {
          await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
          return null;
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const file = await fs.promises.open(target, 'wx', 0o600);
        active = file;
        return {
          async write(part) {
            let offset = 0;
            while (offset < part.length) {
              const { bytesWritten } = await file.write(part, offset, part.length - offset);
              if (!bytesWritten) throw new Error('无法写入演练邮件');
              offset += bytesWritten;
            }
          },
          async finish() {
            const time = new Date(entry.mtime * 1000);
            await file.utimes(time, time);
            await file.close();
            active = undefined;
          },
        };
      },
    }));
    for (const name of ['cur', 'new', 'tmp']) await fs.promises.mkdir(path.join(destination, name), { mode: 0o700 });
    return summary;
  } finally { if (active) await active.close(); }
}

module.exports = { createMaildirBackup, verifyMaildirBackup, rehearseMaildirBackup, stageMaildirSubset,
  pruneBackups, withBackupLock, within, passphraseFile, BACKUP_NAME };
