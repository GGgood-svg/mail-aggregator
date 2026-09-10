const {
  parseIntegerInRange,
  normalizeHost,
  isValidHost,
  normalizeSystemUsername,
  isValidSystemUsername,
  isValidSecret,
} = require('./validation');
const {
  DESTINATION_MODES,
  normalizeDestinationFolder,
  isValidDestinationFolder,
} = require('./folder-strategy');
const { normalizeSyncPolicy } = require('./sync-policy');
const { isBlockedAddress, isLocalHostname } = require('./network-policy');

function validateAccountPayload(body, {
  requireSecret,
  getProvider,
  defaultLocalUser,
  defaultDestinationMode = 'flat',
  defaultDestinationFolder = null,
  defaultSyncPolicy = {},
}) {
  const input = body || {};
  const errors = [];
  const name = String(input.name || '').trim();
  const username = String(input.username || '').trim();
  const provider = String(input.provider || 'custom');

  if (!name) errors.push('名称必填');
  else if (name.length > 100) errors.push('名称不能超过100个字符');
  if (!username) errors.push('邮箱地址/用户名必填');
  else if (username.length > 320) errors.push('邮箱地址/用户名不能超过320个字符');

  let host = input.host;
  let port = input.port;
  let ssl = input.ssl;
  let authType = input.auth_type || 'password';

  const preset = getProvider(provider);
  if (!preset) {
    errors.push('未知的provider预设');
  } else if (provider !== 'custom') {
    // 预设的连接端点属于安全边界，不能让手工API请求借用“Gmail/QQ”等
    // provider 名称却把凭据发往攻击者指定的主机。
    host = preset.host;
    port = preset.port;
    ssl = preset.ssl;
    authType = preset.auth_type;
  }

  const rawHost = host;
  host = normalizeHost(host);
  if (typeof rawHost !== 'string' || !isValidHost(host)) errors.push('IMAP服务器地址格式不合法');
  const literalFamily = require('node:net').isIP(host);
  if (isLocalHostname(host) || (literalFamily && isBlockedAddress(host, literalFamily))) {
    errors.push('IMAP服务器不能指向本机、局域网或保留地址');
  }

  const normalizedPort = parseIntegerInRange(port === undefined ? 993 : port, 1, 65535);
  if (normalizedPort === null) errors.push('IMAP端口必须是1-65535之间的整数');

  if (ssl === undefined) ssl = true;
  if (typeof ssl !== 'boolean') errors.push('SSL设置必须是布尔值');
  else if (ssl !== true) errors.push('远程IMAP必须使用SSL/TLS，不能发送明文密码');

  if (!['password', 'oauth2'].includes(authType)) {
    errors.push('认证方式无效');
  } else if (provider !== 'custom' && preset && authType !== preset.auth_type) {
    errors.push('认证方式与Provider预设不匹配');
  } else if (authType === 'oauth2' && !['gmail', 'outlook'].includes(provider)) {
    errors.push('当前仅Gmail和Microsoft 365支持OAuth2');
  }

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    errors.push('启用状态必须是布尔值');
  }

  const intervalSource = input.sync_interval === undefined ? 600 : input.sync_interval;
  const syncInterval = parseIntegerInRange(intervalSource, 60, 604800);
  if (syncInterval === null) errors.push('同步间隔必须是60-604800秒之间的整数');

  const localUser = normalizeSystemUsername(input.local_user || defaultLocalUser);
  if (!isValidSystemUsername(localUser)) {
    errors.push('本地目标用户格式不合法，或属于受保护的系统账号');
  }

  const syncMode = input.sync_mode || 'full';
  if (syncMode !== 'full') errors.push('当前仅支持full同步模式');

  const destinationMode = input.destination_mode || defaultDestinationMode;
  if (!DESTINATION_MODES.has(destinationMode)) errors.push('目标文件夹策略无效');
  const destinationFolder = destinationMode === 'subfolder'
    ? normalizeDestinationFolder(
      input.destination_folder === undefined ? defaultDestinationFolder : input.destination_folder
    )
    : null;
  if (destinationMode === 'subfolder' && !isValidDestinationFolder(destinationFolder)) {
    errors.push('隔离文件夹名称必须为1-64个字母、数字、中文、空格、下划线或连字符，且必须以字母、数字或中文开头');
  }

  const policy = normalizeSyncPolicy(
    { ...input, destination_mode: destinationMode },
    { defaultPolicy: defaultSyncPolicy }
  );
  errors.push(...policy.errors);

  if (authType === 'password' && requireSecret && !isValidSecret(input.secret)) {
    errors.push('密码/授权码必填，长度不能超过4096且不能包含换行或NUL字符');
  } else if (authType === 'password' && input.secret !== undefined && input.secret !== '' && !isValidSecret(input.secret)) {
    errors.push('密码/授权码长度不能超过4096且不能包含换行或NUL字符');
  }
  if (input.local_secret !== undefined && input.local_secret !== '' && !isValidSecret(input.local_secret)) {
    errors.push('本地密码长度不能超过4096且不能包含换行或NUL字符');
  }

  return {
    errors,
    normalized: {
      name,
      provider,
      host,
      port: normalizedPort === null ? 993 : normalizedPort,
      ssl: ssl === false ? 0 : 1,
      username,
      auth_type: authType,
      enabled: input.enabled === false ? 0 : 1,
      sync_interval: syncInterval === null ? 600 : syncInterval,
      local_user: localUser,
      sync_mode: syncMode,
      destination_mode: DESTINATION_MODES.has(destinationMode) ? destinationMode : 'flat',
      destination_folder: destinationFolder,
      ...policy.normalized,
    },
  };
}

module.exports = { validateAccountPayload };
