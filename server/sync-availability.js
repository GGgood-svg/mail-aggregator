'use strict';

const { parseSqliteUtc, scheduleDecision } = require('./scheduler-core');

const BLOCKS = Object.freeze({
  low_disk: ['low_space', 'system', 'free_storage', 60000],
  low_inodes: ['low_inodes', 'system', 'free_storage', 60000],
  disk_check_failed: ['capacity_unavailable', 'system', 'check_storage', 60000],
  disk_check_busy: ['capacity_busy', 'system', 'wait', 15000],
  missing_credentials: ['credential_missing', 'account', 'configure_credentials', null],
  authorization_required: ['authorization_required', 'account', 'reauthorize', null],
  queue_degraded: ['queue_degraded', 'system', 'check_queue', 15000],
  maintenance: ['maintenance', 'system', 'wait', 15000],
  provider_cooldown: ['provider_cooldown', 'provider', 'wait', 15000],
  provider_busy: ['provider_busy', 'provider', 'wait', 15000],
  confirm_unknown_result: ['confirm_unknown_result', 'account', 'review_previous_sync', null],
  account_paused: ['account_paused', 'account', 'resume_schedule', 15000],
});

function blockedOutcome(reason, now = Date.now(), retryAt = undefined, scopeOverride = undefined) {
  const details = BLOCKS[reason];
  if (!details) return { ok: false, reason, outcome: 'skipped' };
  const [code, scope, action, delay] = details;
  return { ok: false, reason, outcome: 'deferred', block: { code, scope: scopeOverride ?? scope, action },
    nextRetryAt: retryAt ?? (delay === null ? null : new Date(now + delay).toISOString()) };
}

function saveAccountBlock(db, accountId, outcome, now = new Date().toISOString()) {
  if (!outcome.block) return;
  db.prepare(`UPDATE accounts SET sync_block_since=CASE WHEN sync_block_code=? THEN COALESCE(sync_block_since,?) ELSE ? END,
    sync_block_code=?,sync_next_retry_at=?,sync_block_scope=? WHERE id=?`)
    .run(outcome.block.code, now, now, outcome.block.code, outcome.nextRetryAt, outcome.block.scope, accountId);
}

function deferQueuedSync(db, jobId, accountId, outcome) {
  if (!outcome.block || !outcome.nextRetryAt) throw new Error('Queued sync needs a bounded retry');
  return db.transaction(() => {
    const job = db.prepare(`UPDATE sync_jobs SET status='queued',stage='blocked',next_attempt_at=?,result_code=?
      WHERE id=? AND account_id=? AND status='running' AND transfer_started_at IS NULL`)
      .run(outcome.nextRetryAt, outcome.block.code, jobId, accountId);
    if (job.changes === 1) saveAccountBlock(db, accountId, outcome);
    return job.changes === 1;
  })();
}

function needsSyncReview(account) {
  return Boolean(account.sync_review_required || (account.sync_result_unknown && account.deletion_mode === 'mirror_messages'));
}

function describeAvailability(account, { running, queued, checking, activeJob, hasSecret, queue, cooldownUntil, now = Date.now() }) {
  const missing = !hasSecret ? blockedOutcome(account.auth_type === 'oauth2' ? 'authorization_required' : 'missing_credentials', now) : null;
  const pausedUntil = parseSqliteUtc(account.sync_paused_until);
  const paused = pausedUntil > now ? blockedOutcome('account_paused', now, new Date(pausedUntil).toISOString()) : null;
  const stored = Object.values(BLOCKS).find(([code]) => code === account.sync_block_code);
  const matchingStored = stored && !['credential_missing','authorization_required','queue_degraded','maintenance','account_paused'].includes(stored[0]);
  const currentCooldown = cooldownUntil ? blockedOutcome('provider_cooldown', now, cooldownUntil) : null;
  const durable = matchingStored && (stored[0] !== 'provider_cooldown' || currentCooldown)
    ? { block: { code: stored[0], scope: account.sync_block_scope === 'account' ? 'account' : stored[1], action: stored[2] },
      nextRetryAt: account.sync_next_retry_at } : null;
  const needsReview = needsSyncReview(account)
    ? blockedOutcome('confirm_unknown_result', now) : null;
  const queueBlock = queue?.degraded ? blockedOutcome('queue_degraded', now, queue.nextProbeAt) : null;
  const blocking = needsReview || missing || queueBlock || ((!activeJob || activeJob.trigger_source === 'scheduled') && paused) || currentCooldown || durable;
  const active = checking ? 'checking' : running ? 'running' : queued && !blocking ? 'queued' : null;
  const manualBlocked = queued && blocking;
  const state = active || (manualBlocked || (blocking && (account.enabled || needsReview || currentCooldown || durable)) ? 'blocked'
    : account.sync_result_unknown ? 'unknown' : !account.enabled ? 'disabled' : 'scheduled');
  const block = state === 'blocked' ? { ...blocking.block,
    since: queueBlock === blocking ? queue.since : durable === blocking ? account.sync_block_since : paused === blocking ? account.sync_pause_started_at : null } : null;
  const computed = scheduleDecision(account, now).dueAt;
  const nextScheduledAt = account.enabled ? new Date(computed || now).toISOString() : null;
  return { state, lastAttemptAt: account.last_sync_attempt_at ?? null, lastSuccessAt: account.last_sync_success_at ?? null,
    phase: checking ? 'checking' : activeJob?.stage || (queued ? 'queued' : null),
    lastFinishedJobId: account.last_finished_job_id ?? null, nextScheduledAt,
    nextRetryAt: state === 'blocked' ? activeJob?.next_attempt_at || blocking.nextRetryAt : null,
    block, pausedUntil: paused ? new Date(pausedUntil).toISOString() : null };
}

module.exports = { blockedOutcome, deferQueuedSync, describeAvailability, saveAccountBlock, needsSyncReview };
