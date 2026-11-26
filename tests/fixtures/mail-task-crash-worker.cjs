'use strict';
// Disposable task database and a durable stand-in for remote IMAP flags.
const { DatabaseSync } = require('node:sqlite');
const { createMailTaskService } = require('../../server/mail-tasks');
const { newestUids, scanNewestUids } = require('../../server/mail-search-uids');
const { setTimeout: delay } = require('node:timers/promises');
const [filename, mode] = process.argv.slice(2);
const db = new DatabaseSync(filename); db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
db.transaction = fn => () => { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
db.exec(`CREATE TABLE IF NOT EXISTS admin_users(id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO admin_users VALUES(1);
  CREATE TABLE IF NOT EXISTS fixture_messages(uid INTEGER PRIMARY KEY,seen INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS fixture_remote(writes INTEGER); INSERT INTO fixture_remote SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM fixture_remote);`);
const preview = mode.startsWith('preview-'), resuming = mode === 'resume' || mode === 'preview-resume';
if (!resuming) db.transaction(() => {
  const insert = db.prepare('INSERT INTO fixture_messages(uid) VALUES(?)');
  for (let uid = 1; uid <= (preview ? 450 : 3); uid++) insert.run(uid);
})();
const keepAlive = setInterval(() => {}, 1000);
process.on('message', () => {});
let fetches = 0;
async function pause(details = {}) { process.send({ paused: mode, ...details }); await new Promise(() => {}); }
const context = { user: { id: 1 }, sessionID: resuming ? 'new-login-fixture' : 'old-login-fixture', session: { userId: 1 } };
const service = createMailTaskService({ db, newestUids, scanNewestUids, ...(preview ? { monotonicNow: () => 0 } : {}),
  authorize() {}, async listFolders() { return ['A']; },
  async withFolder(_, folder, readOnly, signal, work) {
    const check = () => { if (signal.aborted) throw signal.reason; };
    let searches = 0;
    const client = {
      async search(query) {
        if (mode === 'preview-second-batch' && ++searches === 2) await pause({ searches });
        const [low, high] = query.uid.split(':').map(Number);
        return db.prepare('SELECT uid FROM fixture_messages WHERE uid BETWEEN ? AND ? AND (? IS NULL OR seen=?)')
          .all(low, high, query.seen === undefined ? null : Number(query.seen), Number(query.seen || false)).map(row => row.uid);
      },
      async fetchAll(uids) {
        fetches++;
        const result = db.prepare('SELECT * FROM fixture_messages').all().filter(row => uids.includes(row.uid)).map(row => ({ uid: row.uid, flags: new Set(row.seen ? ['\\Seen'] : []) }));
        if (mode === 'before-command' && fetches === 1 || mode === 'before-checkpoint' && fetches === 2) await pause();
        return result;
      },
      async messageFlagsAdd(uids) {
        if (readOnly) throw Error('Unexpected read-only write');
        db.transaction(() => { for (const uid of uids) db.prepare('UPDATE fixture_messages SET seen=1 WHERE uid=?').run(uid); db.prepare('UPDATE fixture_remote SET writes=writes+1').run(); })();
        if (mode === 'after-command') await pause();
        return true;
      },
    };
    return work(client, { uidValidity: '77', uidNext: db.prepare('SELECT MAX(uid)+1 AS n FROM fixture_messages').get().n }, check);
  },
});
async function main() {
  if (!resuming) {
    let task;
    if (preview) {
      db.prepare("INSERT INTO mail_rules(owner_user_id,name,scope,folder,filters_json,action) VALUES(1,'Preview','folder','A','{}','seen')").run();
      task = service.createPreview(1, db.prepare('SELECT * FROM mail_rules').get(), context);
    } else task = service.createSeen(1, ['A'], context);
    process.send({ taskId: task.id });
    return;
  }
  const interrupted = service.list(1).items[0];
  const beforeWrites = db.prepare('SELECT writes FROM fixture_remote').get().writes;
  await delay(30);
  if (service.get(1, interrupted.id).status !== 'interrupted' || db.prepare('SELECT writes FROM fixture_remote').get().writes !== beforeWrites) throw Error('Authorization resumed automatically');
  await service.resume(1, interrupted.id, context);
  for (;;) {
    const result = service.get(1, interrupted.id);
    if (!['queued','running','cancelling'].includes(result.status)) {
      const writes = db.prepare('SELECT writes FROM fixture_remote').get().writes;
      if (preview) {
        const snapshot = db.prepare('SELECT position,uids_json FROM mail_task_uid_blocks WHERE task_id=? ORDER BY position').all(result.id);
        process.send({ interrupted, result, writes, snapshot });
      } else process.send({ interrupted, result, writes, newArrivalSeen: db.prepare('SELECT seen FROM fixture_messages WHERE uid=4').get().seen });
      break;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  await service.close(); db.close(); clearInterval(keepAlive); process.disconnect();
}
main().catch(error => { process.send?.({ error: error.message }); clearInterval(keepAlive); process.exitCode = 1; process.disconnect?.(); });
