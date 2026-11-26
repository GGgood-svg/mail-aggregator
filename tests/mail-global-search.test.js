const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createMailRouter } = require('../server/mail-reader');
const { searchCriteria } = require('../server/mail-tools');

function message(uid, text = 'quarterly report') {
  return { uid, flags: new Set(), size: 1572864, body: text, recipient: 'reader@example.invalid',
    envelope: { subject: text, to: [{ address: 'reader@example.invalid' }] } };
}
async function fixture(t, boxes, options = {}) {
  const calls = []; let active = 0, peak = 0, fetches = [];
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = { id: Number(req.get('x-test-user') || 1) }; next(); });
  app.use(createMailRouter({
    searchFolderTimeoutMs: options.timeoutMs || 1000,
    mailAccessForRequest: options.access || (req => ({ all: false, roots: [`U${req.user.id}-A1`] })),
    createClient: () => {
      let selected, closed = false, connected = false;
      const release = () => { if (!closed) { closed = true; if (connected) active--; } };
      return {
        async connect() { connected = true; active++; peak = Math.max(peak, active); }, async logout() { release(); }, close() { release(); },
        async list() { return Object.entries(boxes).map(([path, box]) => ({ path, flags: new Set(box.noSelect ? ['\\Noselect'] : []) })); },
        async mailboxOpen(folder, opts) { assert.equal(opts.readOnly, true); selected = folder; const box = boxes[folder];
          return { uidValidity: box.validity, uidNext: box.next, exists: box.messages.length }; },
        async search(query) {
          const folder = selected; calls.push({ folder, query });
          if (options.onSearch) await options.onSearch(folder);
          if (boxes[folder].fail) return false;
          const [low, high] = query.uid.split(':');
          return boxes[folder].messages.filter(m => m.uid >= Number(low) && (high === '*' || m.uid <= Number(high))
            && (!query.subject || m.envelope.subject.includes(query.subject))
            && (query.seen === undefined || m.flags.has('\\Seen') === query.seen)
            && (!query.body || m.body.includes(query.body)) && (!query.to || m.recipient.includes(query.to))
            && (!query.larger || m.size > query.larger) && (!query.smaller || m.size < query.smaller))
            .map(m => m.uid);
        },
        async fetchAll(uids) { fetches.push(selected); return boxes[selected].messages.filter(m => uids.includes(m.uid)); },
      };
    },
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, calls, fetches, get peak() { return peak; }, get active() { return active; } };
}
function post(base, route, body, headers = {}) {
  return fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('recipient, body and bounded size search combine with existing criteria', () => {
  assert.deepEqual(searchCriteria({ to: ' reader@example.invalid ', body: '季度', largerMb: '1', smallerMb: '3', seen: 'unread' }),
    { to: 'reader@example.invalid', body: '季度', seen: false, larger: 1048576, smaller: 3145728 });
  for (const query of [{ to: ['one', 'two'] }, { body: 'bad\ntext' }, { largerMb: '0' }, { smallerMb: '4096' },
    { largerMb: '1.5' }, { largerMb: '3', smallerMb: '3' }, { largerMb: '4', smallerMb: '3' }]) {
    assert.throws(() => searchCriteria(query), { statusCode: 400 });
  }
});

test('expanded filters work inside one folder and preserve read state', async t => {
  const matching = message(7), seen = message(8); seen.flags.add('\\Seen');
  const boxes = { 'U1-A1.INBOX': { validity: '77', next: 9, messages: [matching, seen] } };
  const f = await fixture(t, boxes);
  const query = { to: 'reader', body: 'quarterly', largerMb: '1', smallerMb: '2', seen: 'unread' };
  const local = await post(f.base, '/messages/search', { folder: 'U1-A1.INBOX', ...query }).then(res => res.json());
  assert.deepEqual(local.messages.map(item => item.uid), [7]); assert.equal(local.total, 1);
  const global = await post(f.base, '/search', query).then(res => res.json());
  assert.deepEqual(global.groups[0].messages.map(item => item.uid), [7]);
  assert.ok(!matching.flags.has('\\Seen')); assert.ok(seen.flags.has('\\Seen'));
});

test('size boundaries are strict and Chinese body terms reach the search client', async t => {
  const small = message(1, '季度报告'), inside = message(2, '季度报告'), large = message(3, '季度报告');
  small.size = 1048576; inside.size = 1048577; large.size = 2097152;
  const boxes = { 'U1-A1.INBOX': { validity: '77', next: 4, messages: [small, inside, large] } };
  const f = await fixture(t, boxes);
  const result = await post(f.base, '/search', { body: '季度', largerMb: '1', smallerMb: '2' }).then(res => res.json());
  assert.deepEqual(result.groups[0].messages.map(item => item.uid), [2]);
  assert.equal(f.calls[0].query.body, '季度');
});

test('cross-folder search pages authorized folders, limits previews and retains message identity', async t => {
  const boxes = {};
  for (let i = 0; i < 10; i++) boxes[`U1-A1.F${String(i).padStart(2, '0')}`] = { validity: String(70 + i), next: 9, messages: i % 2 ? [] : [message(7)] };
  boxes['U1-A1.F00'].messages = Array.from({ length: 7 }, (_, i) => message(i + 1));
  boxes['U1-A1.F07'].fail = true;
  boxes['U1-A1.F07'].messages.push(message(7));
  boxes['U1-A1.NoSelect'] = { validity: '80', next: 8, messages: [message(7)], noSelect: true };
  boxes['U2-A1.Secret'] = { validity: '90', next: 8, messages: [message(7, 'secret')] };
  const f = await fixture(t, boxes, { onSearch: () => delay(5) });
  const filters = { subject: 'report', to: 'reader', body: 'quarterly', largerMb: '1', smallerMb: '2' };
  let response = await post(f.base, '/search', filters); assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.totalFolders, 10); assert.equal(first.scannedFolders, 8); assert.equal(first.nextAfter, 'U1-A1.F07');
  assert.equal(first.groups.find(g => g.folder === 'U1-A1.F00').messages.length, 5);
  assert.equal(first.groups.find(g => g.folder === 'U1-A1.F00').hasMore, true);
  assert.equal(first.groups.find(g => g.folder === 'U1-A1.F07').ok, false);
  assert.equal(first.groups.find(g => g.folder === 'U1-A1.F02').messages[0].uid, 7);
  assert.notEqual(first.groups.find(g => g.folder === 'U1-A1.F00').uidValidity, first.groups.find(g => g.folder === 'U1-A1.F02').uidValidity);
  assert.ok(!f.calls.some(call => call.folder.startsWith('U2-') || call.folder.endsWith('NoSelect')));
  assert.ok(f.calls.every(call => call.query.to === 'reader' && call.query.body === 'quarterly' && call.query.larger === 1048576));
  assert.ok(f.peak <= 2);
  response = await post(f.base, '/search', { ...filters, after: first.nextAfter });
  const second = await response.json();
  assert.equal(second.scannedFolders, 10); assert.equal(second.nextAfter, null);
  assert.deepEqual(second.groups.map(g => g.folder), ['U1-A1.F08']);
  const other = await post(f.base, '/search', { subject: 'secret' }, { 'x-test-user': '2' }).then(r => r.json());
  assert.deepEqual(other.groups.map(g => g.folder), ['U2-A1.Secret']);
  assert.ok(Object.values(boxes).flatMap(box => box.messages).every(m => !m.flags.has('\\Seen')));
  const before = f.calls.length;
  assert.equal((await post(f.base, '/search', {})).status, 400);
  assert.equal((await post(f.base, '/search', { body: 'x', largerMb: '0' })).status, 400);
  assert.equal((await post(f.base, '/search', [])).status, 400);
  assert.equal((await post(f.base, '/messages/search', [])).status, 400);
  assert.equal((await post(f.base, '/search', { subject: 'report', unknown: 'ignored' })).status, 400);
  assert.equal((await post(f.base, '/messages/search', { folder: ['U1-A1.F00'] })).status, 400);
  assert.equal((await post(f.base, '/messages/search', { folder: 'U1-A1.F00', uidValidity: 77 })).status, 400);
  assert.equal(f.calls.length, before);
});

test('one timed-out folder is reported while other folders still return results', async t => {
  const boxes = { 'U1-A1.Slow': { validity: '1', next: 8, messages: [message(7)] },
    'U1-A1.Fast': { validity: '2', next: 8, messages: [message(7)] } };
  const f = await fixture(t, boxes, { timeoutMs: 15, onSearch: folder => folder.endsWith('Slow') ? delay(70) : delay(1) });
  const data = await post(f.base, '/search', { subject: 'report' }).then(r => r.json());
  assert.equal(data.groups.find(g => g.folder.endsWith('Slow')).ok, false);
  assert.equal(data.groups.find(g => g.folder.endsWith('Fast')).messages[0].uid, 7);
  await delay(80);
  assert.ok(!f.fetches.includes('U1-A1.Slow'));
});

test('access revoked during search does not expose a folder or its messages', async t => {
  let allowed = true;
  const boxes = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`U1-A1.F${i}`, { validity: '77', next: 8, messages: [message(7)] }]));
  const f = await fixture(t, boxes, { access: () => ({ all: false, roots: allowed ? ['U1-A1'] : [] }), onSearch: () => { allowed = false; } });
  const response = await post(f.base, '/search', { subject: 'report' });
  assert.equal(response.status, 409);
  const data = await response.json(); assert.doesNotMatch(JSON.stringify(data), /U1-A1/);
});

test('folder search rechecks access before sending results', async t => {
  let allowed = true;
  const boxes = { 'U1-A1.INBOX': { validity: '77', next: 8, messages: [message(7)] } };
  const f = await fixture(t, boxes, { access: () => ({ all: false, roots: allowed ? ['U1-A1'] : [] }), onSearch: () => { allowed = false; } });
  const response = await post(f.base, '/messages/search', { folder: 'U1-A1.INBOX', subject: 'report' });
  assert.equal(response.status, 404); assert.doesNotMatch(await response.text(), /quarterly report/);
});

test('cancelling a cross-folder search closes clients and prevents late fetches', async t => {
  let unblock, started;
  const gate = new Promise(resolve => { unblock = resolve; });
  const searchStarted = new Promise(resolve => { started = resolve; });
  const boxes = { 'U1-A1.One': { validity: '77', next: 8, messages: [message(7)] },
    'U1-A1.Two': { validity: '78', next: 8, messages: [message(7)] } };
  const f = await fixture(t, boxes, { onSearch: () => { started(); return gate; } });
  const controller = new AbortController();
  const pending = fetch(`${f.base}/search`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'quarterly' }), signal: controller.signal });
  try {
    await searchStarted;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    for (let i = 0; i < 50 && f.active; i++) await delay(5);
    assert.equal(f.active, 0);
  } finally { unblock(); }
  await delay(10);
  assert.deepEqual(f.fetches, []);
});

test('cancelling ordinary folder search prevents a late message fetch', async t => {
  let unblock, started;
  const gate = new Promise(resolve => { unblock = resolve; });
  const searchStarted = new Promise(resolve => { started = resolve; });
  const boxes = { 'U1-A1.INBOX': { validity: '77', next: 8, messages: [message(7)] } };
  const f = await fixture(t, boxes, { onSearch: () => { started(); return gate; } });
  const controller = new AbortController();
  const pending = fetch(`${f.base}/messages/search`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ folder: 'U1-A1.INBOX', subject: 'report' }), signal: controller.signal });
  try {
    await searchStarted; controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    for (let i = 0; i < 50 && f.active; i++) await delay(5);
    assert.equal(f.active, 0);
  } finally { unblock(); }
  await delay(10);
  assert.deepEqual(f.fetches, []);
});
