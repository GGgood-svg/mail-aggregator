'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { createBackupBundle, hashFile } = require('./backup');
const { verifyBackupArchive } = require('./backup-verifier');
const { createMaildirBackup, verifyMaildirBackup, stageMaildirSubset, within, passphraseFile } = require('./maildir-backup');
const scrypt = promisify(crypto.scrypt);
const PAIR_NAME = /^backup-set-[0-9a-f-]{36}$/;
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const ROOT = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u;
const SNAPSHOT_NAME = /^[\p{L}\p{N}_. :@/+-]{1,160}$/u;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_ACCOUNTS = 2000;
const APP = 'application.tar.gz';
const MAIL = 'maildir.tar.gz.gpg';
const MANIFEST = 'backup-set.json';

function privateDirectory(candidate) {
  const resolved = fs.realpathSync(candidate), stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077 || stat.uid !== process.getuid()))) {
    throw new Error('备份及演练目录必须由当前用户拥有，权限为 0700 或更严格');
  }
  return resolved;
}
function privateFile(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077n || stat.uid !== BigInt(process.getuid())))) {
    throw new Error('配对文件必须是当前用户拥有的私有普通文件');
  }
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function fsync(file, directory = false) {
  if (directory && process.platform === 'win32') return;
  const fd = fs.openSync(file, directory ? 'r' : 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function cleanWork(parent, work, prefix) {
  const resolved = fs.realpathSync(work);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(prefix)) throw new Error('无法确认演练暂存目录');
  fs.rmSync(resolved, { recursive: true, force: true });
}
function equalsDigest(a, b) {
  return typeof a === 'string' && typeof b === 'string' && HEX.test(a) && HEX.test(b)
    && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
async function manifestMac(body, passphrase) {
  const bytes = fs.readFileSync(passphraseFile(passphrase));
  let key;
  try {
    const length = bytes[bytes.length - 1] === 10 ? bytes.length - (bytes[bytes.length - 2] === 13 ? 2 : 1) : bytes.length;
    key = await scrypt(bytes.subarray(0, length), `mail-aggregator/backup-set/v1/${body.backupSetId}`, 32,
      { N: 32768, maxmem: 64 * 1024 * 1024 });
    return crypto.createHmac('sha256', key).update(JSON.stringify(body)).digest('hex');
  } finally { bytes.fill(0); key?.fill(0); }
}
function inventory(database, mailboxUser) {
  const rows = database.prepare(`SELECT id,name,provider,username,local_user,destination_mode,mailbox_folder,destination_folder
    FROM accounts ORDER BY id LIMIT ?`).all(MAX_ACCOUNTS + 1);
  if (rows.length > MAX_ACCOUNTS) throw new Error('账号数超出恢复规划上限');
  return rows.map(row => {
    const root = row.mailbox_folder || row.destination_folder;
    return { id: row.id, name: String(row.name).slice(0, 256), provider: String(row.provider).slice(0, 64),
      username: String(row.username).slice(0, 320), localUser: String(row.local_user).slice(0, 128),
      root: typeof root === 'string' && ROOT.test(root) && row.destination_mode === 'subfolder' ? root : null,
      scope: row.local_user !== mailboxUser ? 'outside_snapshot' : row.destination_mode === 'subfolder' && ROOT.test(root || '') ? 'bounded' : 'unmapped' };
  });
}
function createCoverage(accounts) {
  const byRoot = new Map();
  const report = accounts.map(account => ({ ...account, messages: 0, messageBytes: 0, folders: 0,
    firstMaildirTimestamp: null, lastMaildirTimestamp: null }));
  for (const account of report) {
    if (account.scope !== 'bounded') continue;
    const key = account.root.toLowerCase();
    if (byRoot.has(key)) {
      if (byRoot.get(key)) byRoot.get(key).scope = 'name_conflict';
      account.scope = 'name_conflict'; byRoot.set(key, null);
    } else byRoot.set(key, account);
  }
  let unmappedMessages = 0;
  const onEntry = entry => {
    const [folder, type, file, ...rest] = entry.path.split('/');
    const stem = folder.startsWith('.') ? folder.slice(1).split('.', 1)[0] : null;
    let account = byRoot.get(stem?.toLowerCase());
    if (account && stem !== account.root) {
      // Different case can be a different physical mailbox in Maildir++.
      // Do not import an ambiguous spelling into somebody's known scope.
      account.scope = 'name_conflict'; unmappedMessages += account.messages;
      account.messages = 0; account.messageBytes = 0; account.folders = 0;
      account.firstMaildirTimestamp = null; account.lastMaildirTimestamp = null;
      byRoot.set(stem.toLowerCase(), null); account = null;
    }
    if (type === 'cur' && entry.directory && !file && account) account.folders++;
    const message = !entry.directory && (['cur','new'].includes(type) && file && !rest.length
      || ['cur','new'].includes(folder) && type && !file);
    if (!message) return;
    if (!account) { unmappedMessages++; return; }
    account.messages++; account.messageBytes += entry.size;
    if (Number.isFinite(entry.mtime)) {
      const time = new Date(entry.mtime * 1000).toISOString();
      if (!account.firstMaildirTimestamp || time < account.firstMaildirTimestamp) account.firstMaildirTimestamp = time;
      if (!account.lastMaildirTimestamp || time > account.lastMaildirTimestamp) account.lastMaildirTimestamp = time;
    }
  };
  return { onEntry, result: () => ({ accounts: report.map(account => account.scope === 'bounded'
    ? { ...account, scope: account.folders || account.messages ? 'covered' : 'root_not_found' } : account), unmappedMessages }) };
}

async function createBackupPair({ db, dirs, version, directory, source, passphrase, mailboxUser, snapshotId, stableSource, mailTools = {} }) {
  if (!stableSource) throw new Error('必须确认 Maildir 来自稳定快照或已停止写入');
  if (!SNAPSHOT_NAME.test(snapshotId || '') || !/^[\w.@-]{1,128}$/u.test(mailboxUser || '')) throw new Error('必须提供稳定快照标识和本地邮箱用户名');
  const parent = privateDirectory(directory), sourceDir = fs.realpathSync(source);
  if (within(sourceDir, parent) || within(fs.realpathSync(dirs.root), parent)) throw new Error('配对备份不得写入应用数据目录或源 Maildir');
  const pairId = crypto.randomUUID(), final = path.join(parent, `backup-set-${pairId}`);
  const captureStart = new Date().toISOString();
  const work = fs.mkdtempSync(path.join(parent, '.backup-set-'));
  fs.chmodSync(work, 0o700);
  let bundle, published = false;
  try {
    const Database = require('better-sqlite3');
    bundle = await createBackupBundle({ db, dirs, version, inspectSnapshot(file) {
      const snapshot = new Database(file, { readonly: true, fileMustExist: true });
      try { return inventory(snapshot, mailboxUser); } finally { snapshot.close(); }
    } });
    const application = path.join(work, APP), mail = path.join(work, MAIL);
    fs.copyFileSync(bundle.archivePath, application, fs.constants.COPYFILE_EXCL); fs.chmodSync(application, 0o600);
    await verifyBackupArchive(application, bundle.sha256);
    const coverage = createCoverage(bundle.snapshot);
    const { archive, entries, bytes, expandedBytes } = await createMaildirBackup({ ...mailTools, source: sourceDir, directory: work,
      passphrase, stableSource: true, onEntry: coverage.onEntry });
    fs.renameSync(archive, mail);
    const body = { format: 1, backupSetId: pairId, captureStart, captureEnd: new Date().toISOString(),
      snapshot: { id: snapshotId, mailboxUser, consistency: 'operator_confirmed_stable_source', layout: 'maildir++' },
      application: { version, sha256: bundle.sha256 },
      maildir: { sha256: await hashFile(mail), entries, bytes, expandedBytes },
      ...coverage.result() };
    const manifestText = `${JSON.stringify({ body, mac: await manifestMac(body, passphrase) }, null, 2)}\n`;
    if (Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) throw new Error('恢复规划清单超出上限');
    const manifest = path.join(work, MANIFEST);
    fs.writeFileSync(manifest, manifestText, { flag: 'wx', mode: 0o600 });
    for (const file of [application, mail, manifest]) fsync(file);
    fsync(work, true);
    fs.renameSync(work, final); published = true;
    fsync(parent, true);
    return { directory: final, ...body };
  } finally {
    try { bundle?.cleanup(); }
    finally { if (!published) cleanWork(parent, work, '.backup-set-'); }
  }
}

async function verifyBackupPair({ directory, passphrase, mailTools = {}, compareDatabase = null }) {
  const pair = privateDirectory(directory), manifest = path.join(pair, MANIFEST);
  privateFile(manifest);
  if (fs.statSync(manifest).size > MAX_MANIFEST_BYTES) throw new Error('配对清单超出上限');
  const { body, mac } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (body?.format !== 1 || !ID.test(body.backupSetId || '') || !PAIR_NAME.test(path.basename(pair))
      || path.basename(pair) !== `backup-set-${body.backupSetId}` || !HEX.test(body.application?.sha256 || '')
      || !HEX.test(body.maildir?.sha256 || '') || !Array.isArray(body.accounts) || body.accounts.length > MAX_ACCOUNTS) {
    throw new Error('配对清单格式或目录标识错误');
  }
  if (!equalsDigest(mac, await manifestMac(body, passphrase))) throw new Error('配对清单校验失败');
  const app = path.join(pair, APP), mail = path.join(pair, MAIL);
  const appIdentity = privateFile(app), mailIdentity = privateFile(mail);
  // Check both identities before processing either archive; a misplaced
  // archive must be rejected even if it is otherwise a valid backup.
  const [appHash, mailHash] = await Promise.all([hashFile(app), hashFile(mail)]);
  if (!equalsDigest(body.application.sha256, appHash) || !equalsDigest(body.maildir.sha256, mailHash)) throw new Error('备份文件与同一组清单不匹配');
  const verifiedApp = await verifyBackupArchive(app, appHash);
  const verifiedMail = await verifyMaildirBackup({ ...mailTools, archive: mail, passphrase });
  if (appIdentity !== privateFile(app) || mailIdentity !== privateFile(mail) || verifiedMail.entries !== body.maildir.entries
      || verifiedMail.bytes !== body.maildir.bytes || verifiedMail.expandedBytes !== body.maildir.expandedBytes) throw new Error('校验期间备份变化或邮件清单不一致');
  let localComparison;
  if (compareDatabase) {
    const current = inventory(compareDatabase, body.snapshot.mailboxUser);
    localComparison = body.accounts.map(row => {
      const matches = current.filter(item => item.localUser === row.localUser && item.root && row.root
        && item.root.toLowerCase() === row.root.toLowerCase());
      return { backupAccountId: row.id, status: !matches.length ? 'no_current_match'
        : matches.length === 1 && matches[0].provider === row.provider && matches[0].username === row.username
          ? 'same_scope_and_source' : 'name_conflict' };
    });
  }
  return { directory: pair, ...body, verified: true, appFileCount: verifiedApp.fileCount, ...(localComparison ? { localComparison } : {}) };
}

async function rehearseBackupAccount({ directory, output, passphrase, accountId, mailTools = {} }) {
  const verified = await verifyBackupPair({ directory, passphrase, mailTools });
  const account = verified.accounts.find(row => row.id === Number(accountId));
  if (!account || account.scope !== 'covered' || !ROOT.test(account.root)) throw new Error('没有可独立演练的账号目录');
  const parent = privateDirectory(output);
  if (within(verified.directory, parent)) throw new Error('演练目录不得位于备份组内');
  const started = performance.now();
  const mailFile = path.join(verified.directory, MAIL);
  const before = privateFile(mailFile);
  if (!equalsDigest(await hashFile(mailFile), verified.maildir.sha256) || before !== privateFile(mailFile)) {
    throw new Error('备份在演练前有变动');
  }
  const work = fs.mkdtempSync(path.join(parent, '.backup-account-'));
  fs.chmodSync(work, 0o700);
  const selected = path.join(work, 'Maildir'), result = path.join(parent, `backup-account-${crypto.randomUUID()}`);
  let published = false;
  try {
    fs.mkdirSync(selected, { mode: 0o700 });
    const root = `.${account.root}`;
    const replay = await stageMaildirSubset({ ...mailTools, archive: mailFile, directory: selected, passphrase, select({ path: name }) {
      const top = name.split('/', 1)[0];
      return top === root || top.startsWith(`${root}.`);
    } });
    if (before !== privateFile(mailFile) || replay.entries !== verified.maildir.entries || replay.bytes !== verified.maildir.bytes) {
      throw new Error('备份在演练期间有变动');
    }
    const exported = fs.readdirSync(selected, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('.')).length;
    if (!exported) throw new Error('邮件目录与配对清单不一致');
    const report = { backupSetId: verified.backupSetId, backupAccountId: account.id, foldersExported: exported,
      messagesInArchive: account.messages, messageBytesInArchive: account.messageBytes,
      firstMaildirTimestamp: account.firstMaildirTimestamp ?? null, lastMaildirTimestamp: account.lastMaildirTimestamp ?? null,
      localExtractionMs: Math.round(performance.now() - started), assurance: 'isolated_files_only',
      nextChecks: ['check_owner_permissions', 'start_isolated_dovecot', 'verify_login_folder_uids_flags_and_sample_messages'] };
    fs.writeFileSync(path.join(work, 'rehearsal.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(work, result); published = true;
    return { directory: path.join(result, 'Maildir'), ...report };
  } finally {
    if (!published) cleanWork(parent, work, '.backup-account-');
  }
}

module.exports = { createBackupPair, verifyBackupPair, rehearseBackupAccount, createCoverage };
