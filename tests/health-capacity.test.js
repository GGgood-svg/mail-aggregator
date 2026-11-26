'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('health uses background probe priority and exposes actual storage, inode and busy/unknown states', async () => {
  const file = path.join(__dirname, '../server/health.js'), fallback = createRequire(file);
  for (const status of ['ok', 'low', 'busy', 'unavailable']) {
    const capacity = { ok: status === 'ok', status, minimumMb: 512, availableMb: ['ok', 'low'].includes(status) ? 700 : null,
      ...(['ok', 'low'].includes(status) ? { observations: [{ storage: '/actual-mail', availableMb: 700, availableInodes: status === 'low' ? 0 : 50 }] } : {}) };
    let priority, storageCalls = 0, authenticationCalls = 0, allowAuthentication, markStarted;
    const authentication = new Promise(resolve => { allowAuthentication = resolve; });
    const started = new Promise(resolve => { markStarted = resolve; });
    const dependencies = {
      './db': { DIRS: { root: '/actual-app', secrets: '/actual-app/secrets' }, db: { prepare: () => ({ get: () => ({ ok: 1 }), all: () => [] }) } },
      './config': { localDovecot: () => ({ host: '127.0.0.1', port: 143, user: 'fixture' }) },
      './system': { checkTcpPort: async () => true },
      './dovecot': { getDovecotStatus: async () => {
        authenticationCalls++;
        markStarted();
        await authentication;
        return { reachable: true, userExists: true, maildirExists: true };
      } },
      './credentials': { hasGlobalLocalSecret: () => false },
      './resource-limits': { syncDiskCapacity: async (_db, _dirs, _local, options) => { storageCalls++; priority = options.priority; return capacity; } },
      './diagnostics': { ...fallback('./diagnostics'), programVersion: async () => '2.4.5' },
    };
    const module = { exports: {} };
    vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports'], { filename: file })(key => dependencies[key] || fallback(key), module, module.exports);
    const health = module.exports.getHealthReport();
    try {
      await started;
      const runtime = await module.exports.getDiagnosticSnapshot();
      assert.equal(runtime.capacity, capacity, 'runtime diagnostics do not wait for IMAP authentication');
      assert.equal(authenticationCalls, 1);
    } finally { allowAuthentication(); }
    const report = await health, disk = report.checks.find(item => item.id === 'disk');
    assert.equal(storageCalls, 1, 'both diagnostic views share one capacity probe');
    assert.equal(priority, 0); assert.equal(disk.capacity, capacity); assert.equal(disk.ok, status === 'ok');
    assert.equal(disk.detail, undefined, 'busy probes must not be reported as stopped synchronization');
  }
});
