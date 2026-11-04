// Real Express process + production better-sqlite3 + tar. No remote mailbox is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { once } = require('node:events');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-native-smoke-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '../server/app.js')], {
    env: { ...process.env, MAIL_AGG_DATA_DIR: root, PORT: String(port), MAIL_AGG_BIND_HOST: '127.0.0.1',
      MAIL_AGG_TRUST_PROXY: 'false', MAIL_AGG_COOKIE_SECURE: 'false', MAIL_AGG_REQUIRE_HTTPS: 'false' },
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
    assert.equal((await request('/api/accounts')).status, 401);
    assert.equal((await request('/api/mail/messages/7/export?folder=INBOX&uidValidity=77')).status, 401);
    assert.equal((await request('/api/mail/messages/7/attachments/2/download?folder=INBOX&uidValidity=77')).status, 401);
    let response = await request('/api/auth/setup', 'POST', { username: 'smoke-admin', password: 'fictional-smoke-password' });
    assert.equal(response.status, 200); csrf = (await response.json()).csrfToken;
    response = await request('/api/accounts', 'POST', {
      name: 'Smoke fixture', provider: 'custom', host: 'imap.example.org', port: 993, ssl: true,
      username: 'fixture@example.org', secret: 'fictional-source-secret', enabled: false,
      destination_mode: 'subfolder', destination_folder: 'Smoke',
    });
    assert.equal(response.status, 201, await response.clone().text()); const account = await response.json();
    assert.equal((await request('/api/mail/messages/7/export?folder=U999-A999.INBOX&uidValidity=77')).status, 404);
    response = await request(`/api/accounts/${account.id}`, 'PUT', { ...account, destination_mode: 'flat' });
    assert.equal(response.status, 400);
    assert.equal((await request('/api/settings', 'PUT', { web_port: 9000 })).status, 409);
    response = await request('/api/system/backup', 'POST', { currentPassword: 'fictional-smoke-password' });
    assert.equal(response.status, 200, await response.clone().text());
    const archive = Buffer.from(await response.arrayBuffer());
    response = await request('/api/system/restore/inspect', 'POST', archive, true);
    assert.equal(response.status, 200, await response.clone().text()); const inspection = await response.json();
    response = await request('/api/system/restore/apply', 'POST', { restoreId: inspection.restoreId,
      confirmation: 'RESTORE', currentPassword: 'fictional-smoke-password' });
    assert.equal(response.status, 200, await response.clone().text());
    const restored = await request('/api/accounts').then(r => r.json());
    assert.equal(restored.length, 1); assert.equal(restored[0].enabled, false);
    assert.equal(fs.existsSync(path.join(root, '.state-write.lock')), false);
    console.log('PASS native smoke: startup, auth, isolated account, port override, tar backup, inspect, restore, state-lock release');
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
