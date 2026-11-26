const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { db, DIRS } = require('./db');
const { createPublicLookup, isBlockedAddress, isLocalHostname } = require('./network-policy');
const outbox = require('./notification-outbox');
const maintenance = require('./maintenance-lock');
const { journalPresent } = require('./restore-journal');
const { call } = require('../scripts/updater/rpc');
const { createOperationNotifications, readUpdaterNotificationHistory } = require('./notification-operations');
const { subscriptions, operationEpochs, nextOperationEpochs, notificationConfigStore, webhookDedupEpoch, nextWebhookDeduplication } = require('./notification-config');

const root = DIRS.root || path.dirname(DIRS.secrets);
const configStore = notificationConfigStore(root, DIRS.secrets);
const operationFile = path.join(DIRS.db || path.join(root, 'db'), 'notification-operations.db');
const pendingDeliveries = new Map();
let worker, operationDb, operationNotifications, running = false;
const cooldown = value => Number.isFinite(Number(value)) ? Math.max(1, Math.min(1440, Math.trunc(Number(value)))) : 30;

function webhookUrl(input) {
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || input.length > 2048 || isLocalHostname(host)
    || (net.isIP(host) && isBlockedAddress(host))) throw new Error('Webhook 地址必须是无内嵌凭据的公共 HTTPS URL');
  return url.toString();
}

function destinationFor(config) {
  if (!config.enabled) return null;
  try {
    const provider = config.provider === 'telegram' ? 'telegram' : 'webhook';
    const token = String(config.telegramToken || '');
    const chatId = String(config.telegramChatId || '');
    if (provider === 'telegram' && (!/^\d{5,20}:[a-zA-Z0-9_-]{10,90}$/.test(token) || !chatId || chatId.length > 128)) return null;
    const url = provider === 'telegram' ? `https://api.telegram.org/bot${token}/sendMessage` : webhookUrl(String(config.webhookUrl || ''));
    const key = createHash('sha256').update(JSON.stringify([provider, url, provider === 'telegram' ? chatId : null])).digest('hex');
    return { provider, url, chatId, key, dedupEpoch: webhookDedupEpoch(config),
      cooldownMinutes: cooldown(config.cooldownMinutes ?? 30), subscriptions: subscriptions(config) };
  } catch (_) { return null; }
}

function destination() {
  const config = readConfig();
  const target = destinationFor(config);
  return target && { ...target, operationEpochs: config.operationTarget === target.key ? operationEpochs(config) : {} };
}

function queueDelivery(accountId, work) {
  const previous = pendingDeliveries.get(accountId) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  pendingDeliveries.set(accountId, next);
  const cleanup = () => { if (pendingDeliveries.get(accountId) === next) pendingDeliveries.delete(accountId); };
  next.then(cleanup, cleanup);
  return next;
}

function readConfig() { return configStore.read(); }
function publicConfig() {
  const config = readConfig();
  return { enabled: !!config.enabled, provider: config.provider || 'webhook', configured: !!(config.webhookUrl || (config.telegramToken && config.telegramChatId)),
    webhookSupportsDeduplication: config.provider !== 'telegram' && config.webhookSupportsDeduplication === true,
    cooldownMinutes: cooldown(config.cooldownMinutes ?? 30), subscriptions: subscriptions(config) };
}
function saveConfig(input) {
  const existing = readConfig();
  const provider = input.provider === 'telegram' ? 'telegram' : 'webhook';
  const config = {
    enabled: !!input.enabled, provider, cooldownMinutes: cooldown(input.cooldownMinutes ?? existing.cooldownMinutes ?? 30),
    subscriptions: subscriptions({ subscriptions: { ...subscriptions(existing), ...input.subscriptions } }),
    webhookUrl: String(input.webhookUrl || existing.webhookUrl || '').trim(),
    telegramToken: String(input.telegramToken || existing.telegramToken || '').trim(),
    telegramChatId: String(input.telegramChatId || existing.telegramChatId || '').trim(),
  };
  if (config.enabled && provider === 'webhook') {
    try { webhookUrl(config.webhookUrl); } catch (_) { throw new Error('Webhook 地址必须是无内嵌凭据的公共 HTTPS URL，且不超过 2048 个字符'); }
  } else if (config.enabled && (!/^\d{5,20}:[a-zA-Z0-9_-]{10,90}$/.test(config.telegramToken)
    || !config.telegramChatId || config.telegramChatId.length > 128)) {
    throw new Error('请填写有效的 Telegram Bot Token 和 Chat ID');
  }
  let sameEndpoint = false;
  if (provider === 'webhook' && existing.provider !== 'telegram') {
    try { sameEndpoint = webhookUrl(config.webhookUrl) === webhookUrl(existing.webhookUrl); } catch (_) {}
  }
  Object.assign(config, nextWebhookDeduplication(existing, config, input.webhookSupportsDeduplication, sameEndpoint));
  const target = destinationFor(config);
  config.operationTarget = target?.key || null;
  config.operationEpochs = nextOperationEpochs(existing, config, config.operationTarget);
  configStore.write(config);
  if (running) { worker?.wake(); startOperationDeliveries(); }
  return publicConfig();
}
function postJson(url, payload, eventId) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      lookup: createPublicLookup(undefined, '通知服务器'),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(eventId && { 'Idempotency-Key': eventId }) },
      timeout: 10000, signal: AbortSignal.timeout(10_000),
    }, (response) => {
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 300) return resolve();
      const header = response.headers?.['retry-after'];
      const delay = typeof header === 'string' && /^\d{1,9}$/.test(header) ? Number(header) * 1000
        : typeof header === 'string' && header.length < 65 ? Date.parse(header) - Date.now() : NaN;
      reject(Object.assign(new Error('通知发送失败'), { httpStatus: response.statusCode, retryAfterMs: delay }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout'))); request.on('error', reject); request.end(body);
  });
}
function notifySyncFailure(account, message, jobId) {
  return queueDelivery(account.id, async () => {
    const config = readConfig(); if (!config.enabled) return;
    const last = db.prepare('SELECT last_notified_at FROM notification_events WHERE account_id=?').get(account.id);
    const lastAt = last && Date.parse(String(last.last_notified_at).replace(' ', 'T') + 'Z');
    if (Number.isFinite(lastAt) && Date.now() - lastAt < Number(config.cooldownMinutes || 30) * 60000) return;
    const text = `Mail Aggregator 同步失败\n账号：${account.name}\n原因：${message}\n任务：${jobId}`;
    try {
      if (config.provider === 'telegram') await postJson(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, { chat_id: config.telegramChatId, text });
      else await postJson(config.webhookUrl, { event: 'sync.failed', account: { id: account.id, name: account.name }, jobId, message, occurredAt: new Date().toISOString() });
      db.prepare("INSERT INTO notification_events(account_id,last_notified_at) VALUES(?,datetime('now')) ON CONFLICT(account_id) DO UPDATE SET last_notified_at=excluded.last_notified_at").run(account.id);
    } catch (error) { console.error(`[notifications] 发送失败: ${error.message}`); }
  });
}

function notifySyncRecovery(account, jobId, { store = db, config, send = postJson, logger = console } = {}) {
  return queueDelivery(account.id, async () => {
    config = config || readConfig();
    const last = store.prepare('SELECT last_notified_at FROM notification_events WHERE account_id=?').get(account.id);
    if (!last) return;
    if (config.enabled) {
      const text = `Mail Aggregator 同步已恢复\n账号：${account.name}\n任务：${jobId}`;
      try {
        if (config.provider === 'telegram') await send(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, { chat_id: config.telegramChatId, text });
        else await send(config.webhookUrl, { event: 'sync.recovered', account: { id: account.id, name: account.name }, jobId, occurredAt: new Date().toISOString() });
      } catch (error) { logger.error(`[notifications] 恢复通知发送失败: ${error.message}`); return; }
    }
    // Do not erase a newer failure notification if a send finishes late.
    store.prepare('DELETE FROM notification_events WHERE account_id=? AND last_notified_at=?').run(account.id, last.last_notified_at);
  });
}
function deliver(target, event) {
  if (target.provider === 'webhook') return postJson(target.url, event, event.eventId);
  const labels = { 'sync.failed': '同步失败', 'sync.recovered': '同步已恢复', 'capacity.low': '容量不足', 'capacity.recovered': '容量已恢复',
    'restore.committed': '配置恢复完成', 'restore.rolled_back': '配置恢复已回退', 'update.installed': '应用更新已安装', 'update.rolled_back': '应用更新已回退', 'update.failed': '应用更新失败' };
  const subject = event.operation ? `操作编号：${event.operation.id}${event.operation.to ? `\n${event.operation.from} -> ${event.operation.to}` : ''}`
    : event.mount ? `存储卷：${event.mount.id}\n用途：${event.mount.uses.join(', ')}` : `账号编号：${event.account.id}\n任务：${event.jobId}`;
  const category = event.reasonCode ? `\n分类：${event.reasonCode}` : '';
  const text = `Mail Aggregator ${labels[event.event]}\n${subject}${category}\n事件：${event.eventId}`;
  return postJson(target.url, { chat_id: target.chatId, text });
}

function recordSyncNotificationIntent(store, input) {
  return outbox.recordSyncIntent(store, input, destination());
}

function canDeliver() {
  if (maintenance.current() !== null) return false;
  try {
    return !journalPresent(root) && ![process.env.MAIL_AGG_UPDATE_JOURNAL, process.env.MAIL_AGG_MANUAL_UPDATE_JOURNAL]
      .some(filename => filename && fs.existsSync(filename));
  } catch (_) { return false; }
}
const deliveryError = () => console.error('[notifications] 当前无法核实或保存投递状态');
function openOperationDb() {
  if (!operationDb) {
    const Database = require('better-sqlite3');
    const store = new Database(operationFile, { timeout: 250 });
    try {
      fs.chmodSync(operationFile, 0o600);
      store.pragma('journal_mode = WAL');
      outbox.migrateNotificationOutbox(store);
      operationDb = store;
    } catch (error) { store.close(); throw error; }
  }
  return operationDb;
}
function startOperationDeliveries() {
  if (!canDeliver()) return;
  try {
    const target = destination();
    if (!operationNotifications && !Object.keys(target?.operationEpochs || {}).length && !fs.existsSync(operationFile)) return;
    const socket = process.env.MAIL_AGG_UPDATE_SOCKET;
    operationNotifications ||= createOperationNotifications({ db:openOperationDb(), applicationDb:db, destination, deliver, canDeliver,
      readUpdates: socket ? () => readUpdaterNotificationHistory(socket, call) : null, onError:deliveryError });
    operationNotifications.start();
    operationNotifications.wake();
  } catch (_) { deliveryError(); }
}
function startDeliveries() {
  if (!canDeliver()) return;
  running = true;
  try { configStore.initialize(); } catch (_) { deliveryError(); }
  worker ||= outbox.createDeliveryWorker(db, { destination, deliver, canDeliver, onError:deliveryError });
  worker.start();
  startOperationDeliveries();
}
function stopDeliveries() { running = false; worker?.stop(); operationNotifications?.stop(); }
function notificationDeliveryBusy() { return Boolean(worker?.isActive() || operationNotifications?.busy()); }
function drainDeliveries() { return Promise.all([worker?.drain(), operationNotifications?.drain()]); }
function recordCapacityObservations(store, capacity, now) {
  return outbox.recordCapacityObservations(store, capacity, now, destination());
}
function wakeSyncNotificationDelivery() { worker?.wake(); }
function deliveryHistory(options) {
  const stores = [db];
  if (operationDb || fs.existsSync(operationFile)) stores.push(openOperationDb());
  return outbox.mergedDeliveryHistory(stores, options);
}

module.exports = { publicConfig, saveConfig, notifySyncFailure, notifySyncRecovery,
  recordSyncNotificationIntent, wakeSyncNotificationDelivery, startDeliveries, stopDeliveries, deliveryHistory,
  notificationDeliveryBusy, drainDeliveries,
  recordCapacityObservations, suppressNotificationDeliveries: outbox.suppressNotificationDeliveries };
