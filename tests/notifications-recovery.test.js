const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture() {
  const events = new Map(), filename = path.join(__dirname, '../server/notifications.js');
  const realRequire = createRequire(filename);
  const db = { prepare(sql) {
    if (sql.startsWith('SELECT')) return { get(id) { const value = events.get(id); return value && { last_notified_at: value }; } };
    if (sql.startsWith('DELETE')) return { run(id, expected) { if (events.get(id) === expected) events.delete(id); } };
    throw new Error('Unexpected SQL');
  } };
  const context = { require: name => name === './db' ? { db, DIRS: { secrets: '/synthetic' } } : realRequire(name),
    module: { exports: {} }, console, process, Buffer, URL, Date };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { notify: context.module.exports.notifySyncRecovery, events, db };
}

test('recovery is sent only after an alerted failure, without erasing a newer alert', async () => {
  const f = fixture(), sent = [];
  const account = { id: 1, name: 'test' }, config = { enabled: true, provider: 'webhook', webhookUrl: 'https://example.invalid/hook' };
  await f.notify(account, 2, { store: f.db, config, send: async (...args) => sent.push(args) });
  assert.equal(sent.length, 0);
  f.events.set(1, 'first');
  await f.notify(account, 3, { store: f.db, config, send: async (...args) => { sent.push(args); f.events.set(1, 'newer'); } });
  assert.equal(sent[0][1].event, 'sync.recovered'); assert.equal(f.events.get(1), 'newer');
  await f.notify(account, 4, { store: f.db, config, send: async () => { throw Error('offline'); }, logger: { error() {} } });
  assert.equal(f.events.get(1), 'newer');
  await f.notify(account, 5, { store: f.db, config, send: async () => {} });
  assert.equal(f.events.has(1), false);
});
