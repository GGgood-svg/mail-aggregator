/* global Api, I18n */
'use strict';
function initAppUpdate() {
  const el = name => document.getElementById(`app-update${name ? `-${name}` : ''}`);
  const base = '/api/system/app-update';
  const t = source => window.I18n?.t(source) || source;
  let latest, working = false, dirty = false;
  el('').hidden = false;
  const creation = (tag, text) => { const item = document.createElement(tag); if (text) item.textContent = t(text); return item; };
  const holdArea = creation('div'); holdArea.className = 'form-group';
  const holdLabel = creation('label', '暂停自动安装至（浏览器本地时间）');
  const holdUntil = creation('input'); holdUntil.type = 'datetime-local'; holdUntil.id = 'app-update-hold-until';
  holdLabel.htmlFor = holdUntil.id;
  const pause = creation('button', '暂停自动安装'); const clearPause = creation('button', '取消暂停');
  const skip = creation('button', '跳过当前版本'); const clearSkip = creation('button', '取消跳过');
  for (const button of [pause, clearPause, skip, clearSkip]) { button.type = 'button'; button.className = 'btn secondary'; }
  const pausedStatus = creation('p'); pausedStatus.className = 'hint'; pausedStatus.setAttribute('role', 'status');
  holdArea.append(holdLabel, holdUntil, pause, clearPause, skip, clearSkip, pausedStatus);
  el('form').append(holdArea);
  const trustSection = creation('details'); const trustInfo = creation('p'); trustInfo.className = 'hint';
  trustSection.append(creation('summary', '签名验证详情'), trustInfo); el('').append(trustSection);
  const historySection = creation('details'); const historyList = creation('ul'); const historyEmpty = creation('p');
  const historyPrevious = creation('button', '上一页'), historyNext = creation('button', '下一页');
  for (const button of [historyPrevious, historyNext]) { button.type = 'button'; button.className = 'btn secondary'; button.hidden = true; }
  const historyPosition = creation('span'); historyPosition.setAttribute('aria-live', 'polite');
  historySection.append(creation('summary', '安装历史'), historyEmpty, historyList, historyPrevious, historyPosition, historyNext);
  el('').append(historySection);
  let historyPage = 1, historyRevision = null, historyRequest = 0;
  async function loadHistory(page = 1) {
    if (!latest?.historyAvailable || !historySection.open) return;
    const request = ++historyRequest;
    const revision = latest.historyRevision || null;
    try {
      const data = await Api.get(`${base}/history?page=${page}`);
      if (!data || request !== historyRequest) return;
      const { items, pagination } = data;
      historyPage = pagination.page;
      historyRevision = revision;
      historyEmpty.textContent = items.length ? '' : t('此机尚无安装记录');
      historyList.replaceChildren(...items.map(record => {
        const row = creation('li');
        const source = t(({ manual: '手动', automatic: '自动', unknown: '来源未记录' })[record.source] || '来源未记录');
        row.textContent = `${date(record.at)} · ${record.from} → ${record.to} · ${source} · ${label(record.outcome)}${record.reason ? `：${label(record.reason)}` : ''}`;
        return row;
      }));
      historyPosition.textContent = pagination.totalPages > 1 ? ` ${historyPage} / ${pagination.totalPages} ` : '';
      historyPrevious.hidden = historyNext.hidden = pagination.totalPages <= 1;
      historyPrevious.disabled = historyPage <= 1;
      historyNext.disabled = historyPage >= pagination.totalPages;
    } catch (error) { if (request === historyRequest) historyEmpty.textContent = error.message; }
  }
  historySection.addEventListener('toggle', () => loadHistory(historyPage));
  historyPrevious.addEventListener('click', () => loadHistory(historyPage - 1));
  historyNext.addEventListener('click', () => loadHistory(historyPage + 1));
  const reason = {
    current_password_invalid: '当前密码错误，请重新输入。',
    busy: '作业正在运行，稍后重试。', maintenance_busy: '正在进行其他维护操作。', outside_window: '等待下个维护时段。',
    manual_upgrade: '该版本需要手工升级。', manual_platform: '此环境仅支持检查更新，请按发布说明手工升级。',
    activation_required: '需要管理员固定发布公钥并启用本机安装。', failed_release: '该版本已失败，不会再次自动安装。',
    not_installable: '本机或当前版本未开放自动安装。', service_not_running: 'Web 服务状态不可确认。',
    updater_unavailable: '无法连接本机更新服务。', github_timeout: '连接 GitHub 超时。', github_rate_limit: 'GitHub 限流，稍后重试。',
    github_unreachable: '无法访问 GitHub。', github_unavailable: 'GitHub 暂不可用。',
    invalid_signature: '发布签名验证失败。', invalid_manifest: '发布清单无效。', bad_package_hash: '软件包校验失败。',
    release_changed: '候选版本已变化，请重新检查。', readiness_failed: '新版未通过就绪检查。', rollback_failed: '回退未完成，请检查服务器。',
    insufficient_capacity: '暂存或数据库磁盘空间不足。', invalid_timezone: '时区无效，例如 Asia/Shanghai。', invalid_settings: '请填写不同的起止时间及有效时区。',
    invalid_local_config: '本机 Web 配置未通过预检。', preflight_failed: '应用包未通过本机预检。',
    downloading: '正在下载并校验', installing: '正在安装', installed: '已安装', deferred: '已推迟', rolled_back: '已回退', failed: '安装失败',
    invalid_hold_time: '请选择未来 180 天内的时间。', invalid_skip_version: '只能跳过当前可用版本。',
    version_skipped: '已跳过此版本的自动安装。', auto_paused: '已暂停自动安装。', rollback_verified: '已确认旧版恢复可用',
    finalization_failed: '更新后清理尚未完成，请检查服务器。',
    prepared: '已下载并校验，等待维护时段', queued: '安装请求已排队', verifying_rollback: '正在验证旧版服务', interrupted: '更新执行器已重启。',
  };
  const label = (code, fallback = '请查看服务器日志。') => t(reason[code] || fallback);
  const date = timestamp => timestamp ? new Date(timestamp).toLocaleString() : '—';
  function show(data, refreshFields = false) {
    if (!data) return;
    latest = data;
    if (refreshFields || !dirty) {
      for (const [input, key] of [['mode','mode'], ['channel','channel'], ['start','start'], ['end','end'], ['zone','timezone']]) el(input).value = data.settings[key];
      el('mode').querySelector('option[value="auto"]').disabled = !data.installationAvailable;
      const firstZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!data.lastCheck && data.settings.timezone === 'UTC' && firstZone) el('zone').value = firstZone;
    }
    const candidate = data.candidate;
    const text = [`${t('当前版本')}: ${data.current || '—'}`, data.checking ? t('正在检查…') : candidate ? `${t('可用版本')}: ${candidate.tag}` : data.lastCheck && !data.checkError ? t('没有更新的版本') : ''];
    if (data.lastCheck) text.push(`${t('最近检查')}: ${date(data.lastCheck)}`);
    if (data.nextCheck) text.push(`${t('下次检查')}: ${date(data.nextCheck)}`);
    if (data.nextAttempt) text.push(`${t('下次尝试')}: ${date(data.nextAttempt)}`);
    if (data.pending) text.push(`${t('等待安装')}: ${data.pending}`);
    if (data.checkError) text.push(label(data.checkError));
    if (candidate?.reason) text.push(label(candidate.reason));
    if (data.autoPauseReason) text.push(label(data.autoPauseReason));
    if (data.outcome) text.push(`${label(data.outcome)}${data.lastInstall?.reason ? `：${label(data.lastInstall.reason)}` : ''}`);
    el('status').textContent = text.filter(Boolean).join(' · ');
    // The server returns a fixed repository and a validated version tag.
    el('notes').href = /^v\d+\.\d+\.\d+(?:-(?:beta|rc)(?:\.\d+)?)?$/.test(candidate?.tag)
      ? `https://github.com/GGgood-svg/mail-aggregator/releases/tag/${candidate.tag}` : 'https://github.com/GGgood-svg/mail-aggregator/releases';
    el('notes-preview').textContent = candidate?.notes || '';
    el('notes-preview').hidden = !candidate?.notes;
    const keyState = { check_only: '当前环境仅检查版本', not_pinned: '未固定发布公钥', invalid: '本机公钥无效',
      pinned: '已固定公钥，未启用本机安装', enabled: '已固定并启用发布公钥' };
    const verifyState = { not_verified: '仅发现发布版本，未验证签名', manifest_verified: '发布清单签名已验证',
      package_verified: '发布清单与安装包已验证', verification_failed: '候选版本验证未通过' };
    const verification = [data.trust?.state && t(keyState[data.trust.state] || '签名状态未知')];
    if (data.trust?.fingerprint) verification.push(`${t('公钥指纹')} (SPKI SHA-256): ${data.trust.fingerprint}`);
    if (candidate) verification.push(t(verifyState[candidate.verification || 'not_verified'] || '签名状态未知'));
    if (candidate?.commit && ['manifest_verified','package_verified'].includes(candidate.verification)) {
      verification.push(`${t('签名提交')}: ${candidate.commit}`, `${t('目标平台')}: ${candidate.platform}`);
    }
    trustInfo.textContent = verification.filter(Boolean).join(' · ');
    if (!data.historyAvailable) historyEmpty.textContent = t('此机没有管理更新执行器');
    else if (data.historyRevision && data.historyRevision !== historyRevision) loadHistory(historyPage);
    pausedStatus.textContent = [data.settings.skipTag && `${t('已跳过')}: ${data.settings.skipTag}`,
      data.settings.holdUntil > Date.now() && `${t('暂停至')}: ${date(data.settings.holdUntil)}`,
    ].filter(Boolean).join(' · ');
    controls();
  }
  function controls() {
    el('window').hidden = el('mode').value !== 'auto';
    el('install').hidden = !latest?.candidate?.installable;
    el('auth').hidden = el('mode').value !== 'auto' && el('install').hidden;
    el('check').disabled = working || Boolean(latest?.checking || latest?.installing);
    el('save').disabled = working || !latest || latest.installing || latest.checking;
    el('install').disabled = working || Boolean(latest?.checking || latest?.installing || latest?.pending);
    holdArea.hidden = !latest?.installationAvailable || latest?.settings?.mode !== 'auto';
    const allowPolicyEdit = !holdArea.hidden && !working && !dirty && !latest.checking && !latest.installing;
    holdUntil.disabled = pause.disabled = !allowPolicyEdit;
    clearPause.disabled = !allowPolicyEdit || !(latest.settings.holdUntil > Date.now());
    skip.disabled = !allowPolicyEdit || !latest.candidate?.tag || latest.candidate.tag === latest.settings.skipTag;
    clearSkip.disabled = !allowPolicyEdit || !latest.settings.skipTag;
  }
  async function act(work, onDone) {
    working = true; controls();
    el('message').textContent = '';
    try { const data = await work(); if (onDone) onDone(); show(data); }
    catch (error) { el('message').textContent = error.details?.code ? label(error.details.code) : error.message; }
    finally { el('password').value = ''; working = false; controls(); }
  }
  async function refresh() {
    if (working || document.hidden) return;
    try { show(await Api.get(base)); }
    catch (e) { el('status').textContent = e.details?.code ? label(e.details.code) : e.message; }
  }
  el('form').addEventListener('input', ev => { if (ev.target !== el('password') && ev.target !== holdUntil) dirty = true; controls(); });
  const changeAuto = changes => act(() => Api.put(`${base}/settings`, { ...changes, currentPassword: el('password').value }));
  pause.addEventListener('click', () => {
    const at = new Date(holdUntil.value).getTime();
    if (!Number.isFinite(at) || at <= Date.now()) { el('message').textContent = label('invalid_hold_time'); return; }
    changeAuto({ holdUntil: at });
  });
  clearPause.addEventListener('click', () => changeAuto({ holdUntil: null }));
  skip.addEventListener('click', () => { if (latest?.candidate?.tag) changeAuto({ skipTag: latest.candidate.tag }); });
  clearSkip.addEventListener('click', () => changeAuto({ skipTag: null }));
  el('form').addEventListener('submit', ev => {
    ev.preventDefault();
    const mode = el('mode').value, timezone = el('zone').value.trim();
    if (mode === 'auto' && !window.confirm(`${t('确认开启自动安装，维护时段时区')}: ${timezone}？`)) return;
    act(() => Api.put(`${base}/settings`, { mode, channel: el('channel').value, start: el('start').value,
      end: el('end').value, timezone, currentPassword: el('password').value }), () => { dirty = false; });
  });
  el('check').addEventListener('click', () => act(() => Api.post(`${base}/check`, {})));
  el('install').addEventListener('click', () => {
    const tag = latest?.candidate?.tag;
    if (!tag || !window.confirm(`${t('确认安装并重启 Web')}: ${tag}？`)) return;
    act(() => Api.post(`${base}/install`, { tag, currentPassword: el('password').value }));
  });
  controls();
  refresh();
  setInterval(refresh, 4000);
}
