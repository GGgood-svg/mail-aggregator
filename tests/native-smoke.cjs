// Real Express process + production better-sqlite3 + tar. No remote mailbox is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { once } = require('node:events');
const { call: updateProbe } = require('../scripts/updater/rpc');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-native-smoke-'));
  const gate = path.join(root, 'manual-gate');
  const control = process.platform === 'win32' ? '' : path.join(root, 'control.sock');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '../server/app.js')], {
    env: { ...process.env, MAIL_AGG_DATA_DIR: root, PORT: String(port), MAIL_AGG_BIND_HOST: '127.0.0.1',
      MAIL_AGG_TRUST_PROXY: 'false', MAIL_AGG_COOKIE_SECURE: 'false', MAIL_AGG_REQUIRE_HTTPS: 'false',
      MAIL_AGG_UPDATE_SOCKET: '', MAIL_AGG_UPDATE_JOURNAL: '', MAIL_AGG_MANUAL_UPDATE_JOURNAL: control ? gate : '',
      MAIL_AGG_UPDATE_CONTROL: control },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '', exited = false;
  child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  const closed = once(child, 'close').then(() => { exited = true; });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '', csrf = '';
  async function request(url, method = 'GET', body, raw = false) {
    const response = await fetch(base + url, { method, headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/gzip' : 'application/json' }),
    }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  }
  try {
    let ready = false;
    for (let i = 0; i < 100 && !exited; i++) {
      try { if ((await request('/api/auth/setup-status')).ok) { ready = true; break; } } catch (_) {}
      await delay(100);
    }
    assert.ok(ready, 'server failed to start: ' + log);
    if (control) {
      for (let i = 0; i < 40 && !exited && !fs.existsSync(control); i++) await delay(100);
      fs.writeFileSync(gate, '');
      assert.equal((await request('/api/auth/setup-status')).status, 503);
      assert.deepEqual(await updateProbe(control, { op: 'probe' }), {
        version: require('../package.json').version, paused: true, ready: true, idle: true,
      });
      fs.unlinkSync(gate);
      assert.equal((await request('/api/auth/setup-status')).status, 200);
    }
    const collision = spawnSync(process.execPath, ['-e', `require('./server/data-process').startDataProcess()`], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, MAIL_AGG_DATA_DIR: root }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(collision.status, 1);
    assert.match(collision.stderr, /已有 Web 服务或恢复进程/);
    assert.equal((await request('/api/system/diagnostics')).status, 401);
    assert.equal((await request('/api/system/app-update')).status, 401);
    assert.equal((await request('/api/notifications/history')).status, 401);
    assert.equal((await request('/api/accounts')).status, 401);
    assert.equal((await request('/api/mail/messages/7/export?folder=INBOX&uidValidity=77')).status, 401);
    assert.equal((await request('/api/mail/messages/7/attachments/2/download?folder=INBOX&uidValidity=77')).status, 401);
    assert.equal((await request('/api/mail/unread')).status, 401);
    assert.equal((await request('/api/mail/search', 'POST', { subject: 'fixture' })).status, 401);
    assert.equal((await request('/api/mail/messages/search', 'POST', { folder: 'INBOX' })).status, 401);
    assert.equal((await request('/api/mail/messages/flags', 'PUT', { flag: 'seen', value: true, messages: [] })).status, 401);
    assert.equal((await request('/api/mail/seen-jobs', 'POST', { folders: ['INBOX'] })).status, 401);
    assert.equal((await request('/api/mail/seen-jobs/active')).status, 401);
    assert.equal((await request('/api/mail/saved-searches')).status, 401);
    assert.equal((await request('/api/mail/rules')).status, 401);
    assert.equal((await request('/api/mail/tasks')).status, 401);
    let response = await request('/api/auth/setup', 'POST', { username: 'smoke-admin', password: 'fictional-smoke-password' });
    assert.equal(response.status, 200); csrf = (await response.json()).csrfToken;
    const update = '/api/system/app-update';
    const updateStatus = await (await request(update)).json();
    assert.equal(updateStatus.current, require('../package.json').version);
    assert.equal(updateStatus.installationAvailable, false);
    assert.equal(updateStatus.settings.channel, 'stable');
    const notificationHistory = await request('/api/notifications/history');
    assert.equal(notificationHistory.status, 200);
    assert.equal(notificationHistory.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await notificationHistory.json(), { events: [], nextBefore: null });
    const defaultSubscriptions = await (await request('/api/notifications/settings')).json();
    assert.deepEqual(defaultSubscriptions.subscriptions, { sync:true, capacity:false, restore:false, update:false });
    const savedSubscriptions = await request('/api/notifications/settings', 'PUT', { enabled:false, subscriptions: { sync:false, capacity:true, restore:true, update:true } });
    assert.equal(savedSubscriptions.status, 200);
    assert.deepEqual((await savedSubscriptions.json()).subscriptions, { sync:false, capacity:true, restore:true, update:true });
    const unconfigured = await (await request('/api/notifications/settings')).json();
    assert.equal(unconfigured.enabled, false);
    assert.equal(unconfigured.configured, false);
    assert.deepEqual(unconfigured.subscriptions, { sync:false, capacity:true, restore:true, update:true });
    const withoutUpdateCsrf = await fetch(base + `${update}/check`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(withoutUpdateCsrf.status, 403);
    const updatePolicy = { ...updateStatus.settings, mode: 'off', channel: 'preview' };
    assert.equal((await request(`${update}/settings`, 'PUT', { skipTag: null })).status, 401);
    assert.equal((await request(`${update}/settings`, 'PUT', { holdUntil: null })).status, 401);
    const { skipTag, holdUntil, ...standardPolicy } = updatePolicy;
    assert.equal(skipTag, null); assert.equal(holdUntil, null);
    const savedUpdate = await request(`${update}/settings`, 'PUT', standardPolicy);
    assert.equal(savedUpdate.status, 200);
    assert.deepEqual((await savedUpdate.json()).settings, updatePolicy);
    const password = 'fictional-smoke-password';
    assert.equal((await request(`${update}/settings`, 'PUT', { ...updatePolicy, mode: 'auto', currentPassword: 'not-the-current-password' })).status, 401);
    assert.equal((await request(`${update}/settings`, 'PUT', { ...updatePolicy, mode: 'auto', currentPassword: password })).status, 409);
    assert.equal((await request(`${update}/install`, 'POST', { tag: 'v0.1.7', currentPassword: password })).status, 409);
    const proxiedHttpInstall = await fetch(base + `${update}/install`, { method: 'POST', headers: {
      Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.42',
    }, body: JSON.stringify({ tag: 'v0.1.7', currentPassword: password }) });
    assert.equal(proxiedHttpInstall.status, 403);
    const noCsrf = await fetch(`${base}/api/mail/seen-jobs`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ folders: ['INBOX'] }) });
    assert.equal(noCsrf.status, 403);
    const searchNoCsrf = await fetch(`${base}/api/mail/search`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'fixture' }) });
    assert.equal(searchNoCsrf.status, 403);
    const localSearchNoCsrf = await fetch(`${base}/api/mail/messages/search`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: 'INBOX', body: 'fixture' }) });
    assert.equal(localSearchNoCsrf.status, 403);
    response = await request('/api/accounts', 'POST', {
      name: 'Smoke fixture', provider: 'custom', host: 'imap.example.org', port: 993, ssl: true,
      username: 'fixture@example.org', secret: 'fictional-source-secret', enabled: false,
      destination_mode: 'subfolder', destination_folder: 'Smoke',
    });
    assert.equal(response.status, 201, await response.clone().text()); const account = await response.json();
    assert.equal((await request('/api/mail/messages/7/export?folder=U999-A999.INBOX&uidValidity=77')).status, 404);
    assert.equal((await request('/api/mail/messages/search', 'POST', { folder: 'U999-A999.INBOX', body: 'fixture' })).status, 404);
    assert.equal((await request('/api/mail/messages/flags', 'PUT', { flag: 'seen', value: true,
      messages: [{ folder: 'U999-A999.INBOX', uidValidity: '77', uid: 7 }] })).status, 404);
    assert.equal((await request('/api/mail/seen-jobs', 'POST', { folders: ['U999-A999.INBOX'] })).status, 404);
    response = await request(`/api/accounts/${account.id}`, 'PUT', { ...account, destination_mode: 'flat' });
    assert.equal(response.status, 400);
    assert.equal((await request('/api/settings', 'PUT', { web_port: 9000 })).status, 409);
    const providerLimits = 'provider_concurrency_overrides';
    const savedLimits = async () => (await (await request('/api/settings')).json())[providerLimits];
    const settingsNoCsrf = await fetch(base + '/api/settings', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [providerLimits]: { qq: 1 } }), signal: AbortSignal.timeout(15000) });
    assert.equal(settingsNoCsrf.status, 403);
    const override = { qq: 1, outlook: 2 };
    assert.equal((await request('/api/settings', 'PUT', { max_concurrent_syncs: 3, max_concurrent_per_provider: 4, [providerLimits]: override })).status, 200);
    assert.deepEqual(await savedLimits(), override);
    const limitSettings = await (await request('/api/settings')).json();
    assert.ok(limitSettings.provider_concurrency_options.some(item => item.key === 'qq'));
    assert.ok(!limitSettings.provider_concurrency_options.some(item => item.key === 'custom'));
    for (const invalid of [{ qq: 0 }, { qq: 5 }, { qq: 1.5 }, { qq: true }, { custom: 2 }, { unknown_provider: 1 }, [], null]) {
      assert.equal((await request('/api/settings', 'PUT', { max_concurrent_syncs: 1, [providerLimits]: invalid })).status, 400);
    }
    assert.deepEqual(await savedLimits(), override);
    assert.equal((await (await request('/api/settings')).json()).max_concurrent_syncs, '3');
    assert.equal((await request('/api/settings', 'PUT', { [providerLimits]: { qq: '', outlook: '3' } })).status, 200);
    assert.deepEqual(await savedLimits(), { outlook: 3 });
    assert.equal((await request('/api/settings', 'PUT', { max_concurrent_syncs: 1, [providerLimits]: {} })).status, 200);
    assert.deepEqual(await savedLimits(), {});
    console.log('Provider limits: primary settings validated, replaced and cleared overrides; invalid requests made no change');
    response = await request('/api/mail/saved-searches', 'POST', { name: 'Starred fixture', scope: 'all', filters: { flagged: 'starred', subject: 'fixture' } });
    assert.equal(response.status, 201, await response.clone().text()); const savedSearch = await response.json();
    response = await request('/api/mail/rules', 'POST', { name: 'Rule fixture', scope: 'all', filters: { flagged: 'starred' }, action: 'unseen' });
    assert.equal(response.status, 201, await response.clone().text()); const savedRule = await response.json();
    response = await request('/api/system/backup', 'POST', { currentPassword: 'fictional-smoke-password' });
    assert.equal(response.status, 200, await response.clone().text());
    const archive = Buffer.from(await response.arrayBuffer());
    const livePrefs = { sync:false, capacity:true, restore:false, update:true };
    response = await request('/api/notifications/settings', 'PUT', { enabled:false, subscriptions:livePrefs });
    assert.equal(response.status, 200);
    assert.equal((await request(`/api/mail/saved-searches/${savedSearch.id}`, 'DELETE')).status, 200);
    assert.equal((await request(`/api/mail/rules/${savedRule.id}`, 'DELETE')).status, 200);
    response = await request('/api/system/restore/inspect', 'POST', archive, true);
    assert.equal(response.status, 200, await response.clone().text()); const inspection = await response.json();
    assert.equal(inspection.savedSearchCount, 1);
    assert.equal(inspection.ruleCount, 1);
    response = await request('/api/system/restore/apply', 'POST', { restoreId: inspection.restoreId,
      confirmation: 'RESTORE', currentPassword: 'fictional-smoke-password' });
    assert.equal(response.status, 200, await response.clone().text());
    const restoreResult = await response.json(); assert.equal(restoreResult.restored.savedSearches, 1); assert.equal(restoreResult.restored.savedSearchesSkipped, 0);
    assert.equal(restoreResult.restored.rules, 1); assert.equal(restoreResult.restored.rulesSkipped, 0);
    const currentPrefs = await (await request('/api/notifications/settings')).json();
    assert.equal(currentPrefs.enabled, false);
    assert.deepEqual(currentPrefs.subscriptions, livePrefs);
    const restoredRules = await request('/api/mail/rules').then(r => r.json()); assert.equal(restoredRules.rules[0].action, 'unseen');
    const restoredSearches = await request('/api/mail/saved-searches').then(r => r.json());
    assert.equal(restoredSearches.searches[0].name, 'Starred fixture'); assert.equal(restoredSearches.searches[0].filters.flagged, 'starred');
    const restored = await request('/api/accounts').then(r => r.json());
    assert.equal(restored.length, 1); assert.equal(restored[0].enabled, false);
    assert.equal(fs.existsSync(path.join(root, '.state-write.lock')), false);
    const diagnosticResponse = await request('/api/system/diagnostics');
    assert.equal(diagnosticResponse.status, 200, await diagnosticResponse.clone().text());
    assert.match(diagnosticResponse.headers.get('content-disposition'), /mail-aggregator-diagnostics\.json/);
    const diagnostic = await diagnosticResponse.json();
    assert.equal(diagnostic.restore.last.outcome, 'committed');
    assert.equal(diagnostic.queues.mailParser.capacity, 1);
    assert.ok(!JSON.stringify(diagnostic).includes('fictional-'));
    response = await request('/api/users', 'POST', { username: 'smoke-member', password: 'fictional-member-password', role: 'user' });
    assert.equal(response.status, 201, await response.clone().text());
    const memberLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke-member', password: 'fictional-member-password' }) });
    assert.equal(memberLogin.status, 200);
    const memberCookie = memberLogin.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/system/diagnostics`, { headers: { Cookie: memberCookie } })).status, 403);
    assert.equal((await fetch(`${base}${update}`, { headers: { Cookie: memberCookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/notifications/history`, { headers: { Cookie: memberCookie } })).status, 403);
    const ops = '/api/operations';
    assert.equal((await fetch(`${base}${ops}/overview`, { headers: { Cookie: memberCookie } })).status, 403);
    assert.equal((await fetch(`${base}${ops}/audit`, { headers: { Cookie: memberCookie } })).status, 403);
    assert.equal((await (await request(`${ops}/overview`)).json()).queue.queued, 0);
    assert.equal((await (await request(`${ops}/capacity?period=7d`)).json()).stepMs, 3600000);
    const beforeRole = await (await request(`${ops}/audit`)).json();
    assert.ok(beforeRole.events.some(item => item.event === 'backup' && item.outcome === 'success'));
    assert.ok(beforeRole.events.some(item => item.event === 'restore' && item.outcome === 'success'));
    assert.ok(!JSON.stringify(beforeRole).includes('fictional-'));
    async function signIn(username, password) {
      const result = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15000) });
      assert.equal(result.status, 200, await result.clone().text());
      return { Cookie: result.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await result.json()).csrfToken };
    }
    const admin = await request('/api/users', 'POST', { username:'smoke-delegated', password:'fictional-delegate-password', role:'admin' });
    assert.equal(admin.status, 201);
    const delegated = await signIn('smoke-delegated', 'fictional-delegate-password');
    assert.equal((await fetch(`${base}${ops}/overview`, { headers: delegated })).status, 403);
    assert.equal((await fetch(`${base}${ops}/audit`, { headers: delegated })).status, 403);
    const noCreateRole = await fetch(`${base}/api/users`, { method:'POST', headers: { ...delegated, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username:'new-operator', password:'fictional-operator-password', role:'operator' }) });
    assert.equal(noCreateRole.status, 403);
    const operatorResponse = await request('/api/users', 'POST', { username:'smoke-operator', password:'fictional-operator-password', role:'operator' });
    assert.equal(operatorResponse.status, 201);
    const operatorId = (await operatorResponse.json()).id;
    const operator = await signIn('smoke-operator', 'fictional-operator-password');
    const overview = await fetch(`${base}${ops}/overview`, { headers: operator });
    assert.equal(overview.status, 200);
    assert.equal(overview.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(await overview.json()).sort(), ['failures','health','queue','storageAvailable']);
    assert.equal((await fetch(`${base}${ops}/capacity`, { headers: operator })).status, 200);
    for (const target of ['/api/mail/messages', '/api/accounts', '/api/jobs', '/api/jobs/1/log', '/api/dashboard', '/api/health',
      '/api/system/diagnostics', '/api/users', '/api/settings', '/api/system/restore/snapshots', '/api/notifications/history', '/api/system/app-update', `${ops}/audit`]) {
      assert.equal((await fetch(base + target, { headers: operator })).status, 403, target);
    }
    for (const target of ['/api/sync/all', '/api/system/backup', '/api/system/restore/apply', '/api/system/app-update/install']) {
      assert.equal((await fetch(base + target, { method:'POST', headers: { ...operator, 'Content-Type': 'application/json' }, body:'{}' })).status, 403, target);
    }
    assert.equal((await fetch(`${base}/api/auth/devices`, { headers: operator })).status, 200);
    const redirected = await fetch(`${base}/mail.html`, { headers: operator, redirect:'manual' });
    assert.equal(redirected.headers.get('location'), '/operations.html');
    assert.equal((await fetch(`${base}/operations.html`, { headers: operator })).status, 200);
    const aboutOperator = await (await request(`${ops}/audit?subject=${operatorId}`)).json();
    assert.ok(aboutOperator.events.some(item => item.event === 'user_created' && item.outcome === 'success'));
    assert.equal((await request(`/api/users/${operatorId}`, 'PUT', { role:'user' })).status, 200);
    assert.equal((await fetch(`${base}${ops}/overview`, { headers: operator })).status, 401, 'changing role revokes the old session');
    const reassigned = await signIn('smoke-operator', 'fictional-operator-password');
    assert.equal((await fetch(`${base}${ops}/overview`, { headers: reassigned })).status, 403);
    const previousCookie = cookie;
    response = await request('/api/auth/change-password', 'POST', { currentPassword: 'fictional-smoke-password', newPassword: 'fictional-updated-password' });
    assert.equal(response.status, 200, await response.clone().text()); csrf = (await response.json()).csrfToken;
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: previousCookie } })).status, 401);
    assert.equal((await request('/api/auth/logout', 'POST')).status, 200);
    cookie = ''; csrf = '';
    assert.equal((await request('/api/auth/login', 'POST', { username: 'smoke-admin', password: 'fictional-smoke-password' })).status, 401);
    response = await request('/api/auth/login', 'POST', { username: 'smoke-admin', password: 'fictional-updated-password' });
    assert.equal(response.status, 200, await response.clone().text()); csrf = (await response.json()).csrfToken;
    assert.equal((await request('/api/auth/me')).status, 200);
    let finished = 0, responsiveChecks = 0, maxResponseMs = 0;
    const attempts = Array.from({ length: 4 }, () => fetch(`${base}/api/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'smoke-member', password: 'fictional-wrong-password' }),
      signal: AbortSignal.timeout(15000) }).finally(() => { finished++; }));
    const passwordResults = Promise.allSettled(attempts);
    await delay(50);
    while (finished < attempts.length) {
      const started = performance.now();
      assert.equal((await fetch(`${base}/api/auth/setup-status`)).status, 200);
      maxResponseMs = Math.max(maxResponseMs, performance.now() - started);
      if (finished < attempts.length) responsiveChecks++;
      await delay(20);
    }
    assert.ok(responsiveChecks > 0, 'other Web requests must complete while password computations are pending');
    const responses = (await passwordResults).map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    const statuses = responses.map(result => result.status);
    const throttled = responses.filter(result => result.status === 503);
    if (process.env.MAIL_TEST_ALLOW_PASSWORD_BACKPRESSURE === '1' && throttled.length) {
      // Software emulation can spend the whole 10-second budget waiting in the
      // queue. Validate fail-closed backpressure, without changing that budget.
      assert.ok(statuses.includes(401) && statuses.every(status => status === 401 || status === 503), JSON.stringify(statuses));
      for (const result of throttled) assert.equal((await result.json()).error, '密码验证服务繁忙或暂时不可用，请稍后重试');
      const retried = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'smoke-member', password: 'fictional-wrong-password' }), signal: AbortSignal.timeout(15000) });
      assert.equal(retried.status, 401, 'password worker must recover after queued requests time out');
      console.log(`PASS explicit password backpressure profile: concurrent results ${statuses.join('/')}, retry 401 after queue drained`);
    } else {
      assert.deepEqual(statuses, [401, 401, 401, 401]);
    }
    const revokedCookie = cookie;
    const pendingBackup = fetch(`${base}/api/system/backup`, { method: 'POST', headers: {
      Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ currentPassword: 'fictional-updated-password' }), signal: AbortSignal.timeout(15000) });
    await delay(50);
    assert.equal((await request('/api/auth/logout', 'POST')).status, 200);
    assert.equal((await pendingBackup).status, 401, 'logout must revoke password-guarded work still in progress');
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: revokedCookie } })).status, 401,
      'late password verification response must not recreate the destroyed session');
    console.log(`PASS native smoke: startup, isolation, saved-search/rule backup/restore, worker-based user creation/login/password change, revoked session, ${responsiveChecks} concurrent HTTP checks (max ${Math.round(maxResponseMs)} ms)`);
  } catch (error) {
    console.error(log);
    throw error;
  } finally {
    if (!exited) child.kill('SIGTERM');
    await closed;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
