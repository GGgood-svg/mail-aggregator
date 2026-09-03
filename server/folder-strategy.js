const DESTINATION_MODES = new Set(['flat', 'subfolder']);

function normalizeDestinationFolder(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function isValidDestinationFolder(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) return false;
  // A single portable IMAP path segment: no hierarchy separators, controls,
  // leading option-like punctuation, or Dovecot Maildir separator ambiguity.
  return /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u.test(value);
}

function applyDestinationStrategy(args, account) {
  if (account.destination_mode === 'subfolder') {
    args.push('--subfolder2', account.destination_folder);
  }
  return args;
}

module.exports = {
  DESTINATION_MODES,
  normalizeDestinationFolder,
  isValidDestinationFolder,
  applyDestinationStrategy,
};
