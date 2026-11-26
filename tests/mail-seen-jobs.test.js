const test = require('node:test');
const assert = require('node:assert/strict');
const { createSeenJobManager } = require('../server/mail-seen-jobs');

test('background jobs expose confirmed progress, isolate owners and retain partial outcomes', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const manager = createSeenJobManager({ async runFolder(_, folder, progress) {
    if (folder === 'A') { progress(3); await gate; progress(2); return { ok: true }; }
    progress(1); throw new Error('connection lost after a partial update');
  } });
  const job = manager.start(1, ['A', 'B'], {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.get(1, job.id).updated, 3);
  assert.equal(manager.get(1, job.id).currentFolder, 'A');
  assert.equal(manager.get(2, job.id), null);
  assert.equal(manager.getActive(1).id, job.id); assert.equal(manager.getActive(2), null);
  assert.throws(() => manager.start(1, ['C'], {}), { statusCode: 429 });
  release();
  await new Promise(resolve => setImmediate(resolve));
  const result = manager.get(1, job.id);
  assert.equal(manager.getActive(1), null);
  assert.equal(result.status, 'partial'); assert.equal(result.updated, 6);
  assert.deepEqual(result.results.map(item => [item.folder, item.ok, item.updated]), [['A', true, 5], ['B', false, 1]]);
});

test('revoked authorization stops a background job before any remaining folders are visited', async () => {
  const visited = [];
  const manager = createSeenJobManager({ async runFolder(_, folder) { visited.push(folder); throw Object.assign(Error('revoked'), { statusCode: 401 }); } });
  const started = manager.start(7, ['A', 'B', 'C'], {}); await new Promise(setImmediate);
  const result = manager.get(7, started.id);
  assert.deepEqual(visited, ['A']); assert.equal(result.status, 'partial'); assert.equal(result.processedFolders, 1);
  assert.equal(manager.getActive(7), null);
});
