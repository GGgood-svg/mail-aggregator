const fs = require('fs');
const path = require('path');
const { DIRS } = require('./db');

const LOCAL_SECRET_PATH = path.join(DIRS.secrets, 'local-target.pass');

function accountDir(accountId) {
  const dir = path.join(DIRS.secrets, String(accountId));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sourcePassPath(accountId) {
  return path.join(accountDir(accountId), 'source.pass');
}

function targetPassPath(accountId) {
  return path.join(accountDir(accountId), 'target.pass');
}

function oauthTokenPath(accountId) {
  return path.join(accountDir(accountId), 'oauth-token.json');
}

function oauthAccessTokenPath(accountId) {
  return path.join(accountDir(accountId), 'oauth-access.token');
}

// 写入密码文件,原子替换,不会出现空文件/半截内容/被截断的中间状态。
// 步骤: 写到同目录下的临时文件 -> chmod 600 -> fsync落盘 -> rename()覆盖目标。
// 临时文件和目标文件必须在同一个目录(同一个文件系统)下,rename()才能是
// 原子操作;如果分别在不同文件系统,rename会退化成非原子的复制+删除。
function writeSecret(filePath, secret) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);

  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeSync(fd, secret);
    fs.fsyncSync(fd); // 确保内容真正落盘,不是还停留在内核page cache里
  } finally {
    fs.closeSync(fd);
  }
  // openSync的mode参数会受umask影响,这里再显式chmod一次做双重确认
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath); // 同目录内的rename()是原子操作
}

function saveSourceSecret(accountId, secret) {
  writeSecret(sourcePassPath(accountId), secret);
}

function saveOAuthTokens(accountId, tokens) {
  if (!tokens || typeof tokens.accessToken !== 'string' || typeof tokens.refreshToken !== 'string') {
    throw new Error('OAuth2令牌数据不完整');
  }
  if (!tokens.accessToken || !tokens.refreshToken || /[\r\n\0]/.test(tokens.accessToken) || /[\r\n\0]/.test(tokens.refreshToken)) {
    throw new Error('OAuth2令牌格式不合法');
  }
  writeSecret(oauthTokenPath(accountId), `${JSON.stringify(tokens)}\n`);
  writeSecret(oauthAccessTokenPath(accountId), tokens.accessToken);
}

function readOAuthTokens(accountId) {
  const filePath = oauthTokenPath(accountId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    throw new Error('OAuth2令牌文件损坏，请重新授权');
  }
}

function hasOAuthTokens(accountId) {
  // oauth-access.token is derived from this JSON and the refresh command can
  // recreate it atomically, so only the durable refresh-token record is authoritative.
  return fs.existsSync(oauthTokenPath(accountId));
}

function deleteSourceSecret(accountId) {
  fs.rmSync(sourcePassPath(accountId), { force: true });
}

function deleteOAuthTokens(accountId) {
  fs.rmSync(oauthTokenPath(accountId), { force: true });
  fs.rmSync(oauthAccessTokenPath(accountId), { force: true });
}

// 保存该账号对应的本地Dovecot(target)密码。第一版所有账号共用同一个本地mailuser,
// 但每个账号目录下仍各自保留一份,便于未来支持多本地用户。
function saveTargetSecret(accountId, secret) {
  writeSecret(targetPassPath(accountId), secret);
}

function hasSourceSecret(accountId) {
  return fs.existsSync(sourcePassPath(accountId));
}

// 若账号自己没有单独的target密码,则回退使用全局本地密码
function resolveTargetPassPath(accountId) {
  const p = targetPassPath(accountId);
  if (fs.existsSync(p)) return p;
  return LOCAL_SECRET_PATH;
}

function saveGlobalLocalSecret(secret) {
  writeSecret(LOCAL_SECRET_PATH, secret);
}

function hasGlobalLocalSecret() {
  return fs.existsSync(LOCAL_SECRET_PATH);
}

// v0.1.3: Dovecot状态自检需要用当前保存的本地密码去实际登录验证一次。
// 这是本项目里唯一一处"读取"密码明文的地方,只在本地内存里短暂使用,
// 不会被记录到任何日志或者返回给前端。
function readGlobalLocalSecret() {
  if (!fs.existsSync(LOCAL_SECRET_PATH)) return null;
  return fs.readFileSync(LOCAL_SECRET_PATH, 'utf8').replace(/\r?\n$/, '');
}

function deleteAccountSecrets(accountId) {
  const dir = accountDir(accountId);
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  writeSecret,
  sourcePassPath,
  targetPassPath,
  oauthTokenPath,
  oauthAccessTokenPath,
  resolveTargetPassPath,
  saveSourceSecret,
  deleteSourceSecret,
  saveOAuthTokens,
  readOAuthTokens,
  hasOAuthTokens,
  deleteOAuthTokens,
  saveTargetSecret,
  saveGlobalLocalSecret,
  hasSourceSecret,
  hasGlobalLocalSecret,
  readGlobalLocalSecret,
  deleteAccountSecrets,
  LOCAL_SECRET_PATH,
};
