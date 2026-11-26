window.MailRules = {
  create({ state, searchForm, t, onError, labelOptions = () => [] }) {
    const editor = document.getElementById('rule-editor'), dialog = document.getElementById('rule-dialog');
    const previewDialog = document.getElementById('rule-preview-dialog'), list = document.getElementById('rule-list');
    const filters = document.getElementById('rule-filters');
    searchForm.querySelectorAll('label:not([data-mail-attachment-filter])').forEach(label => {
      const copy = label.cloneNode(true); copy.querySelectorAll('[id]').forEach(element => element.removeAttribute('id')); filters.append(copy);
    });
    let rules = [], automaticAvailable = false, editing = null, preview = null, timer, generation = 0, controller, listGeneration = 0, listController;
    const formValue = () => {
      const { scope, attachment, attachmentName, attachmentType, ...filters } = Object.fromEntries(new FormData(searchForm));
      if ((attachment && attachment !== 'all') || attachmentName?.trim() || attachmentType?.trim()) {
        toast(t('附件筛选可保存为搜索，暂不能用于规则'), 'error'); return null;
      }
      return { name: '', action: 'seen', scope, folder: scope === 'folder' ? state.folder : null, filters };
    };
    const readRule = id => rules.find(rule => rule.id === Number(id));
    function stopPreview() { clearTimeout(timer); controller?.abort(); generation++; }
    async function load() {
      const id = ++listGeneration; listController?.abort(); listController = new AbortController();
      let data;
      try { data = await Api.get('/api/mail/rules', { signal: listController.signal }); }
      catch (error) { if (error.name === 'AbortError') return; throw error; }
      if (!data || id !== listGeneration) return;
      rules = data.rules;
      automaticAvailable = data.autoPreviewAvailable === true;
      document.getElementById('rule-auto-preview-picker').hidden = !automaticAvailable;
      document.getElementById('rule-auto-preview-help').hidden = !automaticAvailable;
      editor.elements.autoPreviewEnabled.disabled = !automaticAvailable;
      list.innerHTML = rules.map(rule => `<article class="mail-rule-card">
        <div><strong data-i18n-skip>${escapeHtml(rule.name)}</strong> · ${escapeHtml(MailTasksUI.action(rule.action))}${rule.autoPreviewEnabled ? ` · ${escapeHtml(t('同步成功后自动预览'))}` : ''}</div>
        <p class="hint" data-i18n-skip>${escapeHtml(rule.scope === 'all' ? t('所有可访问文件夹') : state.folderLabels.get(rule.folder) || rule.folder)}${rule.available ? '' : ` · ${t('文件夹不可用')}`}</p>
        <div class="mail-search-actions"><button class="btn secondary small" data-preview-rule="${rule.id}" ${rule.available ? '' : 'disabled'}>${t('重新预览')}</button>
          ${rule.latestPreviewId ? `<button class="btn secondary small" data-rule-result="${rule.id}">${t('查看预览')}</button>` : ''}
          <button class="btn secondary small" data-edit-rule="${rule.id}">${t('编辑规则')}</button><button class="btn secondary small" data-delete-rule="${rule.id}">${t('删除规则')}</button></div>
      </article>`).join('') || `<p class="hint">${t('尚未创建整理规则')}</p>`;
      list.querySelectorAll('[data-preview-rule]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try { const task = await Api.post(`/api/mail/rules/${button.dataset.previewRule}/previews`); await load(); showPreview(task, readRule(button.dataset.previewRule)); }
        catch (error) { onError(error); button.disabled = false; }
      }));
      list.querySelectorAll('[data-rule-result]').forEach(button => button.addEventListener('click', async () => {
        try { const rule = readRule(button.dataset.ruleResult); const task = await Api.get(`/api/mail/rules/${rule.id}/previews/${rule.latestPreviewId}`); showPreview(task, rule); }
        catch (error) { onError(error); }
      }));
      list.querySelectorAll('[data-edit-rule]').forEach(button => button.addEventListener('click', () => open(readRule(button.dataset.editRule))));
      list.querySelectorAll('[data-delete-rule]').forEach(button => button.addEventListener('click', async () => {
        if (!confirm(t('确认删除规则？已开始的应用任务仍可在任务中心查看。'))) return;
        button.disabled = true;
        try { await Api.del(`/api/mail/rules/${button.dataset.deleteRule}`); await load(); } catch (error) { onError(error); button.disabled = false; }
      }));
    }
    function updateScope() {
      editor.elements.folder.disabled = editor.elements.scope.value !== 'folder';
      const useLabel = editor.elements.action.value === 'label';
      document.getElementById('rule-label-picker').hidden = !useLabel;
      editor.elements.labelId.disabled = !useLabel;
      editor.elements.labelId.required = useLabel;
    }
    function open(rule = formValue()) {
      if (!rule) return;
      editing = rule.id || null;
      const paths = [...(state.availableFolders || [])]; if (rule.folder && !paths.includes(rule.folder)) paths.unshift(rule.folder);
      editor.elements.folder.replaceChildren(...paths.map(path => { const option = document.createElement('option'); option.value = path; option.textContent = state.folderLabels.get(path) || path; return option; }));
      editor.elements.labelId.replaceChildren(...labelOptions().map(label => {
        const option = document.createElement('option'); option.value = label.id; option.textContent = label.name; return option;
      }));
      for (const element of editor.elements) {
        if (!element.name || ['labelId', 'autoPreviewEnabled'].includes(element.name)) continue;
        element.value = ['name', 'action', 'scope', 'folder'].includes(element.name) ? rule[element.name] || '' : rule.filters[element.name] || (element.tagName === 'SELECT' ? 'all' : '');
      }
      editor.elements.autoPreviewEnabled.checked = automaticAvailable && rule.autoPreviewEnabled === true;
      if (rule.labelId) editor.elements.labelId.value = rule.labelId;
      if (!rule.folder) editor.elements.folder.value = paths.includes(state.folder) ? state.folder : paths[0] || '';
      document.getElementById('rule-error').textContent = ''; updateScope(); dialog.showModal(); editor.elements.name.focus();
    }
    editor.elements.scope.addEventListener('change', updateScope);
    editor.elements.action.addEventListener('change', updateScope);
    editor.addEventListener('submit', async event => {
      event.preventDefault(); const button = editor.querySelector('[type="submit"]'); button.disabled = true;
      try {
        const { name, action, scope, folder, labelId, autoPreviewEnabled, ...filters } = Object.fromEntries(new FormData(editor));
        const payload = { name, action, scope, folder: scope === 'folder' ? folder : null, filters, autoPreviewEnabled: autoPreviewEnabled === 'on', ...(action === 'label' ? { labelId } : {}) };
        if (editing) await Api.put(`/api/mail/rules/${editing}`, payload); else await Api.post('/api/mail/rules', payload);
        dialog.close(); await load(); document.getElementById('mail-rules').open = true;
      } catch (error) { document.getElementById('rule-error').textContent = t(error.message); }
      finally { button.disabled = false; }
    });
    function renderPreview(task, rule) {
      preview = { task, rule };
      document.getElementById('rule-preview-title').textContent = `${rule.name} · ${MailTasksUI.action(rule.action)}${task.automatic ? ` · ${t('同步后自动预览')}` : ''}`;
      document.getElementById('rule-preview-summary').textContent = `${MailTasksUI.status(task)} · ${t('已检查文件夹')} ${task.processedFolders} / ${task.totalFolders} · ${t('匹配邮件')} ${task.matched}`;
      document.getElementById('rule-preview-error').textContent = task.error ? t(task.error) : '';
      document.getElementById('rule-preview-results').innerHTML = task.results.map(result => `<li><span data-i18n-skip>${escapeHtml(result.folder)}</span> · ${result.matched}${result.error ? ` · ${escapeHtml(t(result.error))}` : ''}${MailTasksUI.samples(result)}</li>`).join('');
      document.getElementById('rule-preview-expiry').textContent = task.expiresAt ? `${t('预览有效期至')} ${new Date(task.expiresAt).toLocaleString(window.I18n.locale)}` : t('预览不完整时不能应用');
      if (task.restrictedFolders) document.getElementById('rule-preview-expiry').textContent = t('部分文件夹不可用，请重新预览');
      document.getElementById('cancel-rule-preview').hidden = !MailTasksUI.active(task);
      document.getElementById('resume-rule-preview').hidden = !task.resumable;
      const apply = document.getElementById('apply-rule-preview');
      apply.disabled = !task.applicationTaskId && (task.restrictedFolders || task.status !== 'completed' || new Date(task.expiresAt).getTime() <= Date.now());
      apply.textContent = t(task.applicationTaskId ? '查看应用任务' : '应用此次预览');
    }
    function showPreview(task, rule) {
      stopPreview(); renderPreview(task, rule); previewDialog.showModal(); poll();
    }
    function poll() {
      clearTimeout(timer); if (!previewDialog.open || !preview) return;
      const interval = MailTasksUI.active(preview.task) ? 1200 : 10000;
      timer = setTimeout(async () => {
        const id = generation; controller = new AbortController();
        try {
          const task = await Api.get(`/api/mail/rules/${preview.rule.id}/previews/${preview.task.id}`, { signal: controller.signal });
          if (id !== generation || !task || !previewDialog.open) return;
          renderPreview(task, preview.rule); poll();
        } catch (error) { if (error.name !== 'AbortError') { document.getElementById('rule-preview-error').textContent = t(error.message); poll(); } }
      }, interval);
    }
    document.getElementById('mail-rules').addEventListener('toggle', event => { if (event.currentTarget.open) load().catch(onError); });
    document.getElementById('create-rule').addEventListener('click', () => open());
    document.getElementById('cancel-rule-edit').addEventListener('click', () => dialog.close());
    document.getElementById('close-rule-preview').addEventListener('click', () => previewDialog.close());
    previewDialog.addEventListener('close', stopPreview);
    window.addEventListener('pagehide', () => { stopPreview(); listController?.abort(); listGeneration++; });
    document.getElementById('cancel-rule-preview').addEventListener('click', async event => {
      event.target.disabled = true;
      try { await Api.post(`/api/mail/tasks/${preview.task.id}/cancel`); } catch (error) { onError(error); }
      finally { event.target.disabled = false; }
    });
    document.getElementById('resume-rule-preview').addEventListener('click', async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        const task = await Api.post(`/api/mail/tasks/${preview.task.id}/resume`);
        if (task && previewDialog.open) { renderPreview(task, preview.rule); poll(); }
      } catch (error) { onError(error); }
      finally { button.disabled = false; }
    });
    document.getElementById('apply-rule-preview').addEventListener('click', async event => {
      event.target.disabled = true;
      try {
        const task = await Api.post(`/api/mail/rules/${preview.rule.id}/previews/${preview.task.id}/apply`);
        location.href = `/logs.html?tab=mail&task=${task.id}`;
      } catch (error) { document.getElementById('rule-preview-error').textContent = t(error.message); event.target.disabled = false; }
    });
    return { load, async showLinkedPreview() {
      const rule = readRule(new URLSearchParams(location.search).get('rule'));
      if (rule) { document.getElementById('mail-rules').open = true; if (rule.latestPreviewId) showPreview(await Api.get(`/api/mail/rules/${rule.id}/previews/${rule.latestPreviewId}`), rule); }
    } };
  },
};
