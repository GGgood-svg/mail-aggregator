const { parseIntegerInRange } = require('./validation');

const DELETION_MODES = new Set(['archive', 'mirror_messages']);
const MAX_FOLDER_RULES = 100;
const MAX_FOLDER_LENGTH = 255;

function normalizeFolderRules(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const folder = String(item).normalize('NFKC').trim();
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    result.push(folder);
  }
  return result;
}

function validateFolderRules(value, label, errors) {
  const rules = normalizeFolderRules(value);
  if (rules.length > MAX_FOLDER_RULES) {
    errors.push(`${label}最多允许${MAX_FOLDER_RULES}条`);
  }
  if (rules.some((folder) => folder.length > MAX_FOLDER_LENGTH || /[\u0000-\u001f\u007f]/.test(folder))) {
    errors.push(`${label}中的单个文件夹名称不能超过${MAX_FOLDER_LENGTH}个字符或包含控制字符`);
  }
  return rules.slice(0, MAX_FOLDER_RULES);
}

function nullableInteger(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  return parseIntegerInRange(value, min, max);
}

function normalizeSyncPolicy(input, { defaultPolicy = {} } = {}) {
  const errors = [];
  const includesValue = input.folder_includes === undefined
    ? defaultPolicy.folder_includes
    : input.folder_includes;
  const excludesValue = input.folder_excludes === undefined
    ? defaultPolicy.folder_excludes
    : input.folder_excludes;
  const folderIncludes = validateFolderRules(includesValue, '包含文件夹', errors);
  const folderExcludes = validateFolderRules(excludesValue, '排除文件夹', errors);

  const maxAgeValue = input.max_age_days === undefined
    ? defaultPolicy.max_age_days
    : input.max_age_days;
  const maxAgeDays = nullableInteger(maxAgeValue, 1, 36500);
  if (maxAgeValue !== undefined && maxAgeValue !== null && maxAgeValue !== '' && maxAgeDays === null) {
    errors.push('最近邮件天数必须是1-36500之间的整数');
  }

  const maxSizeValue = input.max_size_mb === undefined
    ? defaultPolicy.max_size_mb
    : input.max_size_mb;
  const maxSizeMb = nullableInteger(maxSizeValue, 1, 10240);
  if (maxSizeValue !== undefined && maxSizeValue !== null && maxSizeValue !== '' && maxSizeMb === null) {
    errors.push('单封邮件上限必须是1-10240 MB之间的整数');
  }

  const deletionMode = input.deletion_mode || defaultPolicy.deletion_mode || 'archive';
  if (!DELETION_MODES.has(deletionMode)) errors.push('目标端删除策略无效');
  if (deletionMode === 'mirror_messages' && input.destination_mode !== 'subfolder') {
    errors.push('镜像删除只允许用于按账号文件夹隔离的账号');
  }
  if (deletionMode === 'mirror_messages' && (maxAgeDays !== null || maxSizeMb !== null)) {
    errors.push('镜像删除不能与时间或邮件大小限制同时启用');
  }

  return {
    errors,
    normalized: {
      folder_includes: folderIncludes.join('\n'),
      folder_excludes: folderExcludes.join('\n'),
      max_age_days: maxAgeDays,
      max_size_mb: maxSizeMb,
      deletion_mode: DELETION_MODES.has(deletionMode) ? deletionMode : 'archive',
    },
  };
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function applySyncPolicy(args, account, { justFolders = false } = {}) {
  for (const folder of normalizeFolderRules(account.folder_includes)) {
    args.push('--include', `^${escapeRegex(folder)}$`);
  }
  for (const folder of normalizeFolderRules(account.folder_excludes)) {
    args.push('--exclude', `^${escapeRegex(folder)}$`);
  }
  if (justFolders) return args;

  if (account.max_age_days !== null && account.max_age_days !== undefined) {
    args.push('--maxage', String(account.max_age_days));
  }
  if (account.max_size_mb !== null && account.max_size_mb !== undefined) {
    args.push('--maxsize', String(account.max_size_mb * 1024 * 1024));
  }
  if (account.deletion_mode === 'mirror_messages') {
    args.push('--delete2');
  }
  return args;
}

module.exports = {
  DELETION_MODES,
  normalizeFolderRules,
  normalizeSyncPolicy,
  applySyncPolicy,
};
