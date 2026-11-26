'use strict';

const { parentPort } = require('node:worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', ({ id, operation, password, hash }) => {
  try {
    const result = operation === 'hash'
      ? bcrypt.hashSync(password, 12)
      : operation === 'compare' ? bcrypt.compareSync(password, hash) : undefined;
    if (result === undefined) throw new Error('Unsupported password operation');
    parentPort.postMessage({ id, result });
  } catch (_) {
    // Never return passwords, hashes or library error messages to the parent.
    parentPort.postMessage({ id, failed: true });
  }
});
