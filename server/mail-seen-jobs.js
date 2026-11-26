const crypto = require('node:crypto');
const { mailError } = require('./mail-tools');

const MAX_ACTIVE = 4;
const MAX_RETAINED = 100;
const RETENTION_MS = 24 * 60 * 60 * 1000;

// Jobs are deliberately process-local. A restart ends them; confirmed counts
// are never represented as a completed job after an unexpected restart.
function createSeenJobManager({ runFolder, now = () => Date.now() }) {
  const jobs = new Map();

  function prune() {
    const cutoff = now() - RETENTION_MS;
    for (const [id, job] of jobs) if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
    while (jobs.size >= MAX_RETAINED) {
      const finished = [...jobs.values()].filter(job => job.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt)[0];
      if (!finished) break;
      jobs.delete(finished.id);
    }
  }

  function snapshot(job) {
    return { id: job.id, status: job.status, totalFolders: job.folders.length,
      processedFolders: job.results.length, updated: job.updated, currentFolder: job.currentFolder,
      results: job.results.map(result => ({ ...result })), createdAt: new Date(job.createdAt).toISOString(),
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null };
  }

  async function run(job) {
    job.status = 'running';
    try {
      for (const folder of job.folders) {
        job.currentFolder = folder;
        let updated = 0;
        try {
          const result = await runFolder(job.context, folder, count => { updated += count; job.updated += count; });
          job.results.push({ folder, ok: !!result.ok, updated, missing: Number(result.missing || 0),
            ...(result.ok ? {} : { error: '部分邮件未能确认，请刷新后重试' }) });
        } catch (error) {
          job.results.push({ folder, ok: false, updated, error: '处理未完成，请刷新后重试' });
          if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404) break;
        }
      }
      job.status = job.results.some(result => !result.ok) ? 'partial' : 'completed';
    } catch (_) {
      job.status = 'failed';
    } finally {
      job.currentFolder = null;
      job.finishedAt = now();
      delete job.context;
    }
  }

  function start(owner, folders, context) {
    prune();
    const active = [...jobs.values()].filter(job => !job.finishedAt);
    if (active.length >= MAX_ACTIVE || active.some(job => job.owner === owner)) {
      throw mailError('已有批量任务正在运行，请稍后重试', 429);
    }
    if (jobs.size >= MAX_RETAINED) throw mailError('批量任务过多，请稍后重试', 429);
    const job = { id: crypto.randomBytes(18).toString('hex'), owner, folders: [...folders], context,
      createdAt: now(), finishedAt: null, currentFolder: null, updated: 0, results: [], status: 'queued' };
    jobs.set(job.id, job);
    setImmediate(() => { run(job).catch(() => { job.status = 'failed'; job.finishedAt = now(); delete job.context; }); });
    return snapshot(job);
  }

  function get(owner, id) {
    prune();
    const job = jobs.get(id);
    return job && job.owner === owner ? snapshot(job) : null;
  }

  function getActive(owner) {
    prune();
    const job = [...jobs.values()].find(item => item.owner === owner && !item.finishedAt);
    return job ? snapshot(job) : null;
  }

  return { start, get, getActive, busy: () => [...jobs.values()].some(job => !job.finishedAt) };
}

module.exports = { createSeenJobManager, MAX_ACTIVE, MAX_RETAINED, RETENTION_MS };
