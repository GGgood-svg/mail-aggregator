const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readJobLogTail, sendJobLog } = require('../server/log-reader');

function withLogDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-aggregator-reader-test-'));
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir);
  try {
    run(root, logDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('small job logs are returned in full', () => {
  withLogDir((root, logDir) => {
    const logFile = path.join(logDir, 'job-7.log');
    fs.writeFileSync(logFile, '第一行\nsecond line\n');
    const result = readJobLogTail(logDir, { id: 7, log_file: logFile }, 1024);

    assert.equal(result.text, '第一行\nsecond line\n');
    assert.equal(result.truncated, false);
    assert.equal(result.startByte, 0);
    assert.equal(result.totalBytes, fs.statSync(logFile).size);
  });
});

test('large job logs return only a clean bounded tail', () => {
  withLogDir((root, logDir) => {
    const logFile = path.join(logDir, 'job-8.log');
    fs.writeFileSync(logFile, 'header\nline-one\nline-two\nline-three\n');
    const result = readJobLogTail(logDir, { id: 8, log_file: logFile }, 22);

    assert.equal(result.truncated, true);
    assert.equal(result.text, 'line-two\nline-three\n');
    assert.ok(Buffer.byteLength(result.text) <= 22);
    assert.ok(result.startByte > 0);
  });
});

test('reader rejects missing and non-canonical job log paths', () => {
  withLogDir((root, logDir) => {
    const outside = path.join(root, 'outside.log');
    fs.writeFileSync(outside, 'must not be read');

    assert.equal(readJobLogTail(logDir, { id: 9, log_file: outside }), null);
    assert.equal(
      readJobLogTail(logDir, { id: 9, log_file: path.join(logDir, 'job-10.log') }),
      null
    );
  });
});

test('HTTP log response includes task status and truncation metadata', () => {
  withLogDir((root, logDir) => {
    const logFile = path.join(logDir, 'job-11.log');
    fs.writeFileSync(logFile, 'live output');
    const headers = {};
    const response = {
      set(name, value) { headers[name] = value; return this; },
      type(value) { headers['Content-Type'] = value; return this; },
      send(value) { this.body = value; return this; },
    };

    assert.equal(sendJobLog(response, logDir, { id: 11, status: 'running', log_file: logFile }), true);
    assert.equal(headers['X-Job-Status'], 'running');
    assert.equal(headers['X-Log-Truncated'], 'false');
    assert.equal(headers['X-Log-Total-Bytes'], String(Buffer.byteLength('live output')));
    assert.equal(response.body, 'live output');
  });
});

test('missing log responses still expose task status so polling can stop or wait', () => {
  withLogDir((root, logDir) => {
    const headers = {};
    const response = { set(name, value) { headers[name] = value; return this; } };
    assert.equal(
      sendJobLog(response, logDir, { id: 12, status: 'running', log_file: path.join(logDir, 'job-12.log') }),
      false
    );
    assert.equal(headers['X-Job-Status'], 'running');
  });
});
