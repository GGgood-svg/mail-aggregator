const fs = require('node:fs');
const { runBounded } = require('./bounded-process');
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MODES = new Set(['remove-app', 'purge']);
const STATES = new Set(['accepted', 'running', 'completed', 'busy', 'failed', 'interrupted']);
const unavailable = () => fault(503, '卸载执行器不可用，请使用主机上的安装器更新运维组件');
const fault = (statusCode, message) => Object.assign(new Error(message), { statusCode });

function createUninstallHost({
  helper = process.env.MAIL_AGG_UNINSTALL_HELPER_PATH || '/usr/local/sbin/mail-aggregator-uninstall-helper',
  run = runBounded,
  exists = fs.existsSync,
} = {}) {
  const available = () => exists(helper);
  async function request(action, value) {
    if (!available()) throw unavailable();
    if (action === 'commit') {
      try { await run('sudo', ['-n', helper, action, value], { timeout: 3000, maxBuffer: 1024 }); }
      catch (_) { throw unavailable(); }
      return;
    }
    let data;
    try {
      const { stdout } = await run('sudo', ['-n', helper, action, value], { timeout: 8000, maxBuffer: 4096 });
      data = JSON.parse(stdout);
    } catch (error) {
      if (action === 'status' && error.code === 44) throw fault(404, '未找到卸载回执');
      throw unavailable();
    }
    if (!ID.test(data?.id || '') || !MODES.has(data.mode) || !STATES.has(data.state) ||
      (action === 'queue' ? data.mode !== value : data.id !== value)) throw unavailable();
    const { id, mode, state, code, maildir, updatedAt } = data;
    return { id, mode, state, code, maildir, updatedAt };
  }
  return {
    available,
    async queue(mode) {
      if (!MODES.has(mode)) throw fault(400, '卸载模式无效');
      const result = await request('queue', mode);
      if (result.state === 'busy') throw Object.assign(fault(409, '维护或恢复正在进行，卸载未开始'), { operationId: result.id });
      if (!['accepted', 'running'].includes(result.state)) throw unavailable();
      return result;
    },
    commit(id) {
      if (!ID.test(id)) throw unavailable();
      return request('commit', id);
    },
    status(id) {
      if (!ID.test(id)) throw fault(404, '未找到卸载回执');
      return request('status', id);
    },
  };
}
module.exports = { createUninstallHost };
