'use strict';
const el = id => document.getElementById(id);
const failureCodes = { source_index_failed: 'MAI-101', dependency_failed: 'MAI-102', npm_dependencies_failed: 'MAI-103',
  native_sqlite_failed: 'MAI-104', service_start_failed: 'MAI-105', service_readiness_failed: 'MAI-106', install_failed: 'MAI-100',
  maintenance_busy: 'MAI-107', preflight_changed: 'MAI-108', install_timeout: 'MAI-109' };
const zh = {
  eyebrow: '首次安装 · 邮件汇聚', title: '安装向导', lead: '检查服务器、创建网页管理员，然后启动邮件面板。',
  pairTitle: '输入终端上的安装口令', pairHelp: '请先核对浏览器证书的 SHA-256 指纹与终端显示的一致。口令只能用一次，15 分钟内有效。',
  code: '安装口令', pair: '继续', configureTitle: '预检与设置', webPort: '邮件面板端口', language: '邮件面板语言',
  checks: '服务器检查', check: '重新检查', username: '网页管理员用户名', password: '网页管理员密码', confirm: '再次输入密码',
  passwordHelp: '至少 10 个字符，最多 72 个 UTF-8 字节。这个密码用于登录邮件面板。',
  ack: '确认这是一台未装过 Mail Aggregator 或 Dovecot 的服务器。', install: '开始安装', trusted: '安装后，邮件面板使用局域网 HTTP。仅在可信局域网访问。',
  runningTitle: '正在安装', runningHelp: '可以刷新或关闭这一页。安装会在服务器上继续，稍后用同一浏览器回来查看。',
  accountInfo: '进邮件面板请用上一步设置的管理员用户名和密码，不需要再注册。', imapTitle: '独立的 Dovecot 密码 · mailuser',
  reveal: '显示一次', panel: '打开邮件面板 ↗', finish: '完成并关闭向导', closeHelp: '安装结束后，向导最多继续开放 5 分钟。',
  waiting: '等待安装器取得维护锁…', succeeded: '安装完成', verified: '网页面板和本机 IMAP 登录已通过检查。', failed: '安装未通过',
  source_index_failed: '无法更新系统软件源。请检查镜像、网络和系统版本。', dependency_failed: '无法安装系统依赖。请核对当前系统的软件源。',
  npm_dependencies_failed: '无法获取应用依赖。请检查 npm 软件源和网络。', native_sqlite_failed: 'SQLite 原生模块无法构建或加载。请检查 Node.js 和编译工具。',
  service_start_failed: '系统服务启动失败。请在主机上查看应用服务日志。', service_readiness_failed: '服务未通过就绪检查。请核对监听端口和本机 IMAP。',
  failureHelp: '服务器保留了已写入的数据和步骤记录，不会自动重试。请查看服务器终端显示的日志位置。',
  imapOnce: '这个密码与网页管理员密码不同。显示后请保存，刷新页面不会再次显示。',
  imapGone: '密码已显示过。如果没有保存，可以登录邮件面板后修改 Dovecot 密码。',
  closed: '向导已关闭，可以关闭这个标签页。', beforeCheck: '正在检查…', changePort: '端口已变更，请重新检查。',
  platform: '受支持的 Linux、服务管理器和 Node.js 22.12 或更新版本', fresh: '无现有应用、Dovecot 或邮箱数据', lan: '局域网地址属于当前服务器',
  storage: '文件系统空间和文件节点充足（根分区至少 1 GiB）', web_port: '邮件面板端口可用', imap_port: 'IMAP 本机端口 143 可用',
  existing_app: '检测到已有应用、账户或数据。', existing_dovecot: '检测到 Dovecot、mailuser 或邮箱数据。',
  step1: '更新软件仓库', step2: '检测现有依赖', step3: '安装运行依赖和 imapsync', step4: '安装 Dovecot', step5: '建立本机邮件目录',
  step6: '部署应用与 SQLite 模块', step7: '配置系统服务', step8: '初始化应用数据与管理员', step9: '启动并验证服务',
  imapsync: '从固定版本安装并校验 imapsync', dovecot_config: '生成并检查 Dovecot 配置', dovecot_state: '保存本机邮件连接设置', admin_init: '创建首位网页管理员',
  application_start: '启动邮件面板', application_probe: '检查应用版本和就绪状态', setup_closed: '确认首次注册已关闭',
  updater: '配置应用更新服务', imap_login: '验证本机 IMAP 登录', enable_boot: '启用开机启动',
  network: '连不上安装向导。若正在安装，服务器可能仍在执行，稍后会自动重连。',
  wrong_code: '安装口令不正确。', pair_limit: '尝试次数已达上限。请在终端重启向导。', paired: '口令已用过，请回到最初配对的浏览器。',
  expired: '安装向导会话已到期。', pair_required: '请先输入安装口令。', csrf: '会话已变更，请刷新页面。',
  invalid_options: '请检查用户名（2–64 位字母、数字或 _.@-）、密码、语言和端口（1024–65535，不含 8090）。',
  mismatch: '两次输入的网页管理员密码不同。', preflight_blocked: '预检有项目未通过，请按下方提示处理。', already_started: '安装已开始，请刷新查看状态。',
  password_unavailable: '密码当前不可显示。', maintenance_busy: '另一项维护正在进行，安装未开始。', preflight_changed: '取得维护锁后复查未通过，安装未开始。',
  installer_unavailable: '无法联系安装执行器。请查看服务器终端。', not_available: '当前步骤无法执行此操作。', install_timeout: '安装超过等待时限。', install_failed: '安装命令未完成。',
};
const en = {
  eyebrow: 'Fresh install · Mail Aggregator', title: 'Installation wizard', lead: 'Check the server, create the web administrator, and start the mail panel.',
  pairTitle: 'Enter the setup code from the terminal', pairHelp: 'First match the browser certificate’s SHA-256 fingerprint with the terminal. The code works once and expires in 15 minutes.',
  code: 'Setup code', pair: 'Continue', configureTitle: 'Checks and settings', webPort: 'Mail panel port', language: 'Mail panel language',
  checks: 'Server checks', check: 'Check again', username: 'Web administrator username', password: 'Web administrator password', confirm: 'Confirm password',
  passwordHelp: 'Use at least 10 characters and at most 72 UTF-8 bytes. Use this password to sign in to the mail panel.',
  ack: 'I confirm this server has no Mail Aggregator or Dovecot installation.', install: 'Install', trusted: 'After setup, the mail panel uses HTTP on your LAN. Use a trusted network.',
  runningTitle: 'Installing', runningHelp: 'You can refresh or close this page. Installation continues on the server. Return in the same browser to see the result.',
  accountInfo: 'Sign in with the administrator username and password you chose. There is no extra registration step.', imapTitle: 'Separate Dovecot password · mailuser',
  reveal: 'Show once', panel: 'Open mail panel ↗', finish: 'Finish and close wizard', closeHelp: 'The wizard stays open for at most five minutes after installation ends.',
  waiting: 'Waiting for the installer to acquire the maintenance lock…', succeeded: 'Installation complete', verified: 'The web panel and local IMAP sign-in both passed verification.', failed: 'Installation failed',
  source_index_failed: 'Could not refresh system repositories. Check the mirror, network and operating system version.', dependency_failed: 'Could not install system dependencies. Check your configured repositories.',
  npm_dependencies_failed: 'Could not download application dependencies. Check the npm registry and network.', native_sqlite_failed: 'The SQLite native module could not build or load. Check Node.js and the build tools.',
  service_start_failed: 'The service failed to start. Check the service logs on the server.', service_readiness_failed: 'Readiness checks failed. Check the Web port and local IMAP.',
  failureHelp: 'The server saved the progress record and any data already written. It will not retry automatically. See the log location printed in the server terminal.',
  imapOnce: 'This is separate from your web password. Save it when shown. It will not be shown again after a refresh.',
  imapGone: 'The password has been shown. If you did not save it, sign in to the mail panel to change the Dovecot password.',
  closed: 'The wizard is closed. You can close this tab.', beforeCheck: 'Checking…', changePort: 'Port changed. Run the checks again.',
  platform: 'Supported Linux, service manager, and Node.js 22.12 or later', fresh: 'No existing app, Dovecot or mail data', lan: 'LAN address is assigned to this server',
  storage: 'Available space and inodes (at least 1 GiB on the root filesystem)', web_port: 'Mail panel port is free', imap_port: 'Local IMAP port 143 is free',
  existing_app: 'Found an existing app, user or data.', existing_dovecot: 'Found Dovecot, mailuser or existing mail.',
  step1: 'Update package repositories', step2: 'Check existing dependencies', step3: 'Install runtime packages and imapsync', step4: 'Install Dovecot', step5: 'Set up local mail storage',
  step6: 'Deploy the app and SQLite module', step7: 'Configure system services', step8: 'Initialize app data and the administrator', step9: 'Start and verify services',
  imapsync: 'Install and verify the pinned imapsync version', dovecot_config: 'Generate and check Dovecot configuration', dovecot_state: 'Save local mail connection settings', admin_init: 'Create the first web administrator',
  application_start: 'Start the mail panel', application_probe: 'Check app version and readiness', setup_closed: 'Confirm registration is disabled',
  updater: 'Configure the app update service', imap_login: 'Verify local IMAP sign-in', enable_boot: 'Enable startup on boot',
  network: 'Cannot reach the wizard. If installation is running, the server may still be working. This page will reconnect automatically.',
  wrong_code: 'The setup code is incorrect.', pair_limit: 'Too many attempts. Restart the wizard in the terminal.', paired: 'The code has been used. Return to the browser that paired first.',
  expired: 'The wizard session expired.', pair_required: 'Enter the setup code first.', csrf: 'The session changed. Reload the page.',
  invalid_options: 'Check the username (2–64 letters, digits or _.@-), password, language and port (1024–65535, except 8090).',
  mismatch: 'The two administrator passwords do not match.', preflight_blocked: 'One or more checks failed. See the results below.', already_started: 'Installation already started. Reload this page to see progress.',
  password_unavailable: 'The password is no longer available.', maintenance_busy: 'Another maintenance operation is running. Installation did not start.',
  preflight_changed: 'The checks failed again under the maintenance lock. Installation did not start.', installer_unavailable: 'Cannot reach the installer. Check the server terminal.',
  not_available: 'This action is not available now.', install_timeout: 'Installation timed out.', install_failed: 'The installation command did not finish successfully.',
};
let locale = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
let status, csrf, busy = false, nextPoll, message, revealed = false;
const t = key => (locale === 'zh' ? zh : en)[key] || (locale === 'zh' ? zh : en).installer_unavailable;

function alertUser(key) {
  message = key;
  el('message').hidden = !key;
  el('message').textContent = key ? t(key) : '';
}

async function api(operation, data) {
  let response;
  try {
    response = await fetch(`/api/${operation}`, data === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Install-CSRF': csrf } : {}) }, body: JSON.stringify(data),
    });
  } catch (_) { throw { error: 'network' }; }
  const result = await response.json().catch(() => ({ error: 'installer_unavailable' }));
  if (!response.ok) throw result;
  return result;
}

function show(section) {
  for (const id of ['pairing', 'configure', 'running', 'finished']) el(id).hidden = id !== section;
}

function showChecks() {
  const port = Number(el('web-port').value);
  const matching = status?.checks && port === status.webPort;
  const items = matching ? status.checks.map(({ id, ok, reason }) => {
    const row = document.createElement('li');
    row.className = ok ? 'pass' : 'block';
    row.textContent = `${ok ? '✓' : '✕'} ${t(id)}${reason ? ` · ${t(reason)}` : ''}`;
    return row;
  }) : [];
  if (!matching) {
    const row = document.createElement('li');
    row.textContent = t(status?.checks ? 'changePort' : 'beforeCheck');
    items.push(row);
  }
  el('checks').replaceChildren(...items);
  el('install').disabled = busy || !matching || !status.checks.every(item => item.ok);
  el('check').disabled = busy;
}

function render(next) {
  status = next;
  csrf = status.csrf;
  if (status.phase === 'configure') {
    show('configure');
    showChecks();
  } else if (status.phase === 'installing') {
    show('running');
    if (status.step) el('progress').value = status.step - 1;
    el('stage').textContent = status.step
      ? `${status.step}/9 · ${t(`step${status.step}`)}${status.detail ? ` · ${t(status.detail)}` : ''}` : t('waiting');
  } else {
    show('finished');
    const ok = status.phase === 'succeeded';
    el('success-info').hidden = !ok;
    el('finished-title').textContent = t(ok ? 'succeeded' : 'failed');
    const failure = Object.hasOwn(failureCodes, status.error) ? status.error : 'install_failed';
    el('finished-info').textContent = ok ? t('verified') : `[${failureCodes[failure]}] ${t(failure)} ${t('failureHelp')}`;
    if (ok) {
      el('panel').href = status.panel;
      el('reveal').hidden = !status.passwordAvailable || revealed;
      el('imap-hint').textContent = t(status.passwordAvailable || revealed ? 'imapOnce' : 'imapGone');
    }
  }
}

function translate() {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  document.title = `Mail Aggregator · ${t('title')}`;
  el('toggle-language').textContent = locale === 'zh' ? 'English' : '简体中文';
  for (const node of document.querySelectorAll('[data-t]')) node.textContent = t(node.dataset.t);
  alertUser(message);
  if (status) render(status);
}

function pollSoon() {
  clearTimeout(nextPoll);
  nextPoll = setTimeout(load, 1600);
}

async function load() {
  try {
    const snapshot = await api('status');
    const first = !status;
    if (first && snapshot.phase === 'configure') el('web-port').value = snapshot.webPort;
    render(snapshot);
    alertUser();
    if (snapshot.phase === 'installing') pollSoon();
    if (first && snapshot.phase === 'configure') await check();
  } catch ({ error }) {
    if (error === 'pair_required') { show('pairing'); return; }
    alertUser(error);
    if (error === 'network') pollSoon();
  }
}

async function check() {
  if (busy) return;
  const webPort = Number(el('web-port').value);
  if (!el('web-port').checkValidity() || webPort === 8090) { alertUser('invalid_options'); return; }
  busy = true;
  showChecks();
  try { render(await api('preflight', { webPort })); alertUser(); }
  catch ({ error }) { alertUser(error); }
  finally { busy = false; showChecks(); }
}

el('toggle-language').addEventListener('click', () => { locale = locale === 'zh' ? 'en' : 'zh'; translate(); });
el('web-port').addEventListener('input', showChecks);
el('check').addEventListener('click', check);
el('pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  try {
    render(await api('pair', { code: el('code').value }));
    el('code').value = '';
    alertUser();
  } catch ({ error }) { alertUser(error); }
  finally { busy = false; }
  if (status?.phase === 'configure') await check();
});
el('install-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || el('install').disabled) return;
  const password = el('password').value;
  if (password !== el('confirm').value) { alertUser('mismatch'); return; }
  if (password.length < 10 || new TextEncoder().encode(password).length > 72) { alertUser('invalid_options'); return; }
  busy = true;
  showChecks();
  try {
    render(await api('install', { username: el('username').value, password,
      webPort: Number(el('web-port').value), language: el('language').value }));
    el('password').value = el('confirm').value = '';
    alertUser();
    if (status.phase === 'installing') pollSoon();
  } catch (result) {
    if (result.phase) render(result);
    alertUser(result.error);
    // The install request could have been accepted even if the response was lost.
    if (result.error === 'network' || result.error === 'already_started') pollSoon();
  } finally { busy = false; showChecks(); }
});
el('reveal').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  try {
    const { password } = await api('reveal', {});
    revealed = true;
    el('imap-password').value = password;
    el('imap-password').hidden = false;
    el('imap-password').focus();
    el('imap-password').select();
    el('reveal').hidden = true;
    alertUser();
  } catch ({ error }) { alertUser(error); }
  finally { busy = false; }
});
el('finish').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  try {
    await api('finish', {});
    el('imap-password').value = '';
    status = csrf = undefined;
    show(null);
    alertUser('closed');
  } catch ({ error }) { alertUser(error); }
  finally { busy = false; }
});
translate();
load();
