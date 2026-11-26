'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const express = require('express');
const { ImapFlow } = require('imapflow');
const { createMailRouter } = require('../server/mail-reader');
const Database = require('better-sqlite3');

function testClient() {
  if (process.env.MAIL_TEST_IMAP_ALLOW_WRITE !== 'synthetic-only' || !process.env.MAIL_TEST_IMAP_USER || !process.env.MAIL_TEST_IMAP_PASSWORD) {
    throw new Error('This test requires a disposable local Dovecot account and MAIL_TEST_IMAP_ALLOW_WRITE=synthetic-only');
  }
  const port = Number(process.env.MAIL_TEST_IMAP_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Set a dedicated local test IMAP port');
  const options = { host: '127.0.0.1', port, secure: false, doSTARTTLS: false,
    auth: { user: process.env.MAIL_TEST_IMAP_USER, pass: process.env.MAIL_TEST_IMAP_PASSWORD }, logger: false, disableAutoIdle: true };
  const imap = new ImapFlow(options);
  imap.on('error', () => {});
  return imap;
}

async function taskResult(base, id) {
  for (let i = 0; i < 160; i++) {
    const response = await fetch(`${base}/tasks/${id}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    if (result.finishedAt) return result;
    await delay(50);
  }
  throw new Error('Mail task did not finish');
}

test('isolated Dovecot preserves mail, durable rule actions and UIDVALIDITY across API operations', async t => {
  const client = testClient;
  const control = client();
  let folder = `CodexTest${crypto.randomBytes(8).toString('hex')}`;
  let created = false, server, router;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-dovecot-rules-'));
  const savedDb = new Database(path.join(root, 'tasks.db'));
  savedDb.exec(`CREATE TABLE saved_searches(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_user_id INTEGER,name TEXT,
    scope TEXT,folder TEXT,filters_json TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
    PRAGMA foreign_keys=ON; CREATE TABLE admin_users(id INTEGER PRIMARY KEY); INSERT INTO admin_users VALUES(1);`);
  t.after(async () => {
    if (router) await router.mailTasks.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    try {
      if (created && control.usable) {
        if (control.mailbox) await control.mailboxClose();
        await control.mailboxDelete(folder);
      }
    } finally {
      if (control.usable) await control.logout().catch(() => control.close()); else control.close();
      savedDb.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  await control.connect();
  const initial = await control.mailboxCreate(folder);
  if (!initial?.created || typeof initial.path !== 'string' ||
      !(initial.path === folder || initial.path.endsWith(`.${folder}`) || initial.path.endsWith(`/${folder}`))) {
    throw new Error('Refusing to use a pre-existing or unexpected test folder');
  }
  folder = initial.path; created = true;
  const original = Buffer.from([
    'From: Synthetic <sender@example.invalid>', 'To: Reader <reader@example.invalid>', 'Subject: Synthetic report',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="boundary"', '',
    '--boundary', 'Content-Type: text/plain; charset=utf-8', '', 'Fixture body',
    '--boundary', 'Content-Type: application/octet-stream; name="fixture.bin"',
    'Content-Disposition: attachment; filename="fixture.bin"', 'Content-Transfer-Encoding: base64', '', 'dGVzdA==', '--boundary--', '',
  ].join('\r\n'));
  await control.append(folder, original, []);
  await control.append(folder, Buffer.from('Subject: second\r\n\r\nbody\r\n'), []);

  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = { id: 1 }; next(); });
  router = createMailRouter({ taskDb: savedDb, savedSearchDb: savedDb, createClient: client,
    mailAccessForRequest: () => ({ all: false, roots: [folder] }) });
  app.use(router);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const query = `folder=${encodeURIComponent(folder)}`;
  const firstResponse = await fetch(`${base}/messages?${query}&pageSize=1`);
  assert.equal(firstResponse.status, 200); const first = await firstResponse.json();
  assert.equal(first.total, 2); assert.equal(first.messages.length, 1); assert.equal(first.hasMore, true);
  const second = await fetch(`${base}/messages?${query}&page=2&pageSize=1&beforeUid=${first.nextBeforeUid}&uidValidity=${first.uidValidity}&knownTotal=2`).then(res => res.json());
  assert.equal(second.messages.length, 1); assert.notEqual(first.messages[0].uid, second.messages[0].uid);
  const uid = second.messages[0].uid;
  const globalSearch = await fetch(`${base}/search`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: 'Synthetic', to: 'reader@example.invalid', body: 'Fixture', smallerMb: '1' }) }).then(res => res.json());
  assert.equal(globalSearch.groups.length, 1);
  assert.equal(globalSearch.groups[0].folder, folder);
  assert.equal(globalSearch.groups[0].messages[0].uid, uid);
  const detail = await fetch(`${base}/messages/${uid}?${query}&uidValidity=${first.uidValidity}`).then(res => res.json());
  assert.equal(detail.message.attachments.length, 1);
  const exported = await fetch(`${base}/messages/${uid}/export?${query}&uidValidity=${first.uidValidity}`);
  assert.equal(exported.status, 200); assert.deepEqual(Buffer.from(await exported.arrayBuffer()), original);
  const badValidity = (BigInt(first.uidValidity) + 1n).toString();
  assert.equal((await fetch(`${base}/messages/${uid}/export?${query}&uidValidity=${badValidity}`)).status, 409);
  const change = await fetch(`${base}/messages/flags`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flag: 'flagged', value: true, messages: [{ folder, uid, uidValidity: first.uidValidity }] }) });
  assert.equal((await change.json()).results[0].ok, true);
  await control.mailboxOpen(folder);
  assert.ok((await control.fetchOne(uid, { flags: true }, { uid: true })).flags.has('\\Flagged'));
  const savedResponse = await fetch(`${base}/saved-searches`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Synthetic starred', scope: 'folder', folder, filters: { flagged: 'starred' } }) });
  assert.equal(savedResponse.status, 201); const saved = await savedResponse.json();
  const flaggedSearch = await fetch(`${base}/messages/search`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ folder: saved.folder, ...saved.filters }) }).then(res => res.json());
  assert.deepEqual(flaggedSearch.messages.map(message => message.uid), [uid]);
  const unflaggedSearch = await fetch(`${base}/search`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flagged: 'unstarred' }) }).then(res => res.json());
  assert.equal(unflaggedSearch.groups[0].messages.length, 1); assert.notEqual(unflaggedSearch.groups[0].messages[0].uid, uid);
  const jobResponse = await fetch(`${base}/seen-jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [folder] }) });
  assert.equal(jobResponse.status, 202); const job = await jobResponse.json();
  let progress;
  for (let i = 0; i < 100; i++) { progress = await fetch(`${base}/seen-jobs/${job.id}`).then(res => res.json()); if (progress.finishedAt) break; await delay(50); }
  assert.equal(progress.status, 'completed'); assert.equal(progress.updated, 2);
  await control.mailboxOpen(folder);
  assert.equal((await control.search({ seen: false }, { uid: true })).length, 0);

  const post = (endpoint, body) => fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let lateUid;
  for (const [action, flag, expected] of [['unstar', '\\Flagged', false], ['star', '\\Flagged', true],
    ['unseen', '\\Seen', false], ['seen', '\\Seen', true]]) {
    const created = await post('/rules', { name: `Synthetic ${action}`, scope: 'all', filters: { subject: 'Synthetic report' }, action });
    assert.equal(created.status, 201);
    const rule = await created.json();
    const preview = await post(`/rules/${rule.id}/previews`, {});
    assert.equal(preview.status, 202);
    const ready = await taskResult(base, (await preview.json()).id);
    assert.equal(ready.status, 'completed');
    assert.equal(ready.matched, 1);
    if (action === 'unstar') {
      await control.append(folder, Buffer.from('Subject: Synthetic report\r\n\r\nLate message\r\n'), ['\\Flagged']);
      lateUid = (await control.fetchOne('*', { uid: true })).uid;
      assert.notEqual(lateUid, uid);
    }
    const actionUrl = `/rules/${rule.id}/previews/${ready.id}/apply`;
    const applied = await post(actionUrl, {});
    assert.equal(applied.status, 202);
    const task = await taskResult(base, (await applied.json()).id);
    assert.equal(task.updated, 1);
    assert.equal((await (await post(actionUrl, {})).json()).id, task.id);
    await control.mailboxOpen(folder);
    assert.equal((await control.fetchOne(uid, { flags: true }, { uid: true })).flags.has(flag), expected);
    if (action === 'unstar') {
      assert.ok((await control.fetchOne(lateUid, { flags: true }, { uid: true })).flags.has(flag));
      await control.messageDelete(lateUid, { uid: true });
    }
  }

  const interrupted = client();
  await interrupted.connect(); await interrupted.mailboxOpen(folder); interrupted.close();
  const reconnected = client();
  await reconnected.connect(); await reconnected.mailboxOpen(folder); await reconnected.logout();

  await control.mailboxClose(); await control.mailboxDelete(folder); created = false;
  // Dovecot may derive the new UIDVALIDITY from seconds since epoch.
  await delay(1200);
  const newFolder = await control.mailboxCreate(folder);
  if (!newFolder?.created) throw new Error('Refusing to use a pre-existing test folder');
  created = true;
  const recreated = await control.mailboxOpen(folder);
  assert.notEqual(String(recreated.uidValidity), first.uidValidity);
  assert.equal((await fetch(`${base}/messages?${query}&uidValidity=${first.uidValidity}`)).status, 409);
});

test('a real Dovecot flag command is reconciled after the client process is killed', { timeout: 60000 }, async t => {
  const control = testClient();
  const folder = `CodexCrash${crypto.randomBytes(8).toString('hex')}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-dovecot-process-'));
  const children = new Set();
  let created = false;
  t.after(async () => {
    for (const child of children) { const done = once(child, 'close'); child.kill('SIGKILL'); await done; }
    try { if (created) await control.mailboxDelete(folder); }
    finally { if (control.usable) await control.logout(); else control.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  await control.connect();
  assert.equal((await control.mailboxCreate(folder)).created, true);
  created = true;
  await control.append(folder, Buffer.from('Subject: Original fixture\r\n\r\nOriginal\r\n'), []);
  async function start(mode) {
    const child = fork(path.join(__dirname, 'fixtures/dovecot-task-worker.cjs'), [path.join(root, 'state.db'), folder, mode]);
    children.add(child);
    const onMessage = once(child, 'message', { signal: AbortSignal.timeout(5000) });
    child.once('close', () => children.delete(child));
    const [{ port }] = await onMessage;
    return { child, base: `http://127.0.0.1:${port}` };
  }
  const before = await start('pause-after-store');
  const wrote = once(before.child, 'message', { signal: AbortSignal.timeout(8000) });
  const request = await fetch(`${before.base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'seen_all', folders: [folder] }) });
  assert.equal(request.status, 202);
  const { id } = await request.json();
  assert.equal((await wrote)[0].wrote, true);
  const closed = once(before.child, 'close');
  before.child.kill('SIGKILL'); await closed;
  await control.append(folder, Buffer.from('Subject: Later fixture\r\n\r\nLater\r\n'), []);

  const after = await start('continue');
  let subsequentWrites = 0;
  after.child.on('message', msg => { if (Object.hasOwn(msg, 'wrote')) subsequentWrites++; });
  const interrupted = await taskResult(after.base, id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.uncertain, 1);
  assert.equal(interrupted.updated, 0);
  const resume = await fetch(`${after.base}/tasks/${id}/resume`, { method: 'POST' });
  assert.equal(resume.status, 202);
  assert.equal((await resume.json()).phase, 'queued');
  const finished = await taskResult(after.base, id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.updated, 1);
  assert.equal(finished.uncertain, 0);
  assert.equal(subsequentWrites, 0);
  await control.mailboxOpen(folder);
  assert.deepEqual((await control.fetchAll('1:*', { flags: true })).map(message => message.flags.has('\\Seen')), [true, false]);
  await control.mailboxClose();
  const stopped = once(after.child, 'close'); after.child.send('stop'); await stopped;
});
