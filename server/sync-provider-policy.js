'use strict';

const { integerSetting } = require('./resource-limits');
const providers = require('../config/providers.json');
const OVERRIDES_SETTING = 'provider_concurrency_overrides';
const builtinProviders = new Set(Object.keys(providers).filter(key => key !== 'custom'));

function providerLimitOptions() {
  return [...builtinProviders].map(key => ({ key, label: providers[key].label }));
}

// The supplied map replaces previous overrides. Missing or blank entries use the default.
function validateProviderLimitOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = {};
  for (const [key, limit] of Object.entries(value)) {
    if (!builtinProviders.has(key)) return null;
    if (limit === null || limit === '') continue;
    if (!(typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 4)
      && !(typeof limit === 'string' && /^[1-4]$/.test(limit))) return null;
    normalized[key] = Number(limit);
  }
  return normalized;
}

function decodeProviderLimitOverrides(raw) {
  try { return validateProviderLimitOverrides(JSON.parse(raw)) || {}; }
  catch { return {}; }
}

function providerGroup(account) {
  const provider = String(account.provider || 'custom').trim().toLowerCase();
  if (provider !== 'custom') return `provider:${provider}`;
  const host = String(account.host || '').trim().toLowerCase().replace(/\.$/, '');
  return `endpoint:${host}:${account.port}:${account.ssl ? 'tls' : 'plain'}`;
}

function readProviderCooldown(db, key, now = new Date().toISOString()) {
  return db.prepare('SELECT retry_at FROM sync_provider_cooldowns WHERE provider_key=? AND retry_at>?').get(key, now)?.retry_at ?? null;
}

function recordProviderCooldown(db, key, now) {
  const retryAt = new Date(Date.parse(now) + 5 * 60000).toISOString();
  db.prepare(`INSERT INTO sync_provider_cooldowns(provider_key,retry_at) VALUES(?,?)
    ON CONFLICT(provider_key) DO UPDATE SET retry_at=MAX(retry_at,excluded.retry_at)`).run(key, retryAt);
  // The table is normally tiny; expired active accounts no longer need a row.
  db.prepare('DELETE FROM sync_provider_cooldowns WHERE retry_at<=?').run(now);
  return retryAt;
}

function providerConcurrency(db, group) {
  if (group?.startsWith('provider:')) {
    const key = group.slice('provider:'.length);
    if (builtinProviders.has(key)) {
      const saved = db.prepare('SELECT value FROM settings WHERE key=?').get(OVERRIDES_SETTING)?.value;
      const override = decodeProviderLimitOverrides(saved)[key];
      if (override !== undefined) return override;
    }
  }
  return integerSetting(db, 'max_concurrent_per_provider', 4, 1, 4);
}

module.exports = { providerGroup, providerConcurrency, readProviderCooldown, recordProviderCooldown,
  OVERRIDES_SETTING, providerLimitOptions, validateProviderLimitOverrides, decodeProviderLimitOverrides };
