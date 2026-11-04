#!/usr/bin/env node
const { db, DIRS } = require('./db');
const { withStateLock } = require('./state-lock');
const { ensureAccountOAuthToken } = require('./oauth-refresh');

async function main() {
  const accountId = Number(process.argv[2]);
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw new Error('OAuth2账号ID无效');
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      await withStateLock(DIRS.root, () => {
        const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
        if (!account) throw new Error('OAuth2账号不存在');
        return ensureAccountOAuthToken(account);
      });
      break;
    } catch (error) {
      if (error.statusCode !== 409 || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    // Never print token responses or configuration. Only the sanitized message is
    // inherited by the imapsync job log when a refresh fails.
    console.error(`OAuth2刷新失败: ${String(error.message || '未知错误').replace(/[\r\n]/g, ' ').slice(0, 400)}`);
    process.exit(1);
  }
);
