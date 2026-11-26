'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const express = require('express');
const { createMailRouter } = require('../server/mail-reader');
const { chromium } = require(process.env.MAIL_TEST_PLAYWRIGHT_MODULE || 'playwright');
const { DatabaseSync } = require('node:sqlite');

test('dashboard renders accounts while diagnostics are pending and contains mobile tables', async t => {
  const app = express();
  let allowHealth, allowDovecot, requestCount = 0;
  const healthGate = new Promise(resolve => { allowHealth = resolve; });
  const dovecotGate = new Promise(resolve => { allowDovecot = resolve; });
  app.get('/api/auth/me', (_, res) => res.json({ id: 1, username: 'Fixture', role: 'admin', primaryAdmin: true, csrfToken: 'fixture' }));
  app.get('/api/branding', (_, res) => res.json({ web_language: 'zh-CN' }));
  app.get('/api/dashboard', async (req, res) => {
    if (req.query.view === 'accounts') return res.json({ accountStats: { total: 1 },
      recentAccounts: [{ name: 'Synthetic account with a long display name for mobile', last_sync_status: 'success' }] });
    if (req.query.view === 'dovecot') {
      await dovecotGate;
      return res.json({ dovecotStatus: { targetUser: 'fixture-dovecot', reachable: true, userExists: true, maildirExists: true, authTestOk: true } });
    }
    res.status(502).json({ error: 'Synthetic system failure' });
  });
  app.get('/api/health', async (req, res) => {
    if (req.query.view === 'runtime') return res.json({ runtime: {
      installationProfile: 'alpine_3_24', versions: { node: '24.22.3', dovecot: '2.4.5' },
      queues: { mailTasks: { running: 1, queued: 2, checkingScope: 1 } },
      restore: { state: 'ready', last: { outcome: 'recovered_committed', at: '2026-11-23T00:00:00.000Z' } },
    } });
    requestCount++;
    await healthGate;
    res.json({ ok: true, checks: [], summary: { failed: 0, total: 0, critical: 0 } });
  });
  app.get('/api/system/diagnostics', (_, res) => res.attachment('mail-aggregator-diagnostics.json').json({ formatVersion: 1 }));
  app.use(express.static(path.join(__dirname, '../web')));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  t.after(async () => { allowHealth(); allowDovecot(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  browser = await chromium.launch({ headless: true, executablePath: process.env.MAIL_TEST_BROWSER_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.getByText(/Synthetic account with/).waitFor();
  await page.getByText('系统状态暂时无法加载').waitFor();
  assert.equal(requestCount, 1);
  await page.getByText(/重启后已确认恢复/).waitFor();
  assert.equal(await page.locator('#dovecot-grid .card').count(), 0);
  assert.match(await page.locator('#health-summary').textContent(), /正在检查/);
  allowHealth();
  allowDovecot();
  await page.getByText('fixture-dovecot').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载脱敏诊断报告' }).click();
  assert.equal((await downloadPromise).suggestedFilename(), 'mail-aggregator-diagnostics.json');
  const screenshots = process.env.MAIL_TEST_SCREENSHOT_DIR;
  if (screenshots) {
    fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'diagnostics-mobile.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'diagnostics-desktop.png'), fullPage: true });
  assert.deepEqual(errors, []);
});

test('browser handles cross-folder search, unified unread, flags and background progress', async t => {
  const makeMessage = (uid, prefix) => ({ uid, size: 1572864, flags: new Set(), body: 'synthetic content', recipient: 'reader@example.invalid', envelope: { subject: `${prefix} ${uid}`, to: [{ address: 'reader@example.invalid' }] } });
  const boxes = {
    'U1-A1.INBOX': { validity: '77', messages: Array.from({ length: 31 }, (_, i) => makeMessage(i + 1, 'Fixture A')) },
    'U1-A2.INBOX': { validity: '88', messages: [makeMessage(31, 'Fixture B')] },
  };
  const app = express(); app.use(express.json());
  const savedDb = new DatabaseSync(':memory:');
  savedDb.transaction = fn => () => { savedDb.exec('BEGIN'); try { const result = fn(); savedDb.exec('COMMIT'); return result; } catch (error) { savedDb.exec('ROLLBACK'); throw error; } };
  savedDb.exec('PRAGMA foreign_keys=ON; CREATE TABLE admin_users(id INTEGER PRIMARY KEY); INSERT INTO admin_users VALUES(1)');
  savedDb.exec(`CREATE TABLE saved_searches(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_user_id INTEGER,name TEXT,
    scope TEXT,folder TEXT,filters_json TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')))`);
  savedDb.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY, owner_user_id INTEGER, local_user TEXT, mailbox_folder TEXT, destination_mode TEXT);
    CREATE TABLE mailbox_ownership(local_user TEXT, mailbox_folder TEXT, owner_user_id INTEGER, former_account_id INTEGER);
    INSERT INTO accounts VALUES(1,1,'mailuser','U1-A1','subfolder'),(2,1,'mailuser','U1-A2','subfolder');
    INSERT INTO mailbox_ownership VALUES('mailuser','U1-A1',1,1),('mailuser','U1-A2',1,2);`);
  app.get('/api/auth/me', (_, res) => res.json({ id: 1, username: 'Fixture', role: 'user', csrfToken: 'fixture' }));
  app.get('/api/branding', (_, res) => res.json({ web_language: 'zh-CN' }));
  app.get('/api/accounts', (_, res) => res.json([
    { id: 1, name: 'Fixture account A', destination_mode: 'subfolder', destination_folder: 'A', mailbox_folder: 'U1-A1' },
    { id: 2, name: 'Fixture account B', destination_mode: 'subfolder', destination_folder: 'B', mailbox_folder: 'U1-A2' },
  ]));
  const mailRouter = createMailRouter({
    savedSearchDb: savedDb,
    taskDb: savedDb, labelLocalUser: 'mailuser',
    mailAccessForRequest: () => ({ roots: ['U1-A1', 'U1-A2'], all: false }),
    createClient: () => {
      let box;
      return {
        async connect() {}, async logout() {}, close() {},
        async list() { return Object.entries(boxes).map(([folder, value]) => ({ path: folder, name: 'INBOX', delimiter: '.', flags: new Set(),
          status: { messages: value.messages.length, unseen: value.messages.filter(m => !m.flags.has('\\Seen')).length } })); },
        async mailboxOpen(folder) { box = boxes[folder]; if (box.fail) throw new Error('Synthetic folder unavailable');
          return { uidValidity: box.validity, uidNext: box.next ?? 32, exists: box.messages.length }; },
        async search(query) { return box.messages.filter(message => {
          if (query.seen !== undefined && message.flags.has('\\Seen') !== query.seen) return false;
          if (query.flagged !== undefined && message.flags.has('\\Flagged') !== query.flagged) return false;
          if (query.subject && !message.envelope.subject.includes(query.subject)) return false;
          if (query.to && !message.recipient.includes(query.to)) return false;
          if (query.body && !message.body.includes(query.body)) return false;
          if (query.larger && message.size <= query.larger) return false;
          if (query.smaller && message.size >= query.smaller) return false;
          if (query.uid) { const [a, b] = query.uid.split(':'); if (message.uid < Number(a) || (b !== '*' && message.uid > Number(b))) return false; }
          return true;
        }).map(message => message.uid); },
        async fetchAll(uids) { return box.messages.filter(message => uids.includes(message.uid)); },
        async fetchOne(uid, fields) { const message = box.messages.find(item => item.uid === uid); if (!message) return false;
          return fields.source ? { source: Buffer.from('Subject: fixture\r\n\r\nSynthetic body\r\n') } : message; },
        async download(uid, part, options) {
          assert.equal(part, '2'); assert.ok(options.uid);
          return { content: Readable.from([`synthetic file for ${uid}`]) };
        },
        async messageFlagsAdd(uids, flags) { await delay([uids].flat().length > 10 ? 3000 : 350); box.messages.filter(m => [uids].flat().includes(m.uid)).forEach(m => flags.forEach(flag => m.flags.add(flag))); return true; },
        async messageFlagsRemove(uids, flags) { box.messages.filter(m => [uids].flat().includes(m.uid)).forEach(m => flags.forEach(flag => m.flags.delete(flag))); return true; },
      };
    },
  });
  const tasks = mailRouter.mailTasks;
  app.use('/api/mail', (req, res, next) => { req.user = { id: 1 }; next(); }, mailRouter);
  app.use(express.static(path.join(__dirname, '../web')));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  let browser;
  t.after(async () => { if (browser) await browser.close(); await tasks.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); savedDb.close(); });
  const launchOptions = { headless: true };
  if (process.env.MAIL_TEST_BROWSER_EXECUTABLE) launchOptions.executablePath = process.env.MAIL_TEST_BROWSER_EXECUTABLE;
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const screenshotRoot = process.env.MAIL_TEST_SCREENSHOT_DIR;
  if (screenshotRoot) fs.mkdirSync(screenshotRoot, { recursive: true });
  const capture = name => screenshotRoot ? page.screenshot({ path: path.join(screenshotRoot, name), fullPage: true }) : Promise.resolve();
  const errors = [], searchRequests = []; page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/mail\/(?:search|messages\/search)(?:\?|$)/.test(request.url())) searchRequests.push({ url: request.url(), method: request.method() }); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`http://127.0.0.1:${server.address().port}/mail.html`);
  await page.locator('#reader-content').waitFor({ state: 'visible', timeout: 10000 }).catch(async error => {
    await capture('initialization-failure.png');
    throw new Error(`page errors: ${JSON.stringify(errors)}; notifications: ${JSON.stringify(await page.locator('.toast').allTextContents())}`, { cause: error });
  });
  assert.equal(boxes['U1-A1.INBOX'].messages.filter(m => m.flags.has('\\Seen')).length, 0);
  let failPage = true;
  const failedPagination = async route => {
    const query = route.request().postDataJSON();
    if (query.page === '2' && failPage) {
      failPage = false;
      await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic page failure' }) });
    } else await route.continue();
  };
  await page.route('**/api/mail/messages/search', failedPagination);
  await page.locator('#next-page').click();
  await page.getByText('邮件加载失败，请刷新后重试').waitFor();
  await page.waitForFunction(() => !document.getElementById('next-page').disabled);
  const retry = page.waitForRequest(request => request.url().endsWith('/api/mail/messages/search'));
  await page.locator('#next-page').click();
  assert.equal((await retry).postDataJSON().page, '2', 'retry must not skip the failed page');
  await page.locator('.message-item').filter({ hasText: 'Fixture A 1' }).waitFor();
  await page.unroute('**/api/mail/messages/search', failedPagination);
  await page.locator('#previous-page').click();
  await page.locator('.message-item').filter({ hasText: 'Fixture A 31' }).waitFor();
  let seenFetched, releaseSeen;
  const oldSeenReady = new Promise(resolve => { seenFetched = resolve; });
  const oldSeenGate = new Promise(resolve => { releaseSeen = resolve; });
  const seenPattern = /\/api\/mail\/messages\/31\/seen\?/;
  const delayedSeen = async route => {
    const response = await route.fetch();
    seenFetched(); await oldSeenGate; await route.fulfill({ response });
  };
  await page.route(seenPattern, delayedSeen);
  try {
    await page.locator('.message-item').filter({ hasText: 'Fixture A 31' }).locator('.message-open').click();
    await oldSeenReady;
    boxes['U1-A1.INBOX'] = { validity: '99', messages: boxes['U1-A1.INBOX'].messages.map(message => ({ ...message, flags: new Set() })) };
    await page.locator('#refresh-mail').click();
    await page.waitForFunction(() => document.getElementById('export-message').href.includes('uidValidity=99') && document.getElementById('reader-content').style.display !== 'none');
    assert.equal(await page.locator('#toggle-seen').textContent(), '标为已读');
    const oldRefresh = page.waitForResponse(response => response.url().endsWith('/api/mail/folders'));
    releaseSeen(); await oldRefresh;
    assert.equal(await page.locator('#toggle-seen').textContent(), '标为已读', 'old mailbox response must not change the rebuilt mailbox');
    assert.ok(!boxes['U1-A1.INBOX'].messages.find(message => message.uid === 31).flags.has('\\Seen'));
  } finally { releaseSeen(); await page.unroute(seenPattern, delayedSeen); }
  boxes['U1-A1.Stale'] = { validity: '76', messages: [] };
  let folderReady, releaseFolder, firstFolder = true;
  const oldFolderReady = new Promise(resolve => { folderReady = resolve; });
  const oldFolderGate = new Promise(resolve => { releaseFolder = resolve; });
  const delayedFolders = async route => {
    if (!firstFolder) return route.continue();
    firstFolder = false; const response = await route.fetch(); folderReady(); await oldFolderGate;
    try { await route.fulfill({ response }); } catch (_) { /* browser cancellation can discard this older route */ }
  };
  await page.route('**/api/mail/folders', delayedFolders);
  try {
    await page.evaluate(() => { window.staleFolderRequest = loadFolders().catch(error => { if (error.name !== 'AbortError') throw error; }); });
    await oldFolderReady; delete boxes['U1-A1.Stale'];
    await page.evaluate(() => loadFolders()); releaseFolder(); await page.evaluate(() => window.staleFolderRequest);
    assert.equal(await page.locator('[data-folder="U1-A1.Stale"]').count(), 0, 'delayed folder refresh must not restore stale folders');
  } finally { releaseFolder(); await page.unroute('**/api/mail/folders', delayedFolders); }
  await page.locator('#search-scope').selectOption('all');
  await page.locator('#mail-search button[type=submit]').click();
  await page.getByText('请至少填写一个搜索条件').waitFor();
  await page.locator('#mail-search [name=subject]').fill('31');
  await page.locator('#mail-search [name=to]').fill('reader');
  await page.locator('#mail-search [name=body]').fill('synthetic');
  await page.locator('#mail-search [name=largerMb]').fill('1'); await page.locator('#mail-search [name=smallerMb]').fill('2');
  await page.locator('#mail-search button[type=submit]').click();
  await page.locator('.mail-list-pane').getByText('Fixture account B / INBOX').waitFor();
  assert.equal(await page.locator('.message-item').count(), 2);
  assert.ok(await page.locator('.message-item').filter({ hasText: 'Fixture A 31' }).isVisible());
  assert.ok(await page.locator('.message-item').filter({ hasText: 'Fixture B 31' }).isVisible());
  await page.locator('#save-search').click();
  await page.locator('#saved-search-editor [name=name]').fill('Search <img src=x onerror=alert(1)>');
  await page.locator('#saved-search-editor [type=submit]').click();
  await page.locator('[data-open-search]').waitFor();
  assert.equal(await page.locator('#saved-search-list img').count(), 0, 'saved names are text, never HTML');
  await page.locator('[data-rename-search]').click();
  await page.locator('#saved-search-editor [name=name]').fill('Saved 31');
  await page.locator('#saved-search-editor [type=submit]').click();
  await page.locator('[data-open-search]').filter({ hasText: 'Saved 31' }).waitFor();
  const stored = savedDb.prepare('SELECT * FROM saved_searches').get();
  assert.equal(stored.scope, 'all'); assert.equal(JSON.parse(stored.filters_json).body, 'synthetic');
  await page.locator('#mail-search button[type=reset]').click();
  await page.locator('[data-open-search]').click();
  await page.waitForFunction(() => document.getElementById('current-folder').textContent === 'Saved 31' && document.querySelectorAll('.message-item').length === 2);
  await page.locator('#mail-search [name=body]').fill('unsent form edit');
  await page.locator('.unread-group').filter({ hasText: 'Fixture account B / INBOX' }).locator('[data-result-folder]').click();
  await page.locator('.message-item').filter({ hasText: 'Fixture B 31' }).waitFor();
  assert.equal(await page.locator('#search-scope').inputValue(), 'folder');
  assert.equal(await page.locator('#mail-search [name=body]').inputValue(), 'synthetic');
  assert.ok(searchRequests.some(request => request.url.endsWith('/api/mail/search') && request.method === 'POST'));
  assert.ok(searchRequests.some(request => request.url.endsWith('/api/mail/messages/search') && request.method === 'POST'));
  assert.ok(searchRequests.every(request => !request.url.includes('synthetic') && !request.url.includes('reader')));
  const folderSearch = await page.evaluate(async () => {
    const search = await Api.post('/api/mail/saved-searches', { name: 'Folder fixture', scope: 'folder', folder: 'U1-A2.INBOX', filters: { flagged: 'starred' } });
    await savedSearches.load(); return search;
  });
  await page.locator(`[data-open-search="${folderSearch.id}"]`).click();
  await page.waitForFunction(() => document.getElementById('current-folder').textContent === 'Folder fixture');
  if (!await page.locator('[data-folder="U1-A2.INBOX"]').isVisible()) await page.locator('[data-group="account-2"] .folder-group-header').click();
  await page.locator('[data-folder="U1-A2.INBOX"]').click();
  await page.waitForFunction(() => document.getElementById('current-folder').textContent === 'U1-A2.INBOX' && document.querySelectorAll('.message-item').length === 1);
  assert.deepEqual(await page.evaluate(() => ({ saved: mailState.savedSearchId, filters: mailState.filters, flagged: document.querySelector('#mail-search [name=flagged]').value })), { saved: null, filters: {}, flagged: 'all' });
  await page.evaluate(async id => { await Api.del(`/api/mail/saved-searches/${id}`); await savedSearches.load(); }, folderSearch.id);
  await page.locator('#mail-search button[type=reset]').click();
  await page.locator('.message-item').filter({ hasText: 'Fixture B 31' }).waitFor();
  await page.locator('#unread-view').click();
  await page.locator('.mail-list-pane').getByText('Fixture account B / INBOX').waitFor();
  const rowA = () => page.locator('.message-item').filter({ hasText: 'Fixture A 31' });
  const rowB = () => page.locator('.message-item').filter({ hasText: 'Fixture B 31' });
  await rowA().locator('.message-star').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.message-item')].some(row => row.textContent.includes('Fixture A 31') && row.querySelector('.message-star').getAttribute('aria-pressed') === 'true'));
  await page.locator('#starred-view').click();
  await page.waitForFunction(() => document.getElementById('current-folder').textContent === '星标邮件' && document.querySelectorAll('.message-item').length === 1);
  assert.ok(await rowA().isVisible()); assert.equal(await rowB().count(), 0);
  await capture('starred-desktop.png');
  await page.locator('#unread-view').click(); await rowB().waitFor();
  await page.locator('.unread-group').filter({ hasText: 'Fixture account B / INBOX' }).locator('[data-result-folder]').click();
  await rowB().waitFor();
  assert.deepEqual(await page.evaluate(() => ({ filters: mailState.filters, seen: document.querySelector('#mail-search [name=seen]').value, flagged: document.querySelector('#mail-search [name=flagged]').value })), { filters: { seen: 'unread' }, seen: 'unread', flagged: 'all' });
  await page.locator('#unread-view').click(); await rowB().waitFor();
  await rowA().locator('.message-select').check(); await rowB().locator('.message-select').check();
  await page.locator('[data-bulk-flag="seen"][data-value="true"]').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.message-item')].some(row => row.textContent.includes('Fixture B 31')));
  assert.ok(boxes['U1-A1.INBOX'].messages.find(m => m.uid === 31).flags.has('\\Seen'));
  assert.ok(boxes['U1-A2.INBOX'].messages[0].flags.has('\\Seen'));
  await page.locator('[data-result-folder]').first().click();
  const response = page.waitForResponse(r => r.url().endsWith('/api/mail/seen-jobs') && r.request().method() === 'POST');
  await page.locator('#folder-seen-all').click(); await response;
  await page.waitForFunction(() => !!sessionStorage.getItem('mail-seen-job'));
  // A new tab or lost sessionStorage can still discover the user's active job.
  await page.evaluate(() => sessionStorage.removeItem('mail-seen-job'));
  await page.reload();
  await page.getByText('批量任务已完成', { exact: false }).waitFor({ timeout: 15000 });
  assert.equal(boxes['U1-A1.INBOX'].messages.filter(m => !m.flags.has('\\Seen')).length, 0);
  await page.locator('#mail-search button[type=reset]').click();
  await page.locator('#search-scope').selectOption('all');
  await page.locator('#mail-search [name=subject]').fill('Fixture B');
  await page.locator('#mail-search button[type=submit]').click(); await rowB().waitFor();
  await page.locator('#create-rule').click();
  await page.locator('#rule-editor [name=name]').fill('Rule <img src=x onerror=alert(1)>');
  await page.locator('#rule-editor [name=action]').selectOption('unseen');
  assert.equal(await page.locator('#rule-editor [name=subject]').inputValue(), 'Fixture B');
  await capture('rule-editor-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await capture('rule-editor-mobile.png');
  await page.locator('#rule-editor [type=submit]').scrollIntoViewIfNeeded();
  await capture('rule-editor-mobile-actions.png');
  await page.locator('#rule-editor [type=submit]').click();
  await page.locator('[data-preview-rule]').waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.locator('#rule-list img').count(), 0);
  assert.equal(boxes['U1-A2.INBOX'].messages[0].flags.has('\\Seen'), true, 'saving and previewing rules must not change flags');
  await page.locator('[data-preview-rule]').click();
  await page.waitForFunction(() => !document.getElementById('apply-rule-preview').disabled);
  assert.match(await page.locator('#rule-preview-summary').textContent(), /匹配邮件 1/);
  assert.match(await page.locator('#rule-preview-expiry').textContent(), /预览有效期至.*\d{4}/);
  await capture('rule-preview-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await capture('rule-preview-mobile.png');
  await page.locator('#apply-rule-preview').click();
  await page.waitForURL('**/logs.html?tab=mail&task=*');
  await page.waitForFunction(() => document.getElementById('mail-task-results').textContent.includes('已完成'));
  assert.equal(await page.locator('#mail-tasks-panel').isVisible(), true);
  assert.equal(await page.locator('#sync-tasks-panel').isVisible(), false);
  assert.equal(boxes['U1-A2.INBOX'].messages[0].flags.has('\\Seen'), false);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await capture('task-center-mobile.png');
  await page.setViewportSize({ width: 1440, height: 900 }); await capture('task-center-desktop.png');
  await page.goto(`http://127.0.0.1:${server.address().port}/mail.html`);
  await page.locator('[data-open-search]').waitFor();
  await page.locator('[data-open-search]').click();
  await page.locator('#mail-search [name=subject]').fill('Fixture B');
  await page.locator('#mail-search button[type=submit]').click();
  await page.locator('#update-saved-search').click();
  await page.locator('#saved-search-editor [type=submit]').click();
  await page.waitForFunction(() => !document.getElementById('saved-search-dialog').open);
  assert.equal(JSON.parse(savedDb.prepare('SELECT filters_json FROM saved_searches').get().filters_json).subject, 'Fixture B');
  await page.locator('[data-delete-search]').click(); await page.waitForFunction(() => document.querySelectorAll('[data-open-search]').length === 0);
  await page.locator('#mail-search button[type=reset]').click();
  await page.locator('#save-search').click();
  await page.locator('#saved-search-editor [name=name]').fill('Missing folder');
  await page.locator('#saved-search-editor [type=submit]').click();
  await page.locator('[data-open-search]').waitFor();
  const missing = savedDb.prepare('SELECT folder FROM saved_searches').get().folder;
  const removedFixture = boxes[missing];
  delete boxes[missing];
  const missingRequests = [];
  page.on('request', request => { if (request.url().endsWith('/api/mail/messages/search')) missingRequests.push(request.postDataJSON().folder); });
  await page.locator('[data-open-search]').click();
  await page.getByText('保存的搜索文件夹已不存在或无权访问，请编辑搜索范围。').waitFor();
  assert.equal(await page.locator('#current-folder').textContent(), 'Missing folder');
  assert.deepEqual(missingRequests, [], 'missing folder must never fall back to a different folder query');
  await page.setViewportSize({ width: 390, height: 844 });
  const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert.ok(widths.document <= widths.viewport + 1, JSON.stringify(widths));
  await capture('smart-folder-mobile.png');
  await page.locator('[data-rename-search]').click();
  await page.locator('#saved-search-editor [name=folder]').selectOption(Object.keys(boxes)[0]);
  await page.locator('#saved-search-editor [type=submit]').click();
  await page.waitForFunction(() => !document.getElementById('saved-search-dialog').open && document.querySelectorAll('.message-item').length > 0);
  assert.equal(savedDb.prepare('SELECT folder FROM saved_searches').get().folder, Object.keys(boxes)[0]);
  boxes[missing] = removedFixture;
  await page.evaluate(() => loadFolders());
  await page.locator('.folder-item[data-folder="U1-A1.INBOX"]').click();
  const keyword = page.locator('#mail-search [name=subject]');
  boxes['U1-A1.INBOX'].messages.find(item => item.uid === 31).envelope.subject = 'Fixture A 31 all';
  await keyword.fill('all');
  const sentKeyword = page.waitForRequest(request => request.url().endsWith('/api/mail/messages/search') && request.postDataJSON()?.subject === 'all');
  await page.locator('#mail-search button[type=submit]').click(); await sentKeyword;
  await page.getByText('Fixture A 31 all', { exact: true }).waitFor();
  assert.equal(await page.locator('.message-item').count(), 1);
  await page.locator('#search-scope').selectOption('all');
  const sentGlobal = page.waitForRequest(request => request.url().endsWith('/api/mail/search') && request.postDataJSON()?.subject === 'all');
  await page.locator('#mail-search button[type=submit]').click(); await sentGlobal;
  await page.getByText('Fixture A 31 all', { exact: true }).waitFor();
  await page.locator('#search-scope').selectOption('folder');
  // Return directly from a different list page, including while that page is in flight.
  const filter = page.locator('#mail-search [name=subject]');
  await page.evaluate(() => { mailState.pageSize = 15; });
  await filter.fill('Fixture A');
  await page.locator('#mail-search button[type=submit]').click();
  await page.locator('.message-item').filter({ hasText: 'Fixture A 31' }).waitFor();
  await page.locator('#next-page').click();
  const startRow = page.locator('.message-open').filter({ has: page.getByText('Fixture A 16', { exact: true }) });
  await startRow.waitFor();
  const origin = await startRow.evaluate(button => {
    const list = document.getElementById('message-list');
    list.scrollTop = 83;
    window.scrollTo({ top: 160, behavior: 'instant' });
    button.focus({ preventScroll: true });
    return { listTop: list.scrollTop, screenY: window.scrollY };
  });
  assert.ok(origin.listTop > 0); assert.ok(origin.screenY > 0);
  const restored = async () => {
    await startRow.waitFor();
    await page.waitForFunction(({ listTop, screenY }) => mailState.page === 2
      && document.activeElement?.textContent.includes('Fixture A 16')
      && document.getElementById('message-list').scrollTop === listTop && window.scrollY === screenY, origin);
    assert.equal(await filter.inputValue(), 'Fixture A');
  };
  await page.keyboard.press('Enter');
  await page.locator('#reader-subject').waitFor();
  assert.equal(await page.locator('.mail-list-pane').isVisible(), false);
  await page.waitForFunction(() => document.activeElement?.id === 'reader-subject');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => mailState.page === 1 && mailState.selectedUid === 17);
  const locationBefore = page.url();
  await page.goBack();
  await restored();
  assert.equal(page.url(), locationBefore);

  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'reader-subject');
  let entered, release;
  const held = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { entered = resolve; });
  const pageSearch = '**/api/mail/messages/search';
  const holdPage = async route => {
    if (route.request().postDataJSON()?.page === '1') { entered(); await held; }
    await route.continue().catch(() => {});
  };
  await page.route(pageSearch, holdPage);
  try {
    await page.keyboard.press('ArrowLeft');
    await requested;
    await page.locator('#reader-back').click();
    await restored();
  } finally { release(); await page.unroute(pageSearch, holdPage); }
  assert.equal(await page.evaluate(() => mailState.page), 2);
  await page.evaluate(() => { mailState.pageSize = 30; });

  // All eight initial folders exhaust their bounded scan. One folder can be
  // retried in place while the next batch still discovers another match.
  const marker = 8_000_000 - 64 * 256;
  for (let index = 1; index <= 8; index++) boxes[`U1-A1.A0${index}`] =
    { validity: String(index + 100), next: 8_000_001, messages: [makeMessage(marker, 'Continue marker')] };
  boxes['U1-A1.INBOX'].messages.find(item => item.uid === 31).envelope.subject = 'Continue marker 31';
  await page.locator('#search-scope').selectOption('all');
  await filter.fill('Continue marker');
  await page.locator('#mail-search button[type=submit]').click();
  await page.getByText('尚未扫描完毕', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('尚未扫描完毕', { exact: true }).count(), 8);
  boxes['U1-A1.A01'].fail = true;
  await page.getByRole('button', { name: '继续扫描此文件夹' }).first().click();
  await page.getByRole('button', { name: '重试此文件夹' }).waitFor();
  boxes['U1-A1.A01'].fail = false;
  await page.getByRole('button', { name: '重试此文件夹' }).click();
  await page.getByText(`Continue marker ${marker}`, { exact: true }).waitFor();
  assert.ok(await page.getByText('尚未扫描完毕', { exact: true }).count() >= 7);
  await page.getByRole('button', { name: '继续到下一批文件夹' }).click();
  await page.getByText('Continue marker 31', { exact: true }).waitFor();

  // The attachment entry scans metadata, sorts returned hits by receipt time,
  // and opens the same message and guarded download as the regular reader.
  for (const key of Object.keys(boxes)) if (/\.A0[1-8]$/.test(key)) delete boxes[key];
  const a = boxes['U1-A1.INBOX'].messages.find(message => message.uid === 31);
  const b = boxes['U1-A2.INBOX'].messages[0];
  const fileTree = name => ({ type: 'multipart/mixed', childNodes: [{ type: 'application/pdf', part: '2', size: 50, disposition: 'attachment', parameters: { name } }] });
  for (const box of Object.values(boxes)) for (const message of box.messages) message.bodyStructure = { type: 'text/plain', part: '1' };
  a.bodyStructure = fileTree('old <tag>.pdf'); b.bodyStructure = fileTree('new.pdf');
  a.internalDate = new Date('2026-01-01'); b.internalDate = new Date('2026-01-02'); a.envelope.date = new Date('2099-01-01');
  const lateAttachment = boxes['U1-A1.INBOX'].messages.find(message => message.uid === 26);
  const plainBody = lateAttachment.bodyStructure;
  lateAttachment.bodyStructure = fileTree('late-in-scan.pdf');
  await filter.fill('');
  await page.locator('#mail-search [name=attachmentName]').fill('late-in-scan.pdf');
  await page.locator('#mail-search button[type=submit]').click();
  await page.getByText('尚未扫描完毕', { exact: true }).waitFor();
  assert.equal(await page.locator('.message-item').count(), 0);
  await page.getByRole('button', { name: '继续扫描此文件夹' }).click();
  await page.getByRole('link', { name: /late-in-scan\.pdf/ }).waitFor();
  lateAttachment.bodyStructure = plainBody;

  await page.locator('#attachments-view').click();
  await page.getByRole('link', { name: /new\.pdf/ }).waitFor();
  const visibleAttachments = page.locator('.message-item');
  assert.equal(await visibleAttachments.count(), 2);
  assert.match(await visibleAttachments.first().textContent(), /new.pdf/);
  assert.equal(await page.locator('#search-order-coverage').isVisible(), true);
  const downloadLink = visibleAttachments.first().locator('a[download]');
  const download = await page.request.get(new URL(await downloadLink.getAttribute('href'), page.url()).href);
  assert.equal(download.status(), 200);
  assert.equal(download.headers()['x-content-type-options'], 'nosniff');
  assert.match(download.headers()['content-disposition'], /attachment.*new.pdf/);
  assert.equal(await download.text(), 'synthetic file for 31');
  await visibleAttachments.first().locator('.message-open').click();
  await page.waitForFunction(() => mailState.selectedFolder === 'U1-A2.INBOX' && document.getElementById('reader-attachments').textContent.includes('new.pdf'));
  await page.locator('#reader-back').click();
  await page.locator('#search-order').selectOption('folders');
  assert.equal(await page.locator('#search-order-coverage').isVisible(), false);
  assert.match(await visibleAttachments.first().textContent(), /old _tag_.pdf/);

  // The second directory page may return a newer message than any found on
  // page one. Its order must change without losing earlier results or cursors.
  const firstOrderBox = 'U1-A1.A01';
  for (let index = 1; index <= 8; index++) boxes[`U1-A1.A0${index}`] =
    { validity: String(index + 100), next: 1, messages: [] };
  boxes[firstOrderBox].messages = Array.from({ length: 12 }, (_, index) => ({ ...makeMessage(index + 1, 'Receipt order first'), internalDate: new Date('2026-02-01') }));
  boxes[firstOrderBox].next = 13;
  const previousBSubject = b.envelope.subject, previousBDate = b.internalDate;
  b.envelope.subject = 'Receipt order newest'; b.internalDate = new Date('2026-02-02');
  await page.locator('#mail-search [name=attachment]').selectOption('all');
  await page.locator('#search-scope').selectOption('all');
  await filter.fill('Receipt order');
  await page.locator('#mail-search button[type=submit]').click();
  await page.getByText('Receipt order first 12', { exact: true }).waitFor();
  await page.locator('#search-order').selectOption('received');
  const coverage = page.locator('#search-order-coverage');
  assert.match(await coverage.textContent(), /还有文件夹待扫描/);
  await page.getByRole('button', { name: '继续到下一批文件夹' }).click();
  await page.getByText('Receipt order newest', { exact: true }).waitFor();
  assert.match(await page.locator('.message-item').first().textContent(), /Receipt order newest/);
  assert.equal(await page.locator('.message-item').count(), 6);
  assert.match(await coverage.textContent(), /部分文件夹尚未扫完/);
  const firstControl = page.locator('.unread-group').filter({ has: page.locator(`[data-target-folder="${firstOrderBox}"]`) });
  await firstControl.getByRole('button', { name: '继续扫描此文件夹' }).click();
  await page.getByText('Receipt order first 3', { exact: true }).waitFor();
  assert.equal(await page.locator('.message-item').count(), 11);
  boxes[firstOrderBox].validity = '401'; boxes[firstOrderBox].next = 2;
  boxes[firstOrderBox].messages = [{ ...makeMessage(1, 'Receipt order rebuilt'), internalDate: new Date('2026-02-03') }];
  await firstControl.getByRole('button', { name: '继续扫描此文件夹' }).click();
  await page.getByText('邮箱已重建，已移除该文件夹的旧结果。', { exact: true }).waitFor();
  assert.equal(await page.locator('.message-item').count(), 1);
  assert.match(await page.locator('.message-item').first().textContent(), /Receipt order newest/);
  await firstControl.getByRole('button', { name: '重试此文件夹' }).click();
  await page.getByText('Receipt order rebuilt 1', { exact: true }).waitFor();
  assert.equal(await page.locator('.message-item').count(), 2);
  assert.match(await page.locator('.message-item').first().textContent(), /Receipt order rebuilt/);
  assert.match(await coverage.textContent(), /本次搜索已扫描完毕/);
  await page.locator('#search-order').selectOption('folders');
  assert.equal(await page.locator('.message-item').count(), 1);
  assert.match(await page.locator('.message-item').first().textContent(), /Receipt order newest/);
  b.envelope.subject = previousBSubject; b.internalDate = previousBDate;
  for (let index = 1; index <= 8; index++) delete boxes[`U1-A1.A0${index}`];

  // Group only related, visible messages. The other account carries the exact
  // same reply chain but must remain outside the conversation.
  const reply = boxes['U1-A1.INBOX'].messages.find(message => message.uid === 30);
  a.envelope.subject = 'Conversation root'; a.envelope.messageId = '<root@example.invalid>';
  reply.envelope.subject = 'Conversation related'; reply.headers = Buffer.from('References: <root@example.invalid>\r\n');
  b.envelope.subject = 'Conversation different account'; b.envelope.inReplyTo = '<root@example.invalid>';
  await page.locator('#mail-search [name=attachment]').selectOption('all');
  await filter.fill('Conversation');
  await page.locator('#mail-search button[type=submit]').click();
  await page.getByText('Conversation related', { exact: true }).waitFor();
  await page.locator('#mail-conversations').check();
  await page.locator('.mail-conversation').waitFor();
  assert.equal(await page.locator('.mail-conversation .message-item').count(), 2);
  assert.equal(await page.locator('.message-item').count(), 3);
  assert.match(await page.locator('.mail-conversation').textContent(), /Conversation related/);
  assert.doesNotMatch(await page.locator('.mail-conversation').textContent(), /different account/);
  await page.locator('.mail-conversation .message-open').first().click();
  await page.locator('#reader-conversation-count').waitFor();
  assert.match(await page.locator('#reader-conversation-count').textContent(), /\(2\)/);
  await page.locator('#reader-back').click();


  // Personal labels are private, work on the embedded mobile reader, and can
  // filter duplicate UID values across isolated accounts without mixing them.
  await page.locator('#manage-personal-labels').click();
  const manager = page.locator('#personal-label-dialog');
  await manager.locator('[name=name]').fill('标签浏览器验收');
  await manager.locator('button[type=submit]').click();
  await manager.getByText('标签浏览器验收', { exact: true }).waitFor();
  await page.locator('#close-personal-labels').click();
  await page.locator('.message-item').filter({ hasText: 'Conversation root' }).locator('.message-open').click();
  await page.waitForFunction(() => mailState.selectedUid === 31 && mailState.selectedFolder === 'U1-A1.INBOX' && !document.getElementById('reader-content').hidden);
  await page.locator('#edit-message-labels').click();
  const picker = page.locator('#message-label-dialog');
  await Promise.all([page.waitForResponse(response => response.request().method() === 'PUT' && /\/api\/mail\/labels\/\d+\/messages\//.test(response.url()) && response.ok()),
    picker.getByRole('checkbox', { name: '标签浏览器验收' }).check()]);
  await page.locator('#close-message-labels').click();
  await page.locator('#reader-back').click();
  const personalLabel = page.locator('#personal-label-list button');
  await personalLabel.click();
  await page.waitForFunction(() => document.querySelectorAll('.message-item').length === 1 && document.querySelector('.message-item').textContent.includes('Conversation root'));
  assert.equal(await page.locator('.message-item').count(), 1);
  assert.equal(await page.getByText('Conversation different account', { exact: true }).count(), 0);
  await page.locator('#manage-personal-labels').click();
  await manager.getByRole('button', { name: '重命名标签' }).click();
  await manager.locator('[name=name]').fill('已改名标签');
  await manager.locator('button[type=submit]').click();
  await manager.getByText('已改名标签', { exact: true }).waitFor();
  await manager.getByRole('button', { name: '删除标签' }).click();
  await manager.getByText('已改名标签', { exact: true }).waitFor({ state: 'detached' });
  await page.locator('#close-personal-labels').click();

  await page.route('**/api/mail/folders', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ folders: [] }) }));
  await page.locator('#refresh-mail').click();
  await page.locator('#folder-list').getByText('没有可查看的文件夹').waitFor();
  assert.equal(await page.locator('.message-item').count(), 0);
  assert.equal(await page.locator('#reader-content').isVisible(), false);
  assert.equal(await page.locator('#reader-body').textContent(), '');
  assert.equal(await page.locator('#select-page').isEnabled(), false);
  assert.equal(await page.locator('#next-page').isEnabled(), false);
  assert.deepEqual(errors, []);
});
