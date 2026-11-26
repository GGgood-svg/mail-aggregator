'use strict';
const { spawn } = require('node:child_process');
const { UpdateError } = require('./release');

async function withHostLock(filename, work) {
  // The wrapper holds the file descriptor; a dead Node process closes stdin.
  const holder = spawn('/bin/sh', ['-c', 'exec 9<"$1"; flock -n 9 || exit 73; echo locked; cat >/dev/null', 'sh', filename], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  holder.stdin.on('error', () => {});
  const exited = new Promise(resolve => { holder.once('error', resolve); holder.once('close', resolve); });
  const timer = setTimeout(() => { holder.stdin.end(); holder.kill(); }, 3000);
  try {
    const gotLock = await new Promise(resolve => {
      holder.stdout.once('data', chunk => resolve(chunk.toString().startsWith('locked')));
      exited.then(() => resolve(false));
    });
    clearTimeout(timer);
    if (!gotLock) throw new UpdateError('maintenance_busy');
    return await work();
  } finally { clearTimeout(timer); holder.stdin.end(); await exited; }
}
module.exports = { withHostLock };
