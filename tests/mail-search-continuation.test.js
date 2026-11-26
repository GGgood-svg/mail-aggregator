'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { createMailRouter } = require('../server/mail-reader');
const { scanNewestUids, MAX_UID } = require('../server/mail-search-uids');
const { TTL_MS } = require('../server/mail-search-cursor');
const { searchCriteria } = require('../server/mail-tools');
const { normalizeSavedSearch } = require('../server/saved-searches');
const { normalizeRule } = require('../server/mail-rules');

const row = (uid, subject = 'all') => ({ uid, envelope: { subject }, flags: new Set() });
function clientFor(box, commands = [], extended = false) {
  return {
    capabilities: new Set(extended ? ['ESEARCH'] : []),
    async search(criteria, options) {
      assert.ok(options.uid);
      const [low, high] = criteria.uid.split(':').map(Number);
      const matches = box.rows.filter(item => item.uid >= low && item.uid <= high && (!criteria.subject || item.envelope.subject.includes(criteria.subject))).map(item => item.uid);
      commands.push({ criteria, options });
      if (options.returnOptions?.includes('MAX')) return { max: matches.length ? Math.max(...matches) : undefined };
      assert.ok(high - low < 4096);
      return matches;
    },
  };
}

test('bounded UID scan returns a safe resume point after page limit or empty scan budget', async () => {
  const dense = { rows: [row(9), row(5), row(3), row(2)] };
  const first = await scanNewestUids(clientFor(dense), {}, { uidNext: 10 }, null, 2);
  assert.deepEqual(first, { uids: [9, 5], nextBeforeUid: 5, exhausted: false, reason: 'page_limit' });
  const rest = await scanNewestUids(clientFor(dense), {}, { uidNext: 10 }, first.nextBeforeUid, 2);
  assert.deepEqual(rest, { uids: [3, 2], nextBeforeUid: null, exhausted: true, reason: null });
  const sparse = { rows: [row(MAX_UID - 64 * 256)] };
  const commands = [];
  const empty = await scanNewestUids(clientFor(sparse, commands), {}, { uidNext: MAX_UID + 1 }, MAX_UID + 1, 6);
  assert.deepEqual(empty, { uids: [], nextBeforeUid: MAX_UID + 1 - 64 * 256, exhausted: false, reason: 'scan_limit' });
  assert.equal(commands.length, 64);
  const resumed = await scanNewestUids(clientFor(sparse), {}, { uidNext: MAX_UID + 1 }, empty.nextBeforeUid, 1);
  assert.deepEqual(resumed.uids, [sparse.rows[0].uid]);
});

test('65 sparse ESEARCH hits are complete across two bounded batches', async () => {
  const source = { rows: Array.from({ length: 65 }, (_, index) => row((index + 1) * 5000)) };
  const commands = [];
  const client = clientFor(source, commands, true);
  const first = await scanNewestUids(client, {}, { uidNext: 325001 }, null, 200);
  assert.equal(first.reason, 'scan_limit'); assert.equal(first.uids.length, 64); assert.equal(commands.length, 128);
  const second = await scanNewestUids(client, {}, { uidNext: 325001 }, first.nextBeforeUid, 200);
  assert.equal(second.exhausted, true); assert.equal(second.uids.length, 1);
  assert.deepEqual([...first.uids, ...second.uids], source.rows.map(item => item.uid).reverse());
});

async function apiFixture(t, boxes, options = {}) {
  let time = 1_000_000;
  let revoke = false;
  const opened = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: Number(req.get('x-test-owner') || 1) };
    req.sessionID = req.get('x-test-session') || 'session-a';
    next();
  });
  app.use('/api/mail', createMailRouter({
    searchCursors: { now: () => time },
    mailAccessForRequest: () => revoke ? { roots: ['U1-A09'], all: false } : { all: true },
    searchFolderTimeoutMs: options.timeout || 1000,
    createClient() {
      let box;
      return {
        usable: true, capabilities: new Set(), on() {}, async connect() {}, async logout() {}, close() {},
        async list() { return Object.keys(boxes).map(path => ({ path, flags: new Set() })); },
        async mailboxOpen(folder, config) {
          assert.equal(config.readOnly, true);
          opened.push(folder); box = boxes[folder];
          if (box.fail) throw new Error('Synthetic unavailable folder');
          return { uidValidity: box.validity, uidNext: box.next, exists: box.rows.length };
        },
        async search(query, opts) { return clientFor(box).search(query, opts); },
        async fetchAll(uids, fields) { options.onFetch?.(uids, fields); return box.rows.filter(item => uids.includes(item.uid)); },
      };
    },
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return {
    opened,
    revoke: () => { revoke = true; },
    advance: ms => { time += ms; },
    async post(endpoint, payload, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mail${endpoint}`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ continuation: true, ...payload }) });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('all eight folders may exhaust a budget while next folders and scoped retries remain usable', async t => {
  const boxes = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`U1-A0${i + 1}.INBOX`, i < 8
    ? { validity: 7, next: 1_000_001, rows: [row(1_000_000 - 64 * 256)] }
    : { validity: 8, next: 3, rows: [row(1), row(2, 'different')] }]));
  const f = await apiFixture(t, boxes);
  const filter = { subject: 'all' };
  const first = await f.post('/search', filter);
  assert.equal(first.status, 200);
  assert.ok(first.body.groups.every(group => group.state === 'limited' && group.reason === 'scan_limit' && !group.messages.length));
  assert.equal(first.body.groups.length, 8); assert.equal(first.body.scannedFolders, 8);
  const next = await f.post('/search', { ...filter, cursor: first.body.nextFoldersCursor });
  assert.equal(next.status, 200); assert.equal(next.body.nextFoldersCursor, null);
  assert.deepEqual(next.body.groups.map(group => [group.folder, group.messages.map(item => item.uid)]), [['U1-A09.INBOX', [1]]]);
  const resume = first.body.groups[0].resumeCursor;
  boxes['U1-A01.INBOX'].fail = true;
  let offset = f.opened.length;
  const failed = await f.post('/search', { ...filter, cursor: resume });
  assert.equal(failed.body.groups[0].state, 'failed'); assert.deepEqual(f.opened.slice(offset), ['U1-A01.INBOX']);
  boxes['U1-A01.INBOX'].fail = false; offset = f.opened.length;
  const retried = await f.post('/search', { ...filter, cursor: failed.body.groups[0].retryCursor });
  assert.deepEqual(retried.body.groups[0].messages.map(item => item.uid), [1_000_000 - 64 * 256]);
  assert.deepEqual(f.opened.slice(offset), ['U1-A01.INBOX']);
});

test('signed search cursors bind filter, mailbox, ceiling, session, permission and expiry', async t => {
  const box = { validity: 77, next: 11, rows: [row(10), row(9), row(8), row(7), row(3)] };
  const f = await apiFixture(t, { 'U1-A01.INBOX': box, 'U1-A02.INBOX': { ...box } });
  const query = { folder: 'U1-A01.INBOX', subject: ' all ', pageSize: 2 };
  const first = await f.post('/messages/search', query);
  assert.deepEqual(first.body.messages.map(item => item.uid), [10, 9]); assert.equal(first.body.total, null);
  const cursor = first.body.resumeCursor;
  box.rows.push(row(11)); box.next++;
  box.rows = box.rows.filter(item => item.uid !== 8);
  const replay = await f.post('/messages/search', { ...query, cursor: first.body.pageCursor });
  assert.deepEqual(replay.body.messages.map(item => item.uid), [10, 9]);
  const second = await f.post('/messages/search', { ...query, subject: 'all', page: 2, cursor });
  assert.deepEqual(second.body.messages.map(item => item.uid), [7, 3]);
  assert.equal(second.body.resumeCursor, null);
  for (const [body, headers] of [[{ ...query, subject: 'unrelated' }], [{ ...query, folder: 'U1-A02.INBOX' }],
    [query, { 'x-test-owner': '2' }], [query, { 'x-test-session': 'session-b' }],
    [{ ...query, cursor: `${cursor[0] === 'B' ? 'C' : 'B'}${cursor.slice(1)}` }]]) {
    const response = await f.post('/messages/search', { cursor, ...body }, headers);
    assert.equal(response.status, 409); assert.equal(response.body.code, 'SEARCH_CURSOR_INVALID');
  }
  box.validity = 88;
  assert.equal((await f.post('/messages/search', { ...query, cursor })).status, 409);
  box.validity = 77; f.advance(TTL_MS);
  assert.equal((await f.post('/messages/search', { ...query, cursor })).status, 409);
  const grouped = await f.post('/search', { subject: 'all' });
  const groupCursor = grouped.body.groups[0].resumeCursor;
  // Force a cursor for a group using an extra matching message when needed.
  const raw = groupCursor || (await f.post('/messages/search', query)).body.resumeCursor;
  f.revoke();
  const revoked = groupCursor ? await f.post('/search', { subject: 'all', cursor: raw })
    : await f.post('/messages/search', { ...query, cursor: raw });
  assert.ok([404, 409].includes(revoked.status)); assert.ok(!revoked.body.messages && !revoked.body.groups);
});


test('literal all is identical for ordinary, saved and rule searches', () => {
  const input = { name: 'literal all', scope: 'all', filters: { subject: ' all ', body: 'all', to: 'all', from: 'all', seen: 'all', flagged: 'all' } };
  const expected = { subject: 'all', body: 'all', to: 'all', from: 'all' };
  assert.deepEqual(searchCriteria(input.filters), expected);
  assert.deepEqual(searchCriteria(normalizeSavedSearch(input).filters), expected);
  assert.deepEqual(searchCriteria(normalizeRule({ ...input, action: 'star' }).filters), expected);
});


test('continuation and navigation copy covers all seven supported locales', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/js/mail-continuation-i18n.js'), 'utf8'), { window });
  const sources = ['尚未扫描完毕', '继续扫描此文件夹', '重试此文件夹', '继续到下一批文件夹', '邮件总数未知',
    '返回列表', '上一封', '下一封', '搜索位置已失效，请重新搜索', '重新搜索', '预览达到扫描上限，请收紧条件',
    '匹配样本', '样本暂时不可用', '部分文件夹不可用，请重新预览', '附件状态', '有附件', '无附件', '附件文件名', '附件类型',
    '显示顺序', '按文件夹', '按收取时间', '仅排序已扫描的结果。', '本次搜索已扫描完毕。',
    '还有文件夹待扫描。', '部分文件夹尚未扫完或需要重试。',
    '已达到排序显示上限，可切换按文件夹查看其余结果。', '邮箱已重建，已移除该文件夹的旧结果。',
    '按会话显示', '会话邮件', '只合并本页中具有回复关系的邮件。',
    '管理个人标签', '标签名称', '新增标签', '个人标签', '添加个人标签', '重命名标签', '删除标签', '此文件夹不支持个人标签',
    '同步成功后自动预览', '只预览本次同步的账号，应用仍需手动确认。', '同步后自动预览', '已关闭自动预览或规则已修改'];
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR', 'de-DE']) {
    for (const source of sources) assert.ok(window.MailContinuationText(source, locale)?.trim(), `${locale}: ${source}`);
  }
  assert.equal(window.MailContinuationText('返回列表', 'zh-CN'), undefined, 'Chinese uses the original label');
});


test('attachment scan continues after zero hits, ignores inline images, and returns read-only download metadata', async t => {
  const observe = [], filename = '发票.pdf';
  const folder = 'U1-A01.INBOX';
  const structure = (...childNodes) => ({ type: 'multipart/mixed', childNodes });
  const inline = { type: 'image/png', part: '2', disposition: 'inline', dispositionParameters: { filename: 'logo.png' } };
  const document = { type: 'application/pdf', part: '3', disposition: 'attachment', size: 123, dispositionParameters: { filename } };
  const rows = Array.from({ length: 21 }, (_, i) => ({ ...row(i + 1), internalDate: new Date('2026-01-08T00:00:00Z'), bodyStructure: i === 0 ? structure(inline, document) : structure(inline) }));
  const f = await apiFixture(t, { [folder]: { validity: 77, next: 22, rows } }, { onFetch(uids, fields) { observe.push({ uids, fields }); } });
  const filter = { folder, attachmentName: '发票.PDF', attachmentType: 'application/*', pageSize: 50 };
  const first = await f.post('/messages/search', filter);
  assert.equal(first.status, 200); assert.equal(first.body.inspectedCandidates, 20);
  assert.equal(first.body.total, null); assert.deepEqual(first.body.messages, []); assert.ok(first.body.resumeCursor);
  const invalid = await f.post('/messages/search', { ...filter, attachmentType: 'text/*', cursor: first.body.resumeCursor });
  assert.equal(invalid.status, 409);
  const next = await f.post('/messages/search', { ...filter, cursor: first.body.resumeCursor });
  assert.equal(next.status, 200); assert.equal(next.body.resumeCursor, null);
  assert.deepEqual(next.body.messages.map(item => item.uid), [1]);
  assert.equal(next.body.messages[0].receivedAt, '2026-01-08T00:00:00.000Z');
  assert.deepEqual(next.body.messages[0].matchingAttachments, [{ part: '3', filename, contentType: 'application/pdf', size: 123, inline: false }]);
  assert.ok(observe.every(({ uids, fields }) => uids.length <= 20 && fields.bodyStructure && !fields.source && !fields.bodyParts));
  const absent = await f.post('/messages/search', { folder, attachment: 'absent', pageSize: 2 });
  assert.deepEqual(absent.body.messages.map(item => item.uid), [21, 20]);
  assert.equal((await f.post('/messages/search', { folder, attachment: 'absent', attachmentName: filename })).status, 400);
  assert.equal(normalizeSavedSearch({ name: 'Invoices', scope: 'all', filters: { attachmentName: filename } }).filters.attachmentName, filename);
  assert.throws(() => normalizeRule({ name: 'Invoices', scope: 'all', filters: { attachmentName: filename }, action: 'star' }), { statusCode: 400 });
});

test('received-time order compares server receipt, resolves ties across folders and excludes failures', () => {
  const { scannedByReceived } = require('../web/js/mail-result-order');
  const wrap = (folder, messages, ok = true) => ({ folder, messages, ok });
  const msg = (uid, receivedAt) => ({ uid, receivedAt, date: '2099-01-01T00:00:00.000Z' });
  const tie = '2026-01-08T00:00:00.000Z';
  const groups = [wrap('B', [msg(8, tie), msg(1, '2026-01-09T00:00:00.000Z')]), wrap('A', [msg(1, tie), msg(2, tie), msg(3, null)]), wrap('C', [msg(1, '2099-01-01T00:00:00.000Z')], false)];
  assert.deepEqual(scannedByReceived(groups).map(({ group, message }) => [group.folder, message.uid]), [['B', 1], ['A', 2], ['A', 1], ['B', 8], ['A', 3]]);
  assert.equal(groups[1].messages[0].uid, 1);
});


test('received scan accumulates and dedupes slices with bounded top results and scoped invalidation', () => {
  const { createReceivedScan } = require('../web/js/mail-result-order');
  const scan = createReceivedScan({ maxRows: 3, maxFolders: 3 });
  const message = (uid, day) => ({ uid, receivedAt: `2026-01-${String(day).padStart(2, '0')}` });
  const group = (folder, messages, options = {}) => ({ folder, ok: true, uidValidity: '77', messages,
    scanCeiling: 5, scanBefore: 6, scanAfter: 0, state: 'complete', ...options });
  const keys = () => scan.rows().map(({ group, message }) => `${group.folder}:${message.uid}`);
  const a = group('A', [message(5, 4), message(4, 2)], { state: 'limited', scanAfter: 4, resumeCursor: 'continue-a' });
  scan.page({ scopeTag: 'scope-a', groups: [a], nextFoldersCursor: 'page2' }, 1);
  assert.deepEqual(keys(), ['A:5', 'A:4']);
  assert.deepEqual(scan.coverage(), { complete: false, incomplete: true, limited: false, moreFolders: true });
  const b = group('B', [message(5, 5)]);
  scan.page({ scopeTag: 'scope-a', groups: [b], nextFoldersCursor: null }, 2);
  assert.deepEqual(keys(), ['B:5', 'A:5', 'A:4']);
  // Revisit page one: same UIDs from the earlier slice cannot duplicate or rewind it.
  scan.slice({ scopeTag: 'scope-a', groups: [group('A', [message(1, 6)], { scanBefore: 4 })] });
  scan.page({ scopeTag: 'scope-a', groups: [a], nextFoldersCursor: 'page2' }, 1);
  assert.deepEqual(keys(), ['A:1', 'B:5', 'A:5']);
  assert.deepEqual(scan.coverage(), { complete: false, incomplete: false, limited: true, moreFolders: false });
  assert.equal(scan.controls().find(item => item.folder === 'A').state, 'complete');
  scan.slice({ scopeTag: 'scope-a', groups: [{ folder: 'A', ok: false, state: 'failed', reason: 'mailbox_changed', messages: [], retryCursor: 'new-a' }] });
  assert.deepEqual(keys(), ['B:5']); assert.equal(scan.controls()[0].retryCursor, 'new-a');
  scan.page({ scopeTag: 'scope-b', groups: [], emptyGroups: [group('C', [])], nextFoldersCursor: null }, 1);
  assert.deepEqual(keys(), []); assert.equal(scan.coverage().complete, true);
});

test('conversation membership uses bounded explicit headers, isolates accounts, and never deduplicates messages', async t => {
  const { conversationTokens } = require('../server/mail-conversations');
  const { groupConversations } = require('../web/js/mail-result-order');
  const roots = ['U1-A1', 'U1-A2'];
  const rows = [
    { ...row(5, 'Different title'), envelope: { subject: 'Different title', messageId: '<a@EXAMPLE.invalid>' } },
    { ...row(4), headers: Buffer.from('References: <a@example.invalid>\r\n\t<b@example.invalid>\r\n') },
    { ...row(3), envelope: { subject: 'all', inReplyTo: '<b@example.invalid>' } },
    { ...row(2), envelope: { subject: 'all' } },
    { ...row(1), headers: Buffer.from('References: <a@example.invalid> ' + 'a'.repeat(10000)) },
  ];
  const folders = ['U1-A1.Inbox', 'U1-A1.Archive', 'U1-A1.Inbox', 'U1-A1.Inbox', 'U1-A1.Inbox'];
  const items = rows.map((item, i) => ({ message: { ...item, threadTokens: conversationTokens(item, folders[i], roots, 's1') }, group: { folder: folders[i] } }));
  const copy = { message: { ...rows[0], threadTokens: conversationTokens(rows[0], 'U1-A2.Inbox', roots, 's1') } };
  assert.deepEqual(groupConversations([...items, copy]).map(group => group.map(({ message }) => message.uid)), [[5, 4, 3], [2], [1], [5]]);
  assert.deepEqual(conversationTokens(rows[0], 'unmapped-A', [], 's1').length, 1);
  assert.notDeepEqual(conversationTokens(rows[0], 'unmapped-A', [], 's1'), conversationTokens(rows[0], 'unmapped-B', [], 's1'));
  const seen = [];
  const f = await apiFixture(t, { 'U1-A1.Inbox': { validity: 12, next: 6, rows } }, { onFetch(_, fields) { seen.push(fields); } });
  const query = { folder: 'U1-A1.Inbox', pageSize: 2 };
  const normal = await f.post('/messages/search', query);
  assert.equal(normal.body.messages[0].threadTokens, undefined);
  assert.equal(seen[0].headers, undefined);
  const threaded = await f.post('/messages/search', { ...query, conversations: true });
  assert.deepEqual(seen[1].headers, ['references']);
  assert.equal(seen[1].source, undefined);
  assert.ok(threaded.body.messages[0].threadTokens.every(token => /^[a-z0-9_-]{43}$/i.test(token)));
  assert.equal((await f.post('/messages/search', { ...query, cursor: threaded.body.resumeCursor })).status, 409);
});
