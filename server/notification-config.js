'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const OPERATION_SOURCES = ['restore', 'update'];
const NOTIFICATION_CONFIG_NAME = 'notification.json';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function subscriptions(config) {
  return { sync: config?.subscriptions?.sync !== false, capacity: config?.subscriptions?.capacity === true,
    restore: config?.subscriptions?.restore === true, update: config?.subscriptions?.update === true };
}
function operationEpochs(config) {
  return Object.fromEntries(OPERATION_SOURCES.flatMap(source => {
    const epoch = config?.operationEpochs?.[source];
    return subscriptions(config)[source] && UUID.test(epoch?.id) && Number.isSafeInteger(epoch.since) && epoch.since >= 0 && epoch.since <= 8.64e15
      ? [[source, { id: epoch.id, since: epoch.since }]] : [];
  }));
}
function nextOperationEpochs(previous, next, targetKey, now = Date.now()) {
  if (!next.enabled || !targetKey) return {};
  const changed = !previous.enabled || previous.operationTarget !== targetKey;
  const epochs = operationEpochs(previous);
  return Object.fromEntries(OPERATION_SOURCES.filter(source => subscriptions(next)[source])
    .map(source => [source, !changed && epochs[source] || { id: randomUUID(), since: now }]));
}
function webhookDedupEpoch(config) {
  return config?.enabled && config.provider !== 'telegram' && config.webhookSupportsDeduplication === true &&
    typeof config.webhookDedupEpoch === 'string' && UUID.test(config.webhookDedupEpoch) ? config.webhookDedupEpoch : null;
}
function nextWebhookDeduplication(previous, next, confirmation, sameEndpoint) {
  const webhookSupportsDeduplication = next.provider === 'webhook' && (confirmation === undefined
    ? sameEndpoint && previous.webhookSupportsDeduplication === true : confirmation === true);
  // A new opt-in is a new epoch. Old ambiguous deliveries are never made safe
  // retroactively, even when a capability is disabled and enabled between polls.
  return { webhookSupportsDeduplication, webhookDedupEpoch: next.enabled && webhookSupportsDeduplication
    ? (sameEndpoint && webhookDedupEpoch(previous)) || randomUUID() : null };
}
function notificationConfigStore(root, secrets) {
  const filename = path.join(root, NOTIFICATION_CONFIG_NAME);
  const legacy = path.join(secrets, NOTIFICATION_CONFIG_NAME);
  function readFile(file) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 16_384) return {};
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (error) { return error.code === 'ENOENT' ? null : {}; }
  }
  function write(config) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(config)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, filename);
      if (process.platform !== 'win32') {
        const parent = fs.openSync(root, 'r');
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      }
    } finally { fs.rmSync(temporary, { force:true }); }
  }
  function initialize({ onlyIfLegacy = false } = {}) {
    if (readFile(filename) !== null) return;
    const previous = readFile(legacy);
    if (onlyIfLegacy && previous === null) return;
    // Migrate the live destination before a restore swaps out secrets. The
    // newer event types require explicit opt-in even on a migrated host.
    write({ ...previous, subscriptions: { ...subscriptions(previous), restore: false, update: false },
      operationEpochs: {}, operationTarget: null, webhookSupportsDeduplication: false, webhookDedupEpoch: null });
  }
  return { read: () => readFile(filename) || {}, write, initialize };
}
module.exports = { subscriptions, operationEpochs, nextOperationEpochs, notificationConfigStore, webhookDedupEpoch, nextWebhookDeduplication, UUID, NOTIFICATION_CONFIG_NAME };
