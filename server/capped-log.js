'use strict';

const fs = require('node:fs');

const TRUNCATION_MARKER = Buffer.from('\n\n--- earlier log output truncated by Mail Aggregator ---\n\n');

function appendTail(current, incoming, limit) {
  if (incoming.length >= limit) return incoming.subarray(incoming.length - limit);
  if (current.length + incoming.length <= limit) return Buffer.concat([current, incoming]);
  return Buffer.concat([current.subarray(current.length + incoming.length - limit), incoming]);
}

function createCappedLog(file, { maxBytes = 16 * 1024 * 1024, tailBytes = 1024 * 1024 } = {}) {
  const safeMax = Math.max(4096, Number(maxBytes) || 0);
  const safeTail = Math.min(Math.max(1024, Number(tailBytes) || 0), Math.floor(safeMax / 2));
  const headLimit = safeMax - safeTail - TRUNCATION_MARKER.length;
  const stream = fs.createWriteStream(file, { flags: 'w', mode: 0o600 });
  let headWritten = 0;
  let tail = Buffer.alloc(0);
  let truncated = false;
  let ended = false;

  function write(chunk) {
    if (ended) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (!truncated && headWritten + data.length <= headLimit) {
      stream.write(data);
      headWritten += data.length;
      return;
    }
    truncated = true;
    const headRemaining = Math.max(0, headLimit - headWritten);
    if (headRemaining) {
      stream.write(data.subarray(0, headRemaining));
      headWritten += headRemaining;
    }
    tail = appendTail(tail, data.subarray(headRemaining), safeTail);
  }

  function end(callback) {
    if (ended) return;
    ended = true;
    if (truncated) {
      stream.write(TRUNCATION_MARKER);
      stream.write(tail);
    }
    stream.end(callback);
  }

  return {
    write,
    end,
    on: (...args) => stream.on(...args),
    once: (...args) => stream.once(...args),
    get closed() { return stream.closed; },
    get destroyed() { return stream.destroyed; },
  };
}

module.exports = { TRUNCATION_MARKER, appendTail, createCappedLog };
