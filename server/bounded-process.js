'use strict';
const { execFile } = require('node:child_process');

// Abort/timeout initiates termination; completion always waits for close.
function runBounded(file, args, { signal, input, timeout = 5000, maxBuffer = 4096, execFileImpl = execFile, ...options } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Operation cancelled'));
    let result, failure, child;
    const abort = () => { failure = new Error('Operation cancelled'); child?.kill('SIGKILL'); };
    try {
      child = execFileImpl(file, args, { ...options, encoding: 'utf8', timeout, maxBuffer, killSignal: 'SIGKILL', windowsHide: true }, (error, stdout, stderr) => {
        failure ||= error; result = { stdout, stderr };
      });
    } catch (error) { reject(error); return; }
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', error => { failure ||= error; });
    child.once('error', error => { failure ||= error; });
    child.once('close', () => {
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure); else resolve(result || { stdout: '', stderr: '' });
    });
    if (signal?.aborted) abort();
    try { child.stdin.end(input); }
    catch (error) { failure ||= error; child.kill('SIGKILL'); }
  });
}
module.exports = { runBounded };
