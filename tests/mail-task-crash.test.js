'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
function launch(filename, mode) {
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/mail-task-crash-worker.cjs'), filename, mode], { windowsHide: true, stdio: ['ignore','ignore','pipe','ipc'] });
  let stderr = '', taskId, settle;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const message = new Promise((resolve, reject) => {
    settle = resolve;
    child.on('message', item => { if (item.taskId) taskId = item.taskId; else if (item.error) reject(Error(item.error)); else resolve({ ...item, taskId }); });
    child.once('error', reject);
  });
  const closed = new Promise(resolve => child.once('close', code => { settle?.({ exited: true, code, stderr }); resolve(code); }));
  return { child, message, closed };
}
test('forced process exit preserves intent and confirmed counts across all three write windows', async t => {
  for (const window of ['before-command','after-command','before-checkpoint']) await t.test(window, { timeout: 10000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-task-crash-')), filename = path.join(root, 'state.db');
    let first, resumed;
    try {
      first = launch(filename, window); const paused = await first.message;
      assert.equal(paused.paused, window, JSON.stringify(paused)); assert.ok(paused.taskId);
      first.child.kill('SIGKILL'); await first.closed;
      const db = new DatabaseSync(filename);
      try { db.prepare('INSERT INTO fixture_messages(uid) VALUES(4)').run(); } finally { db.close(); }
      resumed = launch(filename, 'resume'); const data = await resumed.message;
      assert.equal(data.interrupted.status, 'interrupted', JSON.stringify(data)); assert.equal(data.interrupted.updated, 0); assert.equal(data.interrupted.uncertain, 3);
      assert.equal(data.result.id, paused.taskId); assert.equal(data.result.status, 'completed'); assert.equal(data.result.updated, 3); assert.equal(data.result.uncertain, 0);
      assert.equal(data.writes, 1); assert.equal(data.newArrivalSeen, 0); assert.equal(await resumed.closed, 0);
    } finally {
      if (first && first.child.exitCode === null) first.child.kill('SIGKILL');
      if (resumed && resumed.child.exitCode === null) resumed.child.kill('SIGKILL');
      await Promise.all([first?.closed, resumed?.closed]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('forced process exit during the second scan on one connection resumes from the committed preview block', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-preview-crash-')), filename = path.join(root, 'state.db');
  let first, resumed;
  try {
    first = launch(filename, 'preview-second-batch');
    const paused = await first.message;
    assert.equal(paused.paused, 'preview-second-batch', JSON.stringify(paused));
    assert.equal(paused.searches, 2); assert.ok(paused.taskId);
    first.child.kill('SIGKILL'); await first.closed;
    const db = new DatabaseSync(filename);
    try {
      const saved = db.prepare('SELECT scan_batches,matched_count,before_uid FROM mail_task_folders WHERE task_id=?').get(paused.taskId);
      assert.deepEqual({ ...saved }, { scan_batches: 1, matched_count: 200, before_uid: 251 });
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_task_uid_blocks WHERE task_id=?').get(paused.taskId).n, 1);
      db.prepare('INSERT INTO fixture_messages(uid) VALUES(451)').run();
    } finally { db.close(); }
    resumed = launch(filename, 'preview-resume');
    const data = await resumed.message;
    assert.equal(data.interrupted.status, 'interrupted', JSON.stringify(data));
    assert.equal(data.interrupted.matched, 200);
    assert.equal(data.result.id, paused.taskId); assert.equal(data.result.status, 'completed');
    assert.equal(data.result.matched, 450); assert.equal(data.writes, 0);
    assert.deepEqual(data.snapshot.map(block => block.position), [0, 200, 400]);
    assert.deepEqual(data.snapshot.flatMap(block => JSON.parse(block.uids_json)), Array.from({ length: 450 }, (_, i) => 450 - i));
    assert.equal(await resumed.closed, 0);
  } finally {
    if (first && first.child.exitCode === null) first.child.kill('SIGKILL');
    if (resumed && resumed.child.exitCode === null) resumed.child.kill('SIGKILL');
    await Promise.all([first?.closed, resumed?.closed]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
