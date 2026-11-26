'use strict';
const { parentPort } = require('node:worker_threads');
const { simpleParser } = require('mailparser');
const { serializeParsedMessage } = require('./mail-content');

parentPort.on('message', async ({ id, metadata, source }) => {
  try {
    const parsed = await simpleParser(Buffer.from(source), { keepCidLinks: true, maxHtmlLengthToParse: 4 * 1024 * 1024 });
    parentPort.postMessage({ id, result: serializeParsedMessage(metadata, parsed) });
  } catch (_) { parentPort.postMessage({ id, failed: true }); }
});
