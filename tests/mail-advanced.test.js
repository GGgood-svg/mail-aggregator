const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createMailRouter } = require('../server/mail-reader');

function message(uid, seen = false, flagged = false) {
  const flags = new Set();
  if (seen) flags.add('\\Seen');
  if (flagged) flags.add('\\Flagged');
  return { uid, flags, envelope: { subject: `Message ${uid}` }, size: 10 };
}

async function fixture(t, folders, options = {}) {
  const calls = [], writes = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: Number(req.get('x-test-user') || 1) }; next(); });
  app.use(createMailRouter({
    mailAccessForRequest: options.access || (() => ({ all: false, roots: ['U1-A1', 'U1-A2'] })),
    createClient: () => {
      let open;
      return {
        capabilities: options.esearch ? new Map([['ESEARCH', true]]) : new Map(),
        async connect() {}, async logout() {}, close() {},
        async list() {
          return Object.entries(folders).map(([path, box]) => ({ path, flags: new Set(),
            status: { messages: box.messages.length, unseen: box.messages.filter(m => !m.flags.has('\\Seen')).length } }));
        },
        async mailboxOpen(path) {
          open = path; const box = folders[path];
          if (!box) throw new Error('missing folder');
          return { uidValidity: box.validity, uidNext: box.next, exists: box.messages.length };
        },
        async search(query, searchOptions) {
          calls.push({ folder: open, query, options: searchOptions });
          if (options.failSearch) return false;
          let result = folders[open].messages;
          if (query.seen !== undefined) result = result.filter(m => m.flags.has('\\Seen') === query.seen);
          if (query.flagged !== undefined) result = result.filter(m => m.flags.has('\\Flagged') === query.flagged);
          if (query.subject) result = result.filter(m => m.envelope.subject.includes(query.subject));
          if (query.uid) {
            const [start, end] = query.uid.split(':');
            result = result.filter(m => m.uid >= Number(start) && (end === '*' || m.uid <= Number(end)));
          }
          if (searchOptions.returnOptions?.includes('MAX')) return result.length ? { max: result.at(-1).uid } : {};
          if (searchOptions.returnOptions?.includes('COUNT')) return { count: result.length };
          return result.map(m => m.uid);
        },
        async fetchAll(uids) { return folders[open].messages.filter(m => uids.includes(m.uid)); },
        async messageFlagsAdd(uids, flags) {
          writes.push({ folder: open, uids: [...uids], flags, add: true });
          folders[open].messages.filter(m => uids.includes(m.uid)).forEach(m => flags.forEach(f => m.flags.add(f)));
          if (options.afterWrite) await options.afterWrite(open);
          return true;
        },
        async messageFlagsRemove(uids, flags) {
          writes.push({ folder: open, uids: [...uids], flags, add: false });
          folders[open].messages.filter(m => uids.includes(m.uid)).forEach(m => flags.forEach(f => m.flags.delete(f)));
          return true;
        },
      };
    },
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, calls, writes };
}

test('large mailbox pagination bounds UID responses and keeps cursor stable', async t => {
  const box = { validity: '77', next: 100001, messages: Array.from({ length: 100000 }, (_, i) => message(i + 1)) };
  const f = await fixture(t, { 'U1-A1.INBOX': box });
  const base = `${f.base}/messages?folder=U1-A1.INBOX&pageSize=30`;
  let response = await fetch(base); assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.total, 100000); assert.equal(first.messages.length, 30);
  assert.equal(first.messages[0].uid, 100000); assert.equal(first.nextBeforeUid, 99971);
  const [low, high] = f.calls[0].query.uid.split(':').map(Number);
  assert.ok(high - low + 1 <= 256, 'first page must not request all UIDs');
  box.messages.push(message(100001)); box.next++;
  response = await fetch(`${base}&page=2&beforeUid=${first.nextBeforeUid}&uidValidity=77&knownTotal=100000`);
  const second = await response.json();
  assert.equal(second.messages[0].uid, 99970); assert.equal(second.messages.at(-1).uid, 99941);
  assert.ok(f.calls.every(call => call.query.uid !== '1:*'));
});

test('filtered count uses ESEARCH when available and falls back safely', async t => {
  const messages = Array.from({ length: 800 }, (_, i) => message(i + 1, i % 2 === 0));
  const boxes = { 'U1-A1.INBOX': { validity: '77', next: 801, messages } };
  const f = await fixture(t, boxes, { esearch: true });
  const data = await fetch(`${f.base}/messages?folder=U1-A1.INBOX&seen=unread&pageSize=5`).then(r => r.json());
  assert.equal(data.total, 400); assert.deepEqual(data.messages.map(m => m.uid), [800, 798, 796, 794, 792]);
  assert.deepEqual(f.calls[0].options.returnOptions, ['COUNT']);
  assert.ok(f.calls[1].query.uid !== '1:*');
  const fallback = await fixture(t, boxes);
  const result = await fetch(`${fallback.base}/messages?folder=U1-A1.INBOX&seen=unread&pageSize=5`).then(r => r.json());
  assert.equal(result.total, 400); assert.equal(result.messages[0].uid, 800);
});

test('ESEARCH skips sparse UID gaps without asking for a large array', async t => {
  const f = await fixture(t, { 'U1-A1.INBOX': { validity: '77', next: 10000001,
    messages: [message(3), message(100), message(9999999)] } }, { esearch: true });
  const data = await fetch(`${f.base}/messages?folder=U1-A1.INBOX&pageSize=2`).then(r => r.json());
  assert.deepEqual(data.messages.map(m => m.uid), [9999999, 100]);
  assert.equal(data.hasMore, true); assert.ok(f.calls.length < 15);
});

test('a sparse IMAP server without ESEARCH returns an explicit budget error', async t => {
  const f = await fixture(t, { 'U1-A1.INBOX': { validity: '77', next: 10000001, messages: [message(3), message(9999999)] } });
  const response = await fetch(`${f.base}/messages?folder=U1-A1.INBOX&pageSize=2`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'SEARCH_BUDGET_EXCEEDED');
  assert.equal(f.calls.length, 64);
  assert.ok(f.calls.every(({ query }) => { const [low,high] = query.uid.split(':').map(Number); return high - low < 4096; }));
  f.calls.length = 0;
  const unread = await fetch(`${f.base}/unread`);
  assert.equal(unread.status, 503);
  const page = await unread.json();
  assert.equal(page.code, 'SEARCH_BUDGET_EXCEEDED');
  assert.equal(page.groups[0].ok, false);
  assert.equal(f.calls.length, 64);
});

test('starred and unstarred filters work in folder and cross-folder POST searches', async t => {
  const boxes = { 'U1-A1.INBOX': { validity: '77', next: 9, messages: [message(7, false, true), message(8)] },
    'U1-A2.INBOX': { validity: '88', next: 10, messages: [message(9, true, true)] } };
  const f = await fixture(t, boxes);
  const post = (url, body) => fetch(f.base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const starredResponse = await post('/search', { flagged: 'starred' });
  const starred = await starredResponse.json();
  assert.equal(starredResponse.status, 200, JSON.stringify(starred));
  assert.deepEqual(starred.groups.flatMap(group => group.messages.map(item => item.uid)).sort(), [7, 9]);
  const unstarred = await (await post('/messages/search', { folder: 'U1-A1.INBOX', flagged: 'unstarred' })).json();
  assert.deepEqual(unstarred.messages.map(item => item.uid), [8]);
  assert.equal((await post('/search', { flagged: 'bad' })).status, 400);
});

test('batch flags isolate folders, verify UIDVALIDITY and report missing messages', async t => {
  const folders = {
    'U1-A1.INBOX': { validity: '77', next: 8, messages: [message(7)] },
    'U1-A2.INBOX': { validity: '88', next: 8, messages: [message(7)] },
    'U2-A1.INBOX': { validity: '99', next: 8, messages: [message(7)] },
  };
  const f = await fixture(t, folders);
  const update = messages => fetch(`${f.base}/messages/flags`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, flag: 'flagged', value: true }) });
  const a = { folder: 'U1-A1.INBOX', uidValidity: '77', uid: 7 };
  const b = { folder: 'U1-A2.INBOX', uidValidity: '88', uid: 7 };
  let response = await update([a, { folder: 'U2-A1.INBOX', uidValidity: '99', uid: 7 }]);
  assert.equal(response.status, 404); assert.equal(f.writes.length, 0);
  response = await update([a, b, { ...a, uid: 9 }]);
  const result = await response.json();
  assert.deepEqual(result.results.map(r => [r.folder, r.updated, r.missing]), [['U1-A1.INBOX', 1, 1], ['U1-A2.INBOX', 1, 0]]);
  assert.ok(folders[a.folder].messages[0].flags.has('\\Flagged'));
  assert.ok(folders[b.folder].messages[0].flags.has('\\Flagged'));
  assert.ok(!folders['U2-A1.INBOX'].messages[0].flags.has('\\Flagged'));
  const before = f.writes.length;
  response = await update([{ ...a, uidValidity: '76' }]);
  assert.equal((await response.json()).results[0].ok, false); assert.equal(f.writes.length, before);
  assert.equal((await update([{ ...a, uid: 0 }])).status, 400);
  assert.equal((await update([a, { ...a, uidValidity: '78' }])).status, 409);
});

test('unified unread is restricted to owned folders and pages without UID collisions', async t => {
  const folders = { 'U2-A1.INBOX': { validity: '99', next: 8, messages: [message(7)] } };
  for (let i = 0; i < 12; i++) folders[`U1-A1.F${String(i).padStart(2, '0')}`] = { validity: String(100 + i), next: 9, messages: [message(7), message(8, true)] };
  const f = await fixture(t, folders);
  const first = await fetch(`${f.base}/unread`).then(r => r.json());
  assert.equal(first.totalUnread, 12); assert.equal(first.groups.length, 10);
  assert.ok(first.groups.every(g => g.folder.startsWith('U1-A1.') && g.messages[0].uid === 7));
  assert.notEqual(first.groups[0].uidValidity, first.groups[1].uidValidity);
  const second = await fetch(`${f.base}/unread?after=${encodeURIComponent(first.nextAfter)}`).then(r => r.json());
  assert.equal(second.groups.length, 2); assert.equal(second.nextAfter, null);
  assert.equal(f.writes.length, 0);
});

test('a rejected IMAP search is surfaced rather than presented as an empty mailbox', async t => {
  const folders = { 'U1-A1.INBOX': { validity: '77', next: 8, messages: [message(7)] } };
  const f = await fixture(t, folders, { failSearch: true });
  assert.equal((await fetch(`${f.base}/messages?folder=U1-A1.INBOX`)).status, 502);
  const data = await fetch(`${f.base}/unread`).then(r => r.json());
  assert.equal(data.groups[0].ok, false);
});

test('background seen job marks all batches and is only visible to its owner', async t => {
  const folders = { 'U1-A1.INBOX': { validity: '77', next: 551, messages: Array.from({ length: 550 }, (_, i) => message(i + 1)) } };
  const f = await fixture(t, folders);
  const start = await fetch(`${f.base}/seen-jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: ['U1-A1.INBOX'] }) });
  assert.equal(start.status, 202); const created = await start.json();
  assert.equal((await fetch(`${f.base}/seen-jobs/${created.id}`, { headers: { 'x-test-user': '2' } })).status, 404);
  let job;
  for (let i = 0; i < 100; i++) {
    job = await fetch(`${f.base}/seen-jobs/${created.id}`).then(r => r.json());
    if (job.finishedAt) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(job.status, 'completed'); assert.equal(job.updated, 550); assert.equal(job.processedFolders, 1);
  assert.equal(folders['U1-A1.INBOX'].messages.filter(m => m.flags.has('\\Seen')).length, 550);
  assert.equal(f.writes.length, 2);
  const forbidden = await fetch(`${f.base}/seen-jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: ['U2-A1.INBOX'] }) });
  assert.equal(forbidden.status, 404);
});

test('background seen job stops further batches after folder access is revoked', async t => {
  let allowed = true;
  const folders = { 'U1-A1.INBOX': { validity: '77', next: 551, messages: Array.from({ length: 550 }, (_, i) => message(i + 1)) } };
  const f = await fixture(t, folders, { access: () => ({ all: false, roots: allowed ? ['U1-A1'] : [] }), afterWrite: () => { allowed = false; } });
  const response = await fetch(`${f.base}/seen-jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: ['U1-A1.INBOX'] }) });
  const created = await response.json(); let job;
  for (let i = 0; i < 100; i++) { job = await fetch(`${f.base}/seen-jobs/${created.id}`).then(r => r.json()); if (job.finishedAt) break; await new Promise(resolve => setTimeout(resolve, 5)); }
  // The already submitted batch may finish, but revoked access forbids verification reads.
  assert.equal(job.status, 'partial'); assert.equal(job.updated, 0); assert.equal(f.writes.length, 1);
  assert.equal(folders['U1-A1.INBOX'].messages.filter(m => !m.flags.has('\\Seen')).length, 50);
});
