const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();

function withStateLock(root, work) {
  const filename = path.join(path.resolve(root), '.state-write.lock');
  const inherited = context.getStore();
  if (inherited?.filename === filename && inherited.active) return work();
  const token = { filename, active: true, id: crypto.randomBytes(16).toString('hex') };
  let fd;
  try { fd = fs.openSync(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Fail closed on incomplete files, another live process, or unknown state.
    // Stale lock removal is deliberately manual: PID reuse makes automatic
    // lock stealing unsafe during a long backup or OAuth exchange.
    throw Object.assign(new Error('配置正在备份、恢复或修改，请稍后再试；若服务异常退出，请按维护文档检查状态锁'), { statusCode: 409 });
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, id: token.id, createdAt: new Date().toISOString() })); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(filename); throw error; }
  fs.closeSync(fd);
  const release = () => {
    token.active = false;
    const owner = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (owner.id !== token.id) throw new Error('状态锁所有者发生变化');
    fs.unlinkSync(filename);
  };
  return context.run(token, () => {
    let result;
    try { result = work(); }
    catch (error) { release(); throw error; }
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release);
    release();
    return result;
  });
}

function stateRoute(handler) {
  return (req, res, next) => {
    try {
      const result = withStateLock(require('./db').DIRS.root, () => handler(req, res, next));
      if (result && typeof result.catch === 'function') result.catch(next);
    } catch (error) { next(error); }
  };
}
function stateWritesBlocked(root) {
  const filename = path.join(path.resolve(root), '.state-write.lock');
  const owner = context.getStore();
  return !(owner?.filename === filename && owner.active) && fs.existsSync(filename);
}
module.exports = { withStateLock, stateRoute, stateWritesBlocked };
