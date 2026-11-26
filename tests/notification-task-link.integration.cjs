'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const Database = require('better-sqlite3');
const { chromium } = require(process.env.MAIL_TEST_PLAYWRIGHT_MODULE || 'playwright');

const unavailable = '相关同步任务已不可用或当前账号无权查看。';
const missingLog = '同步任务仍可查看，日志文件已清理或不存在。';

test('linked task labels and errors are localized', () => {
  for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'ja-JP', 'ko-KR']) {
    const { translations } = require(`../web/i18n/${locale}.json`);
    for (const source of ['查看同步任务', unavailable, missingLog, '暂时无法加载同步任务，请重试。']) {
      assert.ok(translations[source], `${locale}: ${source}`);
    }
  }
});

test('notification links resolve their exact, authorized sync task even outside the first page', { timeout: 45000 }, async t => {
  const probe = net.createServer();
  const listening = once(probe, 'listening');
  probe.listen(0, '127.0.0.1');
  await listening;
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const temp = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'mail-notification-task-'));
  const child = spawn(process.execPath, [path.join(__dirname, '../server/app.js')], {
    env: { ...process.env, MAIL_AGG_DATA_DIR: root, PORT: String(port), MAIL_AGG_BIND_HOST: '127.0.0.1',
      MAIL_AGG_TRUST_PROXY: 'false', MAIL_AGG_COOKIE_SECURE: 'false', MAIL_AGG_REQUIRE_HTTPS: 'false',
      MAIL_AGG_UPDATE_SOCKET: '', MAIL_AGG_UPDATE_CONTROL: '', MAIL_AGG_UPDATE_JOURNAL: '', MAIL_AGG_MANUAL_UPDATE_JOURNAL: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const closed = once(child, 'close');
  let log = '', browser, db;
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(async () => {
    await browser?.close();
    db?.close();
    child.kill(); await closed;
    assert.equal(path.dirname(root), temp);
    assert.match(path.basename(root), /^mail-notification-task-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (url, session, body) => fetch(base + url, {
    method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000),
    headers: { ...(session && { Cookie: session.cookie, 'X-CSRF-Token': session.csrf }), ...(body && { 'Content-Type': 'application/json' }) },
  });
  let ready = false, startupError;
  for (let i = 0; i < 80 && child.exitCode === null; i++) {
    try {
      const check = await request('/api/auth/setup-status');
      if (check.ok) { ready = true; break; }
      startupError = `HTTP ${check.status}: ${await check.text()}`;
    } catch (error) { startupError = error.cause?.message || error.message; }
    await delay(100);
  }
  assert.ok(ready, `${log}
${startupError ?? 'process exited'}`);
  async function session(url, username) {
    const response = await request(url, null, { username, password: 'synthetic-fixture-password' });
    assert.equal(response.status, 200, await response.clone().text());
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrfToken };
  }
  const admin = await session('/api/auth/setup', 'fixture-admin');
  const memberCreated = await request('/api/users', admin, { username: 'fixture-member', password: 'synthetic-fixture-password' });
  assert.equal(memberCreated.status, 201, await memberCreated.clone().text());
  const member = await session('/api/auth/login', 'fixture-member');
  const memberId = (await memberCreated.json()).id;
  const ownerId = (await (await request('/api/auth/me', admin)).json()).id;
  const now = Date.now();
  db = new Database(path.join(root, 'db', 'mail-aggregator.db'));
  const fixture = db.transaction(() => {
    const addAccount = db.prepare(`INSERT INTO accounts(name,provider,host,username,enabled,owner_user_id)
      VALUES (?,'custom','imap.invalid','fixture',0,?)`);
    const owned = addAccount.run('Primary fixture', ownerId).lastInsertRowid;
    const foreign = addAccount.run('Other user fixture', memberId).lastInsertRowid;
    const addJob = db.prepare(`INSERT INTO sync_jobs(account_id,started_at,status) VALUES(?,?,'failed')`);
    const older = addJob.run(owned, '2025-01-01 08:00:00').lastInsertRowid;
    const noLog = addJob.run(owned, '2025-01-01 08:01:00').lastInsertRowid;
    db.prepare("UPDATE sync_jobs SET status='success' WHERE id=?").run(noLog);
    const anotherUser = addJob.run(foreign, '2025-01-01 08:02:00').lastInsertRowid;
    const cleared = addJob.run(owned, '2025-01-01 08:03:00').lastInsertRowid;
    db.prepare('DELETE FROM sync_jobs WHERE id=?').run(cleared);
    for (let i = 0; i < 25; i++) addJob.run(owned, '2025-01-02 08:00:00');
    const logPath = path.join(root, 'logs', `job-${older}.log`);
    fs.writeFileSync(logPath, 'Synthetic task log\n');
    db.prepare('UPDATE sync_jobs SET log_file=? WHERE id=?').run(logPath, older);
    const outbox = db.prepare(`INSERT INTO notification_outbox(event_id,generation,kind,destination,provider,incident_id,
      account_id,job_id,reason_code,occurred_at,state,updated_at,mount_id,mount_uses,operation_id)
      VALUES(?,0,?,'fixture','webhook',?,?,?,'unknown',?,'sent',?,?,?,?)`);
    function event(kind, account, job, { mount = null, operation = null } = {}) {
      const id = crypto.randomUUID();
      outbox.run(id,kind,crypto.randomUUID(),account,job,now,now,mount,mount && '["logs"]',operation);
      return { id, job };
    }
    return { older: event('failure', owned, older), noLog: event('recovery', owned, noLog), cleared: event('failure', owned, cleared),
      foreign: event('failure', foreign, anotherUser), invalid: event('failure', owned, 0),
      capacity: event('capacity_failure', null, older, { mount: 'fictional-mount' }),
      restore: event('restore_committed', null, older, { operation: crypto.randomUUID() }),
      update: event('update_installed', null, older, { operation: crypto.randomUUID() }) };
  })();
  const link = ({ id, job }) => `/logs.html?job=${job}&event=${id}`;
  const task = ({ id, job }) => `/api/jobs/${job}/notification-task?event=${id}`;
  assert.equal((await request(task(fixture.older))).status, 401);
  assert.equal((await request('/api/notifications/history', member)).status, 403);
  const open = await request(task(fixture.older), admin);
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await open.json(), { id: fixture.older.job, startedAt: '2025-01-01 08:00:00', status: 'failed', accountName: 'Primary fixture' });
  const removed = await request(task(fixture.cleared), admin);
  const forbidden = await request(task(fixture.foreign), admin);
  assert.equal(removed.status, 404);
  assert.equal(forbidden.status, 404);
  assert.deepEqual(await removed.json(), await forbidden.json());
  assert.equal((await request(task(fixture.older), member)).status, 404);
  assert.equal((await request(task({ ...fixture.older, job: fixture.noLog.job }), admin)).status, 404);
  const history = await (await request('/api/notifications/history', admin)).json();
  assert.deepEqual(history.events.filter(item => item.jobLinkAvailable).map(item => item.eventId).sort(), [fixture.older.id, fixture.noLog.id].sort());
  assert.equal((await (await request('/api/jobs', admin)).json()).items.some(item => item.id === fixture.older.job), false);

  browser = await chromium.launch({ headless: true, executablePath: process.env.MAIL_TEST_BROWSER_EXECUTABLE });
  async function pageFor(user) {
    const context = await browser.newContext();
    const equal = user.cookie.indexOf('=');
    await context.addCookies([{ name: user.cookie.slice(0,equal), value: user.cookie.slice(equal+1), url: base }]);
    return context.newPage();
  }
  const page = await pageFor(admin);
  await page.goto(`${base}/settings.html`);
  await page.getByText('通知投递记录', { exact:true }).click();
  const jobLink = page.locator(`a[href="${link(fixture.older)}"]`);
  await jobLink.waitFor();
  assert.equal(await page.locator('a[href^="/logs.html?job="]').count(), 2);
  await page.getByText(unavailable, { exact:true }).first().waitFor();
  await jobLink.click();
  await page.locator('#linked-job-details').getByText(/Primary fixture/).waitFor();
  assert.match(page.url(), new RegExp(`event=${fixture.older.id}`));
  await page.locator('#linked-job-log').click();
  await page.locator('#log-content').getByText(/Synthetic task log/).waitFor();
  await page.goto(`${base}${link(fixture.noLog)}`);
  await page.locator('#linked-job-log').click();
  await page.getByText(missingLog, { exact:true }).waitFor();
  assert.equal(await page.locator('#linked-job-details').isVisible(), true);
  await page.goto(`${base}${link(fixture.cleared)}`);
  await page.locator('#linked-job-message').getByText(unavailable).waitFor();
  assert.equal(await page.locator('#linked-job-details').isVisible(), false);
  const memberPage = await pageFor(member);
  await memberPage.goto(`${base}${link(fixture.older)}`);
  await memberPage.locator('#linked-job-message').getByText(unavailable).waitFor();
  assert.equal(await memberPage.locator('#linked-job-details').isVisible(), false);
  db.prepare('UPDATE notification_runtime SET generation=generation+1 WHERE singleton=1').run();
  assert.equal((await request(task(fixture.older), admin)).status, 404);
  assert.equal((await request(`/api/jobs/${fixture.older.job}/log?event=${fixture.older.id}`, admin)).status, 404);
  assert.equal((await request(`/api/jobs/${fixture.older.job}/log`, admin)).status, 200);
});
