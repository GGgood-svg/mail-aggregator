'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createPublicKey, createHash, randomUUID } = require('node:crypto');
const { TARGET, ensure, UpdateError, discover, publicRelease, readManifest } = require('./release');
const policy = require('./policy');
const { writeJson, json, remove, historyEntry } = require('./transaction');
const { paths, exists, localSupport, maintenance, createHost } = require('./host');
const { listen } = require('./rpc');
const { historyPage, records, operationId } = require('./history');

const NETWORK = new Set(['github_timeout', 'github_rate_limit', 'github_unreachable', 'github_unavailable']);
const DEFERRED = new Set(['busy', 'maintenance_busy', 'outside_window', 'service_not_running', 'insufficient_capacity']);
const code = error => error instanceof UpdateError ? error.code : 'updater_error';

async function installed() {
  const result = await json(path.join(paths.installed, 'package.json'));
  ensure(result?.name === 'mail-aggregator' && TARGET.test(`v${result.version}`), 'unknown_current_version');
  return result.version;
}
async function trustedKey() {
  try {
    const meta = await fs.lstat(paths.key);
    ensure(meta.isFile() && meta.uid === 0 && !(meta.mode & 0o022) && meta.size <= 4096, 'invalid_local_key');
    const key = await fs.readFile(paths.key, 'utf8');
    ensure(/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(key.trim()), 'invalid_local_key');
    const parsed = createPublicKey(key);
    ensure(parsed.asymmetricKeyType === 'ed25519', 'invalid_local_key');
    const fingerprint = createHash('sha256').update(parsed.export({ type: 'spki', format: 'der' })).digest('hex');
    try {
      const marker = await fs.lstat(paths.enabled);
      ensure(marker.isFile() && marker.uid === 0 && !(marker.mode & 0o022), 'invalid_enable_marker');
      return { key, trust: { state: 'enabled', fingerprint } };
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('[updater] local activation:', code(error));
      return { key: null, trust: { state: 'pinned', fingerprint } };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[updater] local trust:', code(error));
    return { key: null, trust: { state: error.code === 'ENOENT' ? 'not_pinned' : 'invalid', fingerprint: null } };
  }
}

async function main() {
  ensure(process.getuid?.() === 0 && await localSupport(), 'unsupported_platform');
  process.umask(0o022);
  const statusFile = path.join(paths.state, 'status.json');
  const policyFile = path.join(paths.state, 'policy.json');
  const preparedFile = path.join(paths.state, 'prepared.json');
  let state = await json(statusFile) || {};
  let settings = policy.settings(await json(policyFile) || policy.defaults);
  let current, install, checking, changing, recoverRequired = false;
  let writes = Promise.resolve(), lastExplicitCheck = 0;
  const failed = (tag) => state.failures?.[tag];
  function save(patch) {
    const write = writes.then(async () => {
      const next = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      await writeJson(statusFile, next);
      state = next;
    });
    writes = write.catch(() => {});
    return write;
  }
  const blockedRelease = (tag, digest, reason) => ({ failures: { ...state.failures, [tag]: { digest, reason } } });
  const host = await createHost(async (outcome, record, { boot } = {}) => {
    const tag = `v${record.to}`;
    if (outcome === 'installed') current = record.to;
    if (outcome === 'deferred') {
      if (boot) await save(latest => ({ outcome, lastInstall: { tag, outcome, reason: 'interrupted', at: Date.now() },
        history: historyEntry(latest.history, record, outcome, { reason: 'interrupted' }) }));
      return;
    }
    await save(latest => ({ outcome, lastInstall: { tag, outcome, at: Date.now() }, pending: null, retryAt: null,
      history: outcome === 'rolled_back' && !boot && record.running
        ? historyEntry(historyEntry(latest.history, record, outcome), record, 'rollback_verified')
        : historyEntry(latest.history, record, outcome),
      ...(outcome === 'installed' && { current, candidate: null, candidateChannel: null, preparedVerification: null }),
      ...(outcome === 'rolled_back' && { ...blockedRelease(tag, record.digest, 'rolled_back'),
        ...(boot && record.running && { bootProbe: record.from, bootProbeRecord: record }) }),
    }));
  });
  const command = process.argv[2];
  if (await exists(paths.journal)) {
    let pending;
    try { await maintenance(async () => {
      pending = await json(paths.journal);
      if (pending) await host.tx.recover(pending, { boot: pending.bootId !== host.bootId && command !== '--retry-recovery', retry: command === '--retry-recovery' });
    }); } catch (error) {
      recoverRequired = true;
      const reason = code(error);
      if (pending && ['rollback_failed', 'finalization_failed'].includes(reason)) await save(latest => ({
        history: historyEntry(latest.history, pending, reason, { reason }) }));
      console.error('[updater] could not recover pending transaction:', reason);
    }
  }
  if (command === '--recover' || command === '--retry-recovery') {
    if (recoverRequired) process.exitCode = 1;
    return;
  }
  current = await installed().catch(() => null);
  if (current && state.current !== current) await save({ current, pending: null, candidate: null, candidateChannel: null, nextCheck: 0, retryAt: null });
  if (state.bootProbe) {
    // OpenRC starts Web after this unit. Observe the booted old service before
    // allowing another install or declaring recovery complete.
    const record = state.bootProbeRecord;
    host.confirmRunning(state.bootProbe).then(() => save(latest => ({ bootProbe: null, bootProbeRecord: null,
      history: historyEntry(latest.history, record, 'rollback_verified') }))).catch(async error => {
      recoverRequired = true;
      await save(latest => ({ outcome: 'rollback_failed', lastInstall: { ...state.lastInstall, outcome: 'rollback_failed', reason: code(error) },
        history: historyEntry(latest.history, record, 'rollback_failed', { reason: code(error) }) }));
    }).catch(error => console.error('[updater] boot verification:', code(error)));
  }
  const { key: publicKey, trust } = await trustedKey();
  if (state.preparedVerification && (!(await exists(paths.stage)) || !matchesPrepared(await json(preparedFile), state.preparedVerification))) {
    await save({ preparedVerification: null });
  }
  const available = () => Boolean(publicKey && current && !recoverRequired && !state.bootProbe);
  const candidateFor = () => state.candidateChannel === settings.channel ? state.candidate || null : null;
  function status() {
    const item = candidateFor();
    const blocked = item && failed(item.tag);
    const installationAvailable = available();
    const prepared = item?.verification === 'manifest_verified' && state.preparedVerification?.from === current
      && state.preparedVerification?.tag === item.tag && state.preparedVerification?.digest === item.digest;
    const candidate = item && { ...item, installable: item.installable && installationAvailable && !blocked,
      verification: !publicKey ? 'not_verified' : prepared ? 'package_verified' : item.verification || 'not_verified',
      reason: blocked ? 'failed_release' : !publicKey ? 'activation_required' : item.reason };
    const now = Date.now();
    const nextCheck = settings.mode === 'off' ? null : Math.max(now, state.nextCheck || 0);
    const retry = Math.max(now, state.retryAt || 0, state.checkError ? state.nextCheck || 0 : 0);
    const automatic = installationAvailable && candidate?.installable ? policy.autoStatus(settings, candidate.tag, now, retry) : { at: null, reason: null };
    const history = records(state.history);
    const newest = history[0];
    return { current, installationAvailable, settings, candidate, pending: state.pending?.tag || null,
      pendingOperationId: operationId(state.pending?.operationId),
      checking: Boolean(checking), installing: Boolean(install), lastCheck: state.lastCheck || null, checkError: state.checkError || null, nextCheck,
      outcome: recoverRequired ? 'rollback_failed' : state.bootProbe ? 'verifying_rollback' : state.outcome || null, lastInstall: state.lastInstall || null,
      historyAvailable: true, historyRevision: newest ? `${history.length}:${newest.operationId}:${newest.outcome}:${newest.at}` : '0',
      trust, autoPauseReason: automatic.reason,
      nextAttempt: installationAvailable && state.pending ? retry : automatic.at };
  }
  async function observe(manifest) {
    const previous = state.verified?.[manifest.tag];
    const fingerprint = [manifest.sha256, manifest.commit, manifest.nodeAbi, manifest.bytes, manifest.automatic, ...manifest.from].join(':');
    ensure(!previous || previous === fingerprint, 'release_changed');
    if (!previous) await save({ verified: { ...state.verified, [manifest.tag]: fingerprint } });
  }
  const compatible = manifest => manifest.automatic && manifest.from.includes(`v${current}`) && manifest.nodeAbi === +process.versions.modules;
  async function check(channel) {
    const options = { signal: AbortSignal.timeout(30000) };
    const latest = await discover(current, channel, options);
    const candidate = latest ? publicRelease(latest) : null;
    if (candidate) {
      candidate.installable = false;
      candidate.verification = 'not_verified';
      candidate.reason = 'activation_required';
      if (publicKey) {
        try {
          const manifest = await readManifest(latest, publicKey, options);
          await observe(manifest);
          candidate.installable = compatible(manifest);
          candidate.verification = 'manifest_verified';
          candidate.commit = manifest.commit;
          candidate.platform = manifest.platform;
          candidate.digest = manifest.sha256;
          candidate.reason = candidate.installable ? null : 'manual_upgrade';
        } catch (error) {
          if (NETWORK.has(code(error))) throw error;
          candidate.reason = code(error);
          candidate.verification = 'verification_failed';
        }
      }
    }
    const pendingChanged = state.pending && (state.pending.tag !== candidate?.tag || !candidate.installable);
    await save(latest => ({ candidate, candidateChannel: channel, lastCheck: Date.now(), checkError: null, nextCheck: Date.now() + policy.DAY,
      ...(pendingChanged && latest.pending && { pending: null, retryAt: null, outcome: 'failed',
        history: historyEntry(latest.history, { operationId: latest.pending.operationId, from: current, to: latest.pending.tag.slice(1),
          source: 'manual', startedAt: latest.pending.at }, 'failed', { reason: 'release_changed' }),
        lastInstall: { tag: latest.pending.tag, outcome: 'failed', reason: 'release_changed', at: Date.now() } }),
    }));
  }
  function checkInBackground() {
    if (checking || install || changing || !current) return;
    checking = check(settings.channel).catch(error => save({ checkError: code(error), lastCheck: Date.now(), nextCheck: Date.now() + policy.RETRY }))
      .finally(() => { checking = null; scheduleTick(); });
    checking.catch(error => console.error('[updater] status:', code(error)));
  }
  function installInBackground(tag, manual, cutover) {
    const channel = settings.channel;
    const record = { operationId: manual && state.pending?.operationId || randomUUID(), from: current, to: tag.slice(1),
      source: manual ? 'manual' : 'automatic', startedAt: Date.now() };
    let digest;
    install = maintenance(async () => {
      const valid = () => manual ? state.pending?.tag === tag : settings.channel === channel && policy.allowAutomatic(settings, tag, Date.now());
      ensure(!(await exists(paths.journal)) && !(await exists(paths.manualGate)) && await installed() === current, 'maintenance_busy');
      // Recheck the tag and signed manifest before download or cutover, even
      // when using an already prepared tree. A withdrawn release is not applied.
      const options = { signal: AbortSignal.timeout(30000) };
      const item = await discover(current, channel, options);
      ensure(item?.tag_name === tag, 'release_changed');
      const manifest = await readManifest(item, publicKey, options);
      digest = manifest.sha256;
      await observe(manifest);
      ensure(compatible(manifest), 'not_installable');
      const identity = { from: current, tag, digest };
      if (!matchesPrepared(await json(preparedFile), identity) || !(await exists(paths.stage))) {
        await save({ outcome: 'downloading', preparedVerification: null });
        await remove(preparedFile);
        await host.prepare(manifest);
        await writeJson(preparedFile, identity);
      }
      await save({ preparedVerification: identity });
      if (!cutover || !valid()) {
        await save({ outcome: 'prepared', retryAt: null });
        return;
      }
      ensure(await host.running(), 'service_not_running');
      await host.preflight(manifest);
      await save(latest => ({ outcome: 'installing', history: historyEntry(latest.history, record, 'installing') }));
      await host.tx.apply({ ...record, allowed: valid, digest, running: true });
      // Completion and gate release were already committed. Cleanup failure is
      // diagnostic only and must not change the recorded install result.
      await Promise.all([remove(preparedFile), remove(paths.snapshot)]).catch(error => console.error('[updater] cleanup:', code(error)));
    }).catch(async error => {
      const reason = code(error);
      if (['rollback_failed', 'finalization_failed'].includes(reason)) {
        recoverRequired = true;
        console.error('[updater] installation recovery:', error.cause?.message || reason);
      }
      const rolledBack = state.lastInstall?.tag === tag && state.lastInstall.outcome === 'rolled_back';
      const deferred = !rolledBack && (DEFERRED.has(reason) || NETWORK.has(reason));
      const outcome = recoverRequired ? 'rollback_failed' : rolledBack ? 'rolled_back' : deferred ? 'deferred' : 'failed';
      await save(latest => ({ outcome, retryAt: deferred ? Date.now() + policy.RETRY : null,
        lastInstall: { tag, reason, at: Date.now(), outcome }, history: historyEntry(latest.history, record, outcome, { reason }),
        ...(!deferred && { pending: null, ...blockedRelease(tag, digest, reason) }),
      }));
    }).finally(() => { install = null; });
    install.catch(error => console.error('[updater] installation state:', code(error)));
  }
  let nextTick;
  function scheduleTick() {
    if (nextTick) return;
    nextTick = setTimeout(() => { nextTick = null; tick().catch(error => console.error('[updater]', code(error))); }, 350);
    nextTick.unref();
  }
  function matchesPrepared(value, expected) {
    return value?.from === expected.from && value.tag === expected.tag && (expected.digest === undefined || expected.digest === value.digest);
  }
  async function tick() {
    if (!current || install || checking || changing || recoverRequired) return;
    const now = Date.now();
    if ((settings.mode !== 'off' || state.pending) && now >= (state.nextCheck || 0)) return checkInBackground();
    const candidate = candidateFor();
    if (!available() || state.checkError || !candidate?.installable || failed(candidate.tag) || now < (state.retryAt || 0)) return;
    if (state.pending?.tag === candidate.tag) return installInBackground(candidate.tag, true, true);
    if (settings.mode !== 'auto' || settings.skipTag === candidate.tag) return;
    if (policy.allowAutomatic(settings, candidate.tag, now)) return installInBackground(candidate.tag, false, true);
    const prepared = await json(preparedFile);
    if (!install && !checking && !changing && settings.mode === 'auto' && settings.skipTag !== candidate.tag && candidateFor()?.tag === candidate.tag
      && !matchesPrepared(prepared, { from: current, tag: candidate.tag })) installInBackground(candidate.tag, false, false);
  }

  try { if ((await fs.lstat(paths.socket)).isSocket()) await fs.unlink(paths.socket); else ensure(false, 'invalid_socket'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await listen(paths.socket, async request => {
    if (request?.op === 'status') return status();
    if (request?.op === 'history') return historyPage(state.history, request.page, request.pageSize);
    if (request?.op === 'audit-history') {
      if (await exists(paths.journal) || await exists(paths.manualGate)) return [];
      return records(state.history).filter(entry => ['installed','rollback_verified','failed','rollback_failed','finalization_failed'].includes(entry.outcome))
        .map(({ operationId, from, to, outcome, at }) => ({ operationId, from, to, outcome, at }));
    }
    if (request?.op === 'notification-history') {
      if (await exists(paths.journal) || await exists(paths.manualGate)) return [];
      // Share only stable, terminal update outcomes with the local subscriber.
      return (Array.isArray(state.history) ? state.history : []).slice(0, 60)
        .filter(entry => ['installed', 'rollback_verified', 'failed'].includes(entry.outcome))
        .map(({ operationId, from, to, outcome, at }) => ({ operationId, from, to, outcome, at }));
    }
    if (request?.op === 'check') {
      if (Date.now() - lastExplicitCheck > 60000 && !install && !checking && !changing) { lastExplicitCheck = Date.now(); checkInBackground(); }
      return status();
    }
    if (request?.op !== 'settings' && request?.op !== 'install') throw new UpdateError('unknown_operation');
    ensure(!changing && !install && !checking, 'busy');
    changing = true;
    try {
      if (request.op === 'settings') {
        const next = policy.patchSettings(settings, request.settings, candidateFor()?.tag);
        ensure(next.mode !== 'auto' || available(), 'not_installable');
        const channelChanged = next.channel !== settings.channel;
        await writeJson(policyFile, next);
        if (channelChanged || next.mode !== settings.mode) await save({ nextCheck: 0, retryAt: null, ...(channelChanged && { pending: null }) });
        settings = next;
      } else {
        const { tag } = request;
        ensure(typeof tag === 'string' && TARGET.test(tag), 'invalid_version');
        const candidate = status().candidate;
        ensure(available() && candidate?.tag === tag && candidate.installable, failed(tag) ? 'failed_release' : 'not_installable');
        ensure(!state.pending || state.pending.tag === tag, 'busy');
        if (!state.pending) {
          const startedAt = Date.now();
          const operationId = randomUUID();
          await save(latest => ({ pending: { tag, at: startedAt, operationId }, retryAt: null, outcome: 'queued', lastInstall: null,
            history: historyEntry(latest.history, { operationId, from: current, to: tag.slice(1), source: 'manual', startedAt }, 'queued') }));
        }
      }
      return status();
    } finally { changing = false; scheduleTick(); }
  });
  await fs.chown(paths.socket, 0, host.user.gid);
  await fs.chmod(paths.socket, 0o660);
  setInterval(scheduleTick, 30000).unref();
  scheduleTick();
}
if (require.main === module) main().catch(error => { console.error('[updater]', code(error), error.message); process.exitCode = 1; });
