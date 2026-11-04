function validNewPassword(password) {
  return typeof password === 'string' && password.length >= 10 && Buffer.byteLength(password, 'utf8') <= 72;
}
const passwordHelp = '密码至少10个字符，且 UTF-8 编码不能超过72字节';
module.exports = { validNewPassword, passwordHelp };
