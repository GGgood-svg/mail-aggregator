'use strict';
const fs = require('node:fs');
const { createHash, createPublicKey } = require('node:crypto');
const { ensure } = require('./release');

function load(file) {
  const stat = fs.statSync(file);
  ensure(stat.isFile() && stat.size <= 4096, 'invalid_public_key');
  const input = fs.readFileSync(file, 'utf8').trim();
  ensure(/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(input), 'public_key_required');
  const key = createPublicKey(input);
  ensure(key.asymmetricKeyType === 'ed25519', 'ed25519_key_required');
  return key;
}
try {
  const source = load(process.argv[2]);
  const to = process.argv[3];
  const der = key => key.export({ type: 'spki', format: 'der' });
  const fingerprint = createHash('sha256').update(der(source)).digest('hex');
  if (fs.existsSync(to)) ensure(der(load(to)).equals(der(source)), 'public_key_already_pinned');
  else if (process.argv[4] !== '--check') {
    const fd = fs.openSync(to, 'wx', 0o644);
    try { fs.writeFileSync(fd, source.export({ type: 'spki', format: 'pem' })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  console.log(`Ed25519 SPKI SHA-256: ${fingerprint}`);
} catch (error) { console.error(`Update trust key: ${error.message}`); process.exitCode = 1; }
