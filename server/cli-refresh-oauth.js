#!/usr/bin/env node
const { ensureAccountOAuthToken } = require('./oauth-refresh');

async function main() {
  const accountId = Number(process.argv[2]);
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw new Error('OAuth2账号ID无效');
  await ensureAccountOAuthToken({ id: accountId });
}

main().then(
  () => process.exit(0),
  (error) => {
    // Never print a provider response, stack, command arguments or credentials.
    console.error(`OAuth2刷新失败: ${error?.statusCode ? error.message : 'OAuth2配置或状态不可用'}`);
    process.exit(1);
  }
);
