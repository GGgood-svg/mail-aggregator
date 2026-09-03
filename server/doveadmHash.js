// 独立的doveadm密码哈希生成模块。
//
// 故意不依赖 ./db 或其它任何会触发SQLite初始化/迁移的模块,这样它既能被
// server/dovecot.js(Web修改密码路径)引用,也能被 server/cli-dovecot-hash.js
// (install.sh --full 安装路径)作为一个独立的命令行工具调用,两条路径调用的
// 是完全同一个函数,不是shell里维护一份、Node里维护另一份平行逻辑。
//
// 密码通过stdin发送两次,对应doveadm的两次交互式提示。不要改用 `-p password`,
// 否则明文密码会出现在进程命令行里。子进程可能因为配置、算法或权限问题在
// 读完stdin前退出,所以stdin的异步error必须被监听;否则EPIPE会成为未处理事件,
// 直接拖垮整个Web服务。
const { spawn } = require('child_process');

function generateDovecotHash(password, scheme = 'SHA512-CRYPT', options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    let child;
    try {
      // -O tells doveadm not to read the system Dovecot configuration. Hash
      // generation needs only built-in defaults, and the Web service user may
      // legitimately have no permission to traverse /etc/dovecot on Alpine.
      child = spawnImpl('doveadm', ['-O', 'pw', '-s', scheme], {
        env: { PATH: process.env.PATH },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`无法启动 doveadm: ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdinError = null;
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));

    child.once('error', (err) => {
      finish(new Error(`无法启动 doveadm: ${err.message}`));
    });

    // write()/end()的try/catch只能接住同步异常。真实管道断开产生的EPIPE是
    // 异步error事件,必须在写入前注册监听器。先记下来,等close时连同doveadm
    // stderr和退出码一起报告,这样管理员能看到真正的失败原因。
    child.stdin.once('error', (err) => {
      stdinError = err;
    });

    child.once('close', (code, signal) => {
      // doveadm的交互式提示("Enter new password:"等)以及最终生成的哈希,
      // 在不同版本/不同终端环境下可能出现在stdout或stderr,两路都搜一遍。
      const combined = stdout + '\n' + stderr;
      const match = combined.match(/\{[A-Za-z0-9.-]+\}\S+/);
      if (code === 0 && match) {
        finish(null, match[0]);
        return;
      }

      const cleanStderr = stderr.replace(/\s+/g, ' ').trim().slice(0, 500);
      const exitDetail = signal ? `信号 ${signal}` : `退出码 ${code}`;
      const pipeDetail = stdinError
        ? `stdin ${stdinError.code || stdinError.message}`
        : '';
      const details = [cleanStderr, pipeDetail].filter(Boolean).join('; ');
      finish(new Error(
        `doveadm 生成密码哈希失败（${exitDetail}）${details ? `: ${details}` : ''}`
      ));
    });

    try {
      // 一次end()写入两行,分别对应doveadm的
      // "Enter new password" / "Retype new password" 两次提示,
      // 全程不经过任何命令行参数(argv对ps可见,stdin管道不会)。
      child.stdin.end(`${password}\n${password}\n`);
    } catch (err) {
      finish(new Error(`写入密码到 doveadm 失败: ${err.message}`));
    }
  });
}

module.exports = { generateDovecotHash };
