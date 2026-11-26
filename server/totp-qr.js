'use strict';
const QRCode = require('./vendor/totp-qr');
const { M } = require('./vendor/totp-qr/QRErrorCorrectLevel');

function totpQr(uri) {
  // The otpauth URI is bounded and percent-encoded before byte-mode encoding.
  if (typeof uri !== 'string' || !uri.startsWith('otpauth://totp/') || !/^[\x21-\x7e]{1,1200}$/.test(uri)) {
    throw new Error('Invalid authenticator QR source');
  }
  const code = new QRCode(-1, M);
  code.addData(uri);
  code.make();
  return code.modules.map(row => row.map(cell => cell ? '1' : '0').join(''));
}
module.exports = { totpQr };
