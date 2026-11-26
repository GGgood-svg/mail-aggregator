'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { ensure, UpdateError, TARGET } = require('./release');

async function flushDirectory(dir) { const handle = await fs.open(dir, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function writeJson(filename, value) {
  const tmp = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, 'wx', 0o640);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, filename);
    if (process.platform !== 'win32') await flushDirectory(path.dirname(filename));
  } finally { await fs.rm(tmp, { force: true }); }
}
async function json(filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function remove(filename) {
  await fs.rm(filename, { force: true });
  if (process.platform !== 'win32') await flushDirectory(path.dirname(filename));
}

// The journal IS the application gate: it is published before admission is
// checked and removed only after either version has been proven usable.
function transaction(ops) {
  const phases = new Set(['draining', 'stopping', 'switching', 'testing', 'committed']);
  async function recover(record, { boot = false, retry = false } = {}) {
    ensure(record && phases.has(record.phase) && typeof record.from === 'string' && typeof record.to === 'string'
      && typeof record.running === 'boolean', 'invalid_update_journal');
    ensure(!record.recoveryFailed || retry, 'rollback_failed');
    try { return await settle(record, boot); }
    catch (cause) {
      // A committed tree must never be restored from its old snapshot, even
      // when writing the ancillary status file fails.
      if (record.phase === 'committed') throw new UpdateError('finalization_failed');
      await ops.publish({ ...record, recoveryFailed: true }).catch(() => {});
      throw Object.assign(new UpdateError('rollback_failed'), { cause });
    }
  }
  async function settle(record, boot) {
    if (record.phase === 'committed') {
      await ops.record('installed', record);
      await ops.clear();
      return 'installed';
    }
    if (record.phase === 'draining') {
      await ops.record('deferred', record, { boot });
      await ops.clear();
      return 'deferred';
    }
    if (record.phase === 'switching' || record.phase === 'testing') {
      await ops.stop({ boot });
      await ops.restore(record);
    }
    // At boot OpenRC starts the app after this recovery unit completes. During
    // live recovery prove the original service is usable before lifting the gate.
    if (record.running && !boot) await ops.startAndProbe(record.from);
    await ops.record('rolled_back', record, { boot });
    await ops.clear();
    return 'rolled_back';
  }
  async function apply({ from, to, running = true, digest, allowed, operationId, source, startedAt }) {
    let record = { from, to, running, digest, phase: 'draining', operationId, source, startedAt };
    await ops.publish(record);
    try {
      if (running && !(await ops.idle(from))) throw new UpdateError('busy');
      if (allowed && !allowed()) throw new UpdateError('outside_window');
      record = { ...record, phase: 'stopping' };
      await ops.publish(record);
      await ops.stop();
      await ops.snapshot();
      record = { ...record, phase: 'switching' };
      await ops.publish(record);
      await ops.swap();
      record = { ...record, phase: 'testing' };
      await ops.publish(record);
      await ops.startAndProbe(to);
      record = { ...record, phase: 'committed' };
      await ops.publish(record);
      return await recover(record);
    } catch (error) {
      const persisted = await ops.read();
      if (!persisted) throw error;
      await recover(persisted);
      if (persisted.phase === 'committed') return 'installed';
      throw error;
    }
  }
  return { apply, recover };
}
// Keep bounded, idempotent operator history independent from the app database.
function historyEntry(history, record, outcome, { reason, now = Date.now() } = {}) {
  const entries = Array.isArray(history) ? history.slice(0, 60) : [];
  if (!record || !TARGET.test(`v${record.from}`) || !TARGET.test(`v${record.to}`)) return entries;
  const id = typeof record.operationId === 'string' && /^[0-9a-f-]{36}$/.test(record.operationId) ? record.operationId
    : createHash('sha256').update(JSON.stringify([record.from, record.to, record.bootId || null, record.digest || null])).digest('hex').slice(0, 32);
  const source = ['manual','automatic'].includes(record.source) ? record.source : 'unknown';
  const existing = entries.find(entry => entry.operationId === id && entry.outcome === outcome);
  if (existing) return entries.map(entry => entry === existing && reason ? { ...entry, reason } : entry);
  return [{ operationId: id, from: record.from, to: record.to, outcome, source, reason: reason || null,
    at: now, startedAt: Number.isSafeInteger(record.startedAt) ? record.startedAt : null }, ...entries].slice(0, 60);
}
module.exports = { writeJson, json, remove, flushDirectory, transaction, historyEntry };
