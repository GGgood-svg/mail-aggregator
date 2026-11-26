'use strict';

const { validNewPassword } = require('./password-policy');
const USERNAME_RE = /^[\p{L}\p{N}_.@-]{2,64}$/u;

function adminCredentials(input) {
  if (typeof input?.username !== 'string' || !validNewPassword(input.password)) return null;
  const username = input.username.normalize('NFKC').trim();
  return USERNAME_RE.test(username) ? { username, password: input.password } : null;
}

module.exports = { adminCredentials };
