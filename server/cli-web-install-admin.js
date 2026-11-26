'use strict';

const { adminCredentials } = require('./admin-setup-input');

async function main() {
  // Only run as the application service account against its fresh database.
  if (!process.getuid || process.getuid() === 0 || require('node:os').userInfo().username !== 'mailadmin'
      || process.env.MAIL_AGG_DATA_DIR !== '/var/lib/mail-aggregator') throw Error('wrong install identity');
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 4096) throw Error('invalid input');
  }
  const credentials = adminCredentials(JSON.parse(raw));
  if (!credentials) throw Error('invalid credentials');
  const { db, DIRS } = require('./db');
  const { passwordHasher } = require('./password-hasher');
  const { createAdminSetup } = require('./admin-setup');
  try {
    await createAdminSetup({ db, root: DIRS.root, hasher: passwordHasher }).create(credentials);
  } finally {
    db.close();
  }
}

main().catch(() => {
  console.error('Could not initialize the first Web administrator.');
  process.exitCode = 1;
});
