const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createMailRouter } = require('../server/mail-reader');

test('bulk seen covers every page, validates scope before writes and reports partial failures', async (t) => {
  let opened = '';
  const writes = [];
  const client = {
    async connect() {}, async logout() {},
    async list() { return ['A.INBOX', 'A.Sent', 'B.INBOX'].map(path => ({ path, flags: new Set() })); },
    async mailboxOpen(path) { opened = path; if (path === 'A.Sent') throw new Error('offline'); },
    async search(query, options) { assert.equal(query.seen, false); assert.equal(options.uid, true); return Array.from({length: 550}, (_, i) => i + 1); },
    async messageFlagsAdd(uids, flags, options) { writes.push({ folder: opened, uids }); assert.deepEqual(flags, ['\\Seen']); assert.equal(options.uid, true); return true; },
  };
  const app = express(); app.use(express.json()); app.use(createMailRouter({
    createClient: () => client,
    mailAccessForRequest: () => ({ all: true, roots: [] }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const put = folders => fetch(`http://127.0.0.1:${server.address().port}/seen-all`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folders }),
  });
  assert.equal((await put(['A.INBOX', 'missing'])).status, 400);
  assert.equal(writes.length, 0);
  assert.equal((await put([])).status, 400);
  const data = await (await put(['A.INBOX', 'A.INBOX', 'A.Sent'])).json();
  assert.deepEqual(data.results, [{folder: 'A.INBOX', ok: true, updated: 550}, {folder: 'A.Sent', ok: false}]);
  assert.equal(writes.flatMap(x => x.uids).length, 550);
  assert.ok(writes.every(x => x.folder === 'A.INBOX'));
});

test('seen writes persist, preserve other flags, reject invalid input and report missing mail', async (t) => {
  const flags = new Set(['\\Flagged']);
  let fail = false;
  const client = {
    async connect() {}, async logout() {},
    async mailboxOpen(folder, options) { assert.equal(folder, 'Work.INBOX'); assert.equal(options.readOnly, false); },
    async fetchOne(uid) { return uid === 7 ? { flags } : false; },
    async messageFlagsAdd(uid, values, options) {
      assert.equal(uid, 7); assert.equal(options.uid, true);
      if (fail) throw new Error('write failed');
      values.forEach(value => flags.add(value));
    },
    async messageFlagsRemove(uid, values) { values.forEach(value => flags.delete(value)); },
  };
  const app = express();
  app.use(express.json());
  app.use(createMailRouter({
    createClient: () => client,
    mailAccessForRequest: () => ({ all: true, roots: [] }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const put = (uid, seen) => fetch(`http://127.0.0.1:${server.address().port}/messages/${uid}/seen?folder=Work.INBOX`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seen }),
  });
  assert.equal((await (await put(7, true)).json()).seen, true);
  assert.ok(flags.has('\\Seen'));
  assert.equal((await (await put(7, false)).json()).seen, false);
  assert.ok(!flags.has('\\Seen'));
  assert.ok(flags.has('\\Flagged'));
  assert.equal((await put(7, 'true')).status, 400);
  assert.equal((await put('invalid', true)).status, 400);
  assert.equal((await put(8, true)).status, 404);
  fail = true;
  assert.equal((await put(7, true)).status, 502);
  assert.ok(!flags.has('\\Seen'));
});
