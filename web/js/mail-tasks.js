/* Durable mail operations share one presentation on the mail and task pages. */
window.MailTasksUI = {
  samples(result) {
    const t = source => window.MailContinuationText?.(source, window.I18n?.locale) ?? window.I18n.t(source);
    const rows = (result.samples || []).map(sample => `<li><span data-i18n-skip>${escapeHtml(sample.subject || t('(无主题)'))}</span>${sample.date ? ` · <time>${escapeHtml(fmtTime(sample.date))}</time>` : ''}</li>`).join('');
    const reason = { removed: '部分样本邮件已移除', unavailable: '样本暂时不可用' }[result.sampleReason];
    return `${rows ? `<ul aria-label="${escapeHtml(t('匹配样本'))}">${rows}</ul>` : ''}${reason ? `<small>${escapeHtml(t(reason))}</small>` : ''}`;
  },
  active: task => ['queued', 'running', 'cancelling'].includes(task.status),
  status(task) {
    if (task.status === 'running' && task.phase === 'checking_scope') return window.I18n.t('核对范围');
    const labels = { queued: '排队中', running: '处理中', cancelling: '正在取消', completed: '已完成',
      partial: '部分完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', invalidated: '已失效' };
    return window.I18n.t(labels[task.status] || task.status);
  },
  kind(task) { return window.I18n.t({ seen_all: '全部标为已读', rule_preview: '规则预览', rule_apply: '应用规则' }[task.kind] || task.kind); },
  action(value) { if (value === 'label') return window.MailContinuationText?.('添加个人标签', window.I18n.locale) ?? '添加个人标签';
    return window.I18n.t({ seen: '标为已读', unseen: '标为未读', star: '添加星标', unstar: '取消星标' }[value] || value); },
};

window.MailTaskCenter = {
  create() {
    const t = source => window.I18n.t(source), panel = document.getElementById('mail-tasks-panel');
    let page = 1, selected = new URLSearchParams(location.search).get('task'), timer, generation = 0, controller, visible = false;
    function stop() { clearTimeout(timer); controller?.abort(); generation++; }
    function schedule(active = true) { clearTimeout(timer); if (visible) timer = setTimeout(() => load().catch(showError), document.hidden || !active ? 10000 : 1500); }
    function showError(error) { if (error.name !== 'AbortError') { document.getElementById('mail-tasks-message').textContent = t(error.message); schedule(); } }
    async function load() {
      stop(); if (!visible) return;
      const id = generation; controller = new AbortController();
      const data = await Api.get(`/api/mail/tasks?page=${page}`, { signal: controller.signal });
      if (!data || id !== generation) return;
      const detail = selected ? await Api.get(`/api/mail/tasks/${selected}`, { signal: controller.signal }).catch(error => { if (error.status === 404) { selected = null; return null; } throw error; }) : null;
      if (id !== generation) return;
      document.getElementById('mail-tasks-message').textContent = '';
      const items = document.getElementById('mail-tasks-list');
      items.innerHTML = data.items.map(task => `<article class="mail-task-card">
        <div><strong>${escapeHtml(MailTasksUI.kind(task))}</strong> · ${escapeHtml(MailTasksUI.status(task))}</div>
        <div class="hint">${escapeHtml(fmtTime(task.createdAt))} · ${t('已确认邮件')} ${task.updated} · ${t('匹配邮件')} ${task.matched} · ${t('结果待核实')} ${task.uncertain}</div>
        <div class="mail-search-actions"><button class="btn secondary small" data-mail-task="${task.id}">${t('查看结果')}</button>
          ${MailTasksUI.active(task) ? `<button class="btn secondary small" data-mail-cancel="${task.id}">${t('取消')}</button>` : ''}
          ${task.resumable ? `<button class="btn secondary small" data-mail-resume="${task.id}">${t('继续任务')}</button>` : ''}</div>
      </article>`).join('') || `<p class="hint">${t('暂无邮件整理任务')}</p>`;
      items.querySelectorAll('[data-mail-task]').forEach(button => button.addEventListener('click', () => { selected = button.dataset.mailTask; load().catch(showError); }));
      items.querySelectorAll('[data-mail-cancel]').forEach(button => button.addEventListener('click', () => mutate(button, 'cancel', button.dataset.mailCancel)));
      items.querySelectorAll('[data-mail-resume]').forEach(button => button.addEventListener('click', () => mutate(button, 'resume', button.dataset.mailResume)));
      const pagination = document.getElementById('mail-tasks-pagination');
      page = data.pagination.page;
      pagination.innerHTML = `<button class="btn secondary small" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${t('上一页')}</button><span>${page} / ${data.pagination.totalPages}</span><button class="btn secondary small" data-page="${page + 1}" ${page >= data.pagination.totalPages ? 'disabled' : ''}>${t('下一页')}</button>`;
      pagination.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => { page = Number(button.dataset.page); load().catch(showError); }));
      const results = document.getElementById('mail-task-results'); results.hidden = !detail;
      if (detail) {
        results.innerHTML = `<h2>${escapeHtml(MailTasksUI.kind(detail))} · ${escapeHtml(MailTasksUI.status(detail))}</h2>
          ${detail.error ? `<p role="status">${escapeHtml(t(detail.error))}</p>` : ''}
          <p class="hint">${t('已确认邮件')} ${detail.updated} · ${t('结果待核实')} ${detail.uncertain}</p>
          ${detail.kind === 'rule_preview' && detail.ruleId ? `<a class="btn secondary small" href="/mail.html?rule=${detail.ruleId}">${t('查看规则预览')}</a>` : ''}
          <ul class="mail-task-results">${detail.results.map(result => `<li><strong data-i18n-skip>${escapeHtml(result.folder)}</strong> · ${t('已确认邮件')} ${result.updated} · ${t('匹配邮件')} ${result.matched} · ${t('结果待核实')} ${result.uncertain}${result.missing ? ` · ${t('邮件已移除')} ${result.missing}` : ''}${result.error ? `<p>${escapeHtml(t(result.error))}</p>` : ''}${MailTasksUI.samples(result)}</li>`).join('')}</ul>`;
      }
      schedule(data.items.some(MailTasksUI.active) || Boolean(detail && MailTasksUI.active(detail)));
    }
    async function mutate(button, action, id) {
      button.disabled = true;
      try { await Api.post(`/api/mail/tasks/${id}/${action}`); selected = id; await load(); }
      catch (error) { showError(error); button.disabled = false; }
    }
    document.getElementById('refresh-mail-tasks').addEventListener('click', () => load().catch(showError));
    window.addEventListener('pagehide', stop);
    return { show(value) { visible = value; panel.hidden = !value; if (value) load().catch(showError); else stop(); } };
  },
};
