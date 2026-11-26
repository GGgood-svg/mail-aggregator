'use strict';
const path = require('node:path');
const { discover, publicRelease, TARGET, UpdateError } = require('../scripts/updater/release');
const { DAY, RETRY, defaults, settings, patchSettings } = require('../scripts/updater/policy');
const { json, writeJson } = require('../scripts/updater/transaction');
const { call } = require('../scripts/updater/rpc');
const { historyPage } = require('../scripts/updater/history');

function appUpdate({ version, root, socket }) {
  const filename = path.join(root, 'app-update-check.json');
  let state = {}, loading, pending, timer, lastManualCheck = 0, writes = Promise.resolve();
  function load() { return loading ||= json(filename).then(value => { state = value || {}; }).catch(error => { loading = null; throw error; }); }
  const getSettings = () => settings(state.settings || defaults);
  function status() {
    const config = getSettings();
    return { current: version, settings: config, installationAvailable: false, checking: Boolean(pending), installing: false,
      candidate: state.channel === config.channel ? state.candidate || null : null,
      lastCheck: state.lastCheck || null, checkError: state.checkError || null,
      nextCheck: config.mode === 'off' ? null : Math.max(Date.now(), state.nextCheck || 0), nextAttempt: null, lastInstall: null, historyAvailable: false, trust: { state: 'check_only', fingerprint: null } };
  }
  function save(patch) {
    const write = writes.then(async () => {
      const next = { ...state, ...patch };
      await writeJson(filename, next);
      state = next;
    });
    writes = write.catch(() => {});
    return write;
  }
  function background() {
    if (pending || !TARGET.test(`v${version}`)) return;
    const { channel } = getSettings();
    pending = discover(version, channel).then(item => save({ channel, candidate: item ? { ...publicRelease(item), installable: false, reason: 'manual_platform', verification: 'not_verified' } : null,
      lastCheck: Date.now(), checkError: null, nextCheck: Date.now() + DAY }))
      .catch(e => save({ lastCheck: Date.now(), checkError: e instanceof UpdateError ? e.code : 'check_failed', nextCheck: Date.now() + RETRY }))
      .finally(() => { pending = null; });
    pending.catch(e => console.error('[app-update]', e.code || e.message));
  }
  async function request(op, data = {}) {
    if (socket) {
      try { return await call(socket, { op, ...data }); }
      catch (error) {
        if (error.code !== 'unknown_operation' || !['history','audit-history'].includes(op)) throw error;
        // During manual migration the previous host helper may still be running.
        const legacy = (await call(socket, { op: 'status' })).history;
        return op === 'history' ? historyPage(legacy, data.page, data.pageSize) : legacy;
      }
    }
    if (op === 'history') return historyPage([], data.page, data.pageSize);
    await load();
    if (op === 'check' && Date.now() - lastManualCheck >= 60000) { lastManualCheck = Date.now(); background(); }
    if (op === 'settings') {
      if (pending) throw new UpdateError('busy');
      const next = patchSettings(getSettings(), data.settings, status().candidate?.tag);
      if (next.mode === 'auto' || next.skipTag || next.holdUntil) throw new UpdateError('not_installable');
      await save({ settings: next, nextCheck: 0 });
      if (next.mode !== 'off') background();
    }
    if (op === 'install') throw new UpdateError('not_installable');
    return status();
  }
  function start() {
    if (socket || timer) return;
    const tick = () => load().then(() => { if (getSettings().mode !== 'off' && Date.now() >= (state.nextCheck || 0)) background(); })
      .catch(e => console.error('[app-update]', e.code || e.message));
    timer = setInterval(tick, 30000);
    timer.unref();
    // First automatic probe is a background tick; loading the settings is local-only.
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { request, start, stop };
}
module.exports = { appUpdate };
