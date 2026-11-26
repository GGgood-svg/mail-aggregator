'use strict';

const path = require('node:path');

function dataPaths() {
  const root = path.resolve(process.env.MAIL_AGG_DATA_DIR || path.join(__dirname, '..', 'data'));
  return {
    root,
    db: path.join(root, 'db'),
    secrets: path.join(root, 'secrets'),
    cache: path.join(root, 'cache'),
    logs: path.join(root, 'logs'),
    tmp: path.join(root, 'tmp'),
    restorePoints: path.join(root, 'restore-points'),
  };
}

module.exports = { dataPaths };
