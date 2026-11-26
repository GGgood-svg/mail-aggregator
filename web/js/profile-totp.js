/* global Api, I18n, TotpText, setCsrfToken, initProfileDevices */
'use strict';
async function initProfileTotp() {
  await I18n.ready;
  const el = name => document.getElementById(`totp-${name}`);
  const t = TotpText.t;
  const panel = document.getElementById('profile-totp');
  const password = el('password'), code = el('code'), qr = el('qr');
  let state, enrolling = false, hasCodes = false, resumeLogin = false, busy = false;
  panel.hidden = false;
  function clearEnrollment() {
    enrolling = false;
    el('seed').value = '';
    qr.width = qr.height = 0;
    code.value = '';
  }
  function clearCodes() { hasCodes = false; el('codes').textContent = ''; }
  function render() {
    el('status').textContent = state ? t(state.enabled ? 'enabled' : 'disabled', { count: state.remainingCodes }) : '';
    el('controls').hidden = !state?.secure || hasCodes || resumeLogin;
    el('recovery').hidden = !hasCodes;
    el('begin').hidden = enrolling || state?.enabled;
    el('enable').hidden = !enrolling;
    el('cancel').hidden = !enrolling;
    el('enrollment').hidden = !enrolling;
    el('confirm').hidden = !enrolling && !state?.enabled;
    el('rotate').hidden = !state?.enabled;
    el('disable').hidden = !state?.enabled;
  }
  function setQr(rows) {
    if (!Array.isArray(rows) || rows.length < 21 || rows.length > 177 || !rows.every(row => typeof row === 'string' && row.length === rows.length && /^[01]+$/.test(row))) return;
    const padding = 4, pixels = 4;
    qr.width = qr.height = (rows.length + 2 * padding) * pixels;
    const context = qr.getContext('2d');
    if (!context) return;
    context.fillStyle = '#fff'; context.fillRect(0, 0, qr.width, qr.height);
    context.fillStyle = '#000';
    rows.forEach((row, y) => [...row].forEach((key, x) => {
      if (key === '1') context.fillRect((x + padding) * pixels, (y + padding) * pixels, pixels, pixels);
    }));
  }
  async function run(operation, confirmation) {
    if (busy || hasCodes || resumeLogin || !state?.secure || (confirmation && !window.confirm(t(confirmation)))) return;
    if (!password.value) { el('message').textContent = t('password'); password.focus(); return; }
    const value = code.value.trim();
    if (operation !== 'begin' && !/^\d{6}$/.test(value)) { el('message').textContent = t('authenticatorCode'); code.focus(); return; }
    const buttons = [...el('controls').querySelectorAll('button')];
    busy = true; for (const button of buttons) button.disabled = true;
    el('message').textContent = '';
    try {
      const result = await Api.post(`/api/auth/totp/${operation}`, { currentPassword: password.value, code: value });
      if (operation === 'begin') {
        enrolling = true;
        el('seed').value = result.seed;
        setQr(result.qr);
      } else {
        clearEnrollment();
        setCsrfToken(result.csrfToken);
        resumeLogin = result.loginRequired;
        hasCodes = result.codes.length > 0;
        el('codes').textContent = result.codes.join('\n');
        state = { ...state, enabled: operation !== 'disable', remainingCodes: result.codes.length };
        el('message').textContent = t(resumeLogin ? 'signInAgain' : { enable: 'ready', 'recovery-codes': 'changed', disable: 'turnedOff' }[operation]);
        if (resumeLogin && !hasCodes) { location.assign('/login.html'); return; }
      }
    } catch (error) {
      el('message').textContent = TotpText.failure(error);
      if (error.details?.code === 'totp_setup_expired') clearEnrollment();
    } finally {
      password.value = ''; code.value = '';
      busy = false; for (const button of buttons) button.disabled = false;
      render();
    }
    if (hasCodes) el('close').focus();
    else password.focus();
  }
  el('begin').onclick = () => run('begin');
  el('enable').onclick = () => run('enable');
  el('rotate').onclick = () => run('recovery-codes', 'confirmRotate');
  el('disable').onclick = () => run('disable', 'confirmDisable');
  el('cancel').onclick = () => { clearEnrollment(); password.value = ''; render(); };
  el('close').onclick = () => {
    clearCodes(); render();
    if (resumeLogin) location.assign('/login.html');
  };
  window.addEventListener('pagehide', () => { clearEnrollment(); clearCodes(); password.value = ''; render(); });
  try {
    state = await Api.get('/api/auth/totp');
    if (!state.secure) el('message').textContent = t('setupTransport');
  } catch (error) { el('message').textContent = TotpText.failure(error); }
  render();
}
