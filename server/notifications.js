const fs = require('fs');
const path = require('path');
const https = require('https');
const { db, DIRS } = require('./db');

const CONFIG_PATH = path.join(DIRS.secrets, 'notification.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return {}; }
}
function publicConfig() {
  const config = readConfig();
  return { enabled: !!config.enabled, provider: config.provider || 'webhook', configured: !!(config.webhookUrl || (config.telegramToken && config.telegramChatId)), cooldownMinutes: Number(config.cooldownMinutes || 30) };
}
function saveConfig(input) {
  const existing = readConfig();
  const provider = input.provider === 'telegram' ? 'telegram' : 'webhook';
  const config = {
    enabled: !!input.enabled, provider, cooldownMinutes: Math.max(1, Math.min(1440, Number(input.cooldownMinutes || 30))),
    webhookUrl: String(input.webhookUrl || existing.webhookUrl || '').trim(),
    telegramToken: String(input.telegramToken || existing.telegramToken || '').trim(),
    telegramChatId: String(input.telegramChatId || existing.telegramChatId || '').trim(),
  };
  if (config.enabled && !(provider === 'webhook' ? /^https:\/\//.test(config.webhookUrl) : (config.telegramToken && config.telegramChatId))) {
    throw new Error(provider === 'webhook' ? 'Webhook 地址必须是 HTTPS URL' : 'Telegram Bot Token 和 Chat ID 均为必填');
  }
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config), { mode: 0o600 }); fs.chmodSync(temp, 0o600); fs.renameSync(temp, CONFIG_PATH);
  return publicConfig();
}
function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(payload)) }, timeout: 10000 }, (response) => {
      response.resume(); response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`));
    });
    request.on('timeout', () => request.destroy(new Error('timeout'))); request.on('error', reject); request.end(JSON.stringify(payload));
  });
}
async function notifySyncFailure(account, message, jobId) {
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
}
module.exports = { publicConfig, saveConfig, notifySyncFailure };
