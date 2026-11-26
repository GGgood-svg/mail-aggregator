'use strict';

// Synthetic local comparison only: no accounts, secrets, network or Maildir.
const { performance } = require('node:perf_hooks');
const { execFile, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const bcrypt = require('bcryptjs');
const { PasswordPool } = require('../server/password-hasher');
const { createCapacityChecker } = require('../server/resource-limits');

const hash = '$2a$12$gZSyu4KDMYsuziMP/Fyqu.o3b82jWsYs7hZjMD3f8O1KXckvzqjji';
const password = 'fictional-benchmark-password';

async function measure(name, work) {
  let last = performance.now(), maxGap = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 10);
  await delay(30);
  const start = performance.now();
  try { await work(); await delay(30); }
  finally { clearInterval(timer); }
  return { name, elapsedMs: Math.round(performance.now() - start - 30), maxTimerGapMs: Math.round(maxGap) };
}

function asyncChild() {
  return new Promise((resolve, reject) => execFile(process.execPath, ['-e', 'setTimeout(()=>{},100)'], { timeout: 5000 }, error => error ? reject(error) : resolve()));
}

async function main() {
  const pool = new PasswordPool();
  const results = [];
  let helperStarts = 0;
  const checker = createCapacityChecker({ statfs: async () => ({ bavail: 2048, bsize: 1024 * 1024 }), env: {},
    run: async () => { helperStarts++; await asyncChild(); return { stdout: '1048576 100\n' }; } });
  const db = { prepare: () => ({ get: () => ({ value: '512' }) }) };
  try {
    results.push(await measure('bcrypt-sync-4', () => { for (let i = 0; i < 4; i++) bcrypt.compareSync(password, hash); }));
    results.push(await measure('bcrypt-async-4', () => Promise.all(Array.from({ length: 4 }, () => bcrypt.compare(password, hash)))));
    results.push(await measure('bcrypt-production-pool-4', () => Promise.all(Array.from({ length: 4 }, () => pool.compare(password, hash)))));
    results.push(await measure('helper-sync-3', () => { for (let i = 0; i < 3; i++) { const result = spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)'], { timeout: 5000 }); if (result.status !== 0) throw result.error || new Error('helper failed'); } }));
    results.push(await measure('capacity-production-checker-3', () => Promise.all(Array.from({ length: 3 }, () => checker(db,
      { root: '/synthetic-data' }, { host: '127.0.0.1', user: 'synthetic-user', port: 143 })))));
    console.log(JSON.stringify({ node: process.version, workerCount: pool.size, capacityHelperStarts: helperStarts,
      note: 'Production worker pool and capacity checker with fictional inputs. Timings vary by host; no real mailbox is accessed.', results }, null, 2));
  } finally { await pool.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
