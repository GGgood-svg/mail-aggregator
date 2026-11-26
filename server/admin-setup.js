'use strict';

const { adminCredentials } = require('./admin-setup-input');
const { passwordHelp } = require('./password-policy');
const { withStateLock } = require('./state-lock');

function createAdminSetup({ db, root, hasher }) {
  const hasAdmin = () => Boolean(db.prepare('SELECT 1 FROM admin_users LIMIT 1').get());
  const alreadyExists = statusCode => Object.assign(new Error('管理员账号已存在'), { statusCode });
  return {
    hasAdmin,
    async create(input) {
      if (hasAdmin()) throw alreadyExists(400);
      const credentials = adminCredentials(input);
      if (!credentials) throw Object.assign(new Error(`用户名需为2-64位；${passwordHelp}`), { statusCode: 400 });
      // Do not hold the cross-process lock during password hashing.
      const hash = await hasher.hash(credentials.password);
      return withStateLock(root, () => {
        if (hasAdmin()) throw alreadyExists(409);
        return db.prepare("INSERT INTO admin_users (username, password_hash, role, mail_access_all) VALUES (?, ?, 'admin', 1)")
          .run(credentials.username, hash);
      });
    },
  };
}

module.exports = { createAdminSetup };
