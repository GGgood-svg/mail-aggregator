(function () {
  'use strict';
  const strings = {
    title: ['双重验证', 'Two-step verification'],
    loginHint: ['输入验证器的六位验证码，或输入尚未使用的恢复码。', 'Enter the six-digit code from your authenticator or an unused recovery code.'],
    loginCode: ['验证码或恢复码', 'Authenticator code or recovery code'],
    lanLoginHint: ['请输入验证器的六位验证码。使用恢复码请改用 HTTPS 或 SSH 本机转发。', 'Enter the six-digit authenticator code. To use a recovery code, connect over HTTPS or an SSH tunnel.'],
    operationCode: ['验证器的六位验证码', 'Six-digit authenticator code'],
    operationCodeHint: ['登录用过的验证码不能再用。请等验证器显示下一组。', 'A code used at sign-in cannot be reused. Wait for the next code.'],
    lanProfile: ['可信局域网', 'Trusted LAN'],
    strictProfile: ['严格', 'Strict'],
    operationProfile: ['敏感操作安全档位', 'Sensitive operation profile'],
    lanOperationHint: ['此连接可执行敏感操作；HTTP 不加密。', 'Sensitive operations are available on this connection. HTTP is not encrypted.'],
    setupFactor: ['建议开启两步验证', 'Set up two-step verification (recommended)'],
    blockedOperationHint: ['当前连接不能执行备份、恢复或安装更新。请使用 HTTPS 或 SSH 本机转发。', 'Use HTTPS or an SSH tunnel to export backups, restore, or install updates on this connection.'],
    setupTransport: ['当前不能设置验证器。没有证书时，用 SSH 把面板转发到电脑的 127.0.0.1，再从本机地址登录设置。', 'To set up your authenticator without a certificate, forward the panel to 127.0.0.1 over SSH and sign in through that address.'],
    back: ['返回密码登录', 'Back to password sign-in'],
    verify: ['验证并登录', 'Verify and sign in'],
    password: ['当前登录密码', 'Current sign-in password'],
    authenticatorCode: ['验证器的六位验证码', 'Six-digit authenticator code'],
    help: ['保护主管理员登录。在可信局域网上执行备份下载、恢复和安装更新时也会要求验证器验证码。请把恢复码保存在独立的安全位置。', 'Protects primary administrator sign-in. Backup downloads, restores and update installation on trusted LAN HTTP also require an authenticator code. Keep your recovery codes in a separate, safe place.'],
    scan: ['在验证器里扫描二维码，或手动输入密钥，再输入当前的六位验证码。二维码不会发送给外部服务。', 'Scan the QR code or enter the setup key in your authenticator, then enter its current six-digit code. The QR code stays within this application.'],
    qr: ['验证器配对二维码', 'Authenticator setup QR code'],
    seed: ['手动配对密钥', 'Manual setup key'],
    begin: ['开始设置', 'Set up verification'],
    enable: ['确认并开启', 'Verify and enable'],
    cancel: ['取消设置', 'Cancel setup'],
    rotate: ['重新生成恢复码', 'Generate new recovery codes'],
    disable: ['关闭双重验证', 'Turn off two-step verification'],
    recovery: ['一次性恢复码', 'One-time recovery codes'],
    saveCodes: ['现在把恢复码保存到安全位置。每个只能使用一次，关闭后无法再查看这组码。', 'Save these codes somewhere safe now. Each code works once, and this list is only shown here.'],
    close: ['我已保存，关闭列表', 'I saved the codes'],
    enabled: ['已开启 · 剩余恢复码：{count}', 'Enabled · recovery codes left: {count}'],
    disabled: ['尚未开启', 'Off'],
    ready: ['双重验证已开启，其他登录已退出。', 'Two-step verification is enabled. Other sessions were signed out.'],
    changed: ['已生成新恢复码，旧恢复码和其他登录均已失效。', 'New recovery codes were generated. Old codes and other sessions are now invalid.'],
    turnedOff: ['已关闭双重验证，原有恢复码和其他登录均已失效。', 'Two-step verification is off. Previous recovery codes and other sessions are now invalid.'],
    confirmRotate: ['重新生成后，所有旧恢复码都不能再用。继续吗？', 'Generating new codes invalidates all existing recovery codes. Continue?'],
    confirmDisable: ['关闭后只用密码就能登录。确认关闭吗？', 'Turning this off allows sign-in with only a password. Continue?'],
    signInAgain: ['验证设置已保存。记下恢复码后请重新登录。', 'The verification setting was saved. Sign in again after saving any recovery codes.'],
    totp_secure_transport: ['请使用 HTTPS 或 SSH 本机转发。设置双重验证或使用恢复码需要这类连接。', 'Use HTTPS or an SSH tunnel. Setting up two-step verification or using recovery codes requires this connection.'],
    totp_rate_limited: ['验证码尝试次数过多，请稍后再试。', 'Too many verification attempts. Try again later.'],
    totp_login_expired: ['这次验证已过期，请重新输入用户名和密码。', 'This verification expired. Start again with your username and password.'],
    totp_invalid_code: ['验证码无效或已经用过。请使用下一组验证码或未使用的恢复码。', 'The code is invalid or already used. Try the next authenticator code or an unused recovery code.'],
    totp_setup_expired: ['设置已过期，请重新开始配对。', 'Setup expired. Start pairing again.'],
    totp_state_unavailable: ['无法读取双重验证状态。请从服务器控制台检查恢复指引。', 'Verification status is unavailable. Consult the recovery guide from the server console.'],
    totp_already_enabled: ['已开启双重验证，请刷新页面。', 'Two-step verification is already enabled. Refresh the page.'],
    totp_not_enabled: ['双重验证未开启，请刷新页面。', 'Two-step verification is off. Refresh the page.'],
  };
  function t(key, values = {}) {
    return (strings[key]?.[I18n.locale === 'zh-CN' ? 0 : 1] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
  }
  function failure(error) {
    const key = error.details?.code;
    return key && Object.hasOwn(strings, key) ? t(key) : I18n.t(error.message);
  }
  function translate() {
    for (const el of document.querySelectorAll('[data-totp]')) el.textContent = t(el.dataset.totp);
    for (const el of document.querySelectorAll('[data-totp-label]')) el.setAttribute('aria-label', t(el.dataset.totpLabel));
  }
  window.TotpText = { t, failure };
  void I18n.ready.then(translate);
})();
