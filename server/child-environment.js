const path = require('node:path');

// OAuth refresh is launched by imapsync, so it must inherit the same database
// location even when the service was started with a relative data directory.
function childEnvironment(dataDir, env = process.env) {
  return { PATH: env.PATH, MAIL_AGG_DATA_DIR: path.resolve(dataDir) };
}

module.exports = { childEnvironment };
