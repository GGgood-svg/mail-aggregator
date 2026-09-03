const fs = require('fs');
const { managedLogPath } = require('./log-retention');

const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;

function readJobLogTail(logDir, job, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  const logPath = job && managedLogPath(logDir, job);
  if (!logPath) return null;

  let stat;
  try {
    stat = fs.lstatSync(logPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  // Do not follow a symlink even if it uses the expected job filename.
  if (!stat.isFile()) return null;

  const totalBytes = stat.size;
  const requestedStart = Math.max(0, totalBytes - maxBytes);
  const length = totalBytes - requestedStart;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(logPath, 'r');
  let bytesRead;
  try {
    bytesRead = fs.readSync(fd, buffer, 0, length, requestedStart);
  } finally {
    fs.closeSync(fd);
  }

  let content = buffer.subarray(0, bytesRead);
  let startByte = requestedStart;
  // A tail read can start in the middle of a UTF-8 character or log line. When
  // possible, discard that partial first line so the returned text is clean.
  if (requestedStart > 0) {
    const firstNewline = content.indexOf(0x0a);
    if (firstNewline !== -1) {
      content = content.subarray(firstNewline + 1);
      startByte += firstNewline + 1;
    }
  }

  return {
    text: content.toString('utf8'),
    totalBytes,
    startByte,
    truncated: startByte > 0,
  };
}

function sendJobLog(res, logDir, job) {
  if (job && job.status) res.set('X-Job-Status', String(job.status));
  const result = readJobLogTail(logDir, job);
  if (!result) return false;
  res.set('X-Log-Truncated', result.truncated ? 'true' : 'false');
  res.set('X-Log-Total-Bytes', String(result.totalBytes));
  res.set('X-Log-Start-Byte', String(result.startByte));
  res.type('text/plain').send(result.text);
  return true;
}

module.exports = {
  DEFAULT_MAX_LOG_BYTES,
  readJobLogTail,
  sendJobLog,
};
