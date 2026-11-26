/* Saved searches are views over the current user's folders, never copied mail. */
window.MailSearches = {
  create({ state, form, api, t, escapeHtml, apply, onError }) {
    let searches = [], generation = 0, controller, editing = null;
    const list = document.getElementById('saved-search-list');
    const dialog = document.getElementById('saved-search-dialog');
    const editor = document.getElementById('saved-search-editor');
    const name = editor.elements.name;
    const scope = editor.elements.scope, folder = editor.elements.folder;
    const unavailable = search => search.scope === 'folder' && (!search.available
      || (state.availableFolders && !state.availableFolders.has(search.folder)));
    const currentValue = () => {
      const { scope, ...filters } = Object.fromEntries(new FormData(form));
      return { scope, folder: scope === 'folder' ? state.folder : null, filters };
    };
    function render() {
      document.getElementById('starred-view').classList.toggle('active', state.smartKind === 'starred');
      document.getElementById('update-saved-search').hidden = !searches.some(search => search.id === state.savedSearchId);
      list.innerHTML = searches.map(search => `<div class="saved-search-row">
        <button class="folder-item ${search.id === state.savedSearchId ? 'active' : ''}" type="button" data-open-search="${search.id}">
          <span class="folder-name" data-i18n-skip>${escapeHtml(search.name)}</span>${unavailable(search) ? `<small>${escapeHtml(t('文件夹不可用'))}</small>` : ''}
        </button>
        <button class="btn secondary small" type="button" data-rename-search="${search.id}" aria-label="${escapeHtml(t('编辑搜索'))}">✎</button>
        <button class="btn secondary small" type="button" data-delete-search="${search.id}" aria-label="${escapeHtml(t('删除搜索'))}">×</button>
      </div>`).join('') || `<div class="hint">${escapeHtml(t('尚未保存搜索'))}</div>`;
      list.querySelectorAll('[data-open-search]').forEach(button => button.addEventListener('click', () => {
        const search = searches.find(item => item.id === Number(button.dataset.openSearch));
        apply(search, { savedSearchId: search.id }); render();
      }));
      list.querySelectorAll('[data-rename-search]').forEach(button => button.addEventListener('click', () => {
        const search = searches.find(item => item.id === Number(button.dataset.renameSearch));
        open({ ...search, filters: { ...search.filters } }, search.id);
      }));
      list.querySelectorAll('[data-delete-search]').forEach(button => button.addEventListener('click', async () => {
        if (!confirm(t('确认删除这个保存的搜索？邮件不会被删除。'))) return;
        button.disabled = true;
        try {
          const id = Number(button.dataset.deleteSearch);
          await api.del(`/api/mail/saved-searches/${id}`);
          if (state.savedSearchId === id) { state.savedSearchId = null; state.smartKind = null; }
          await load();
        } catch (error) { onError(error); button.disabled = false; }
      }));
    }
    async function load() {
      const id = ++generation; controller?.abort(); controller = new AbortController();
      const data = await api.get('/api/mail/saved-searches', { signal: controller.signal });
      if (id !== generation || !data) return;
      searches = data.searches; render();
    }
    function open(value, id = null) {
      editing = { value, id };
      name.value = value.name || '';
      scope.value = value.scope;
      const paths = [...(state.availableFolders || [])];
      if (value.folder && !paths.includes(value.folder)) paths.unshift(value.folder);
      folder.replaceChildren(...paths.map(path => {
        const option = document.createElement('option'); option.value = path;
        option.textContent = (state.folderLabels.get(path) || path) + (state.availableFolders?.has(path) ? '' : ` (${t('文件夹不可用')})`);
        return option;
      }));
      folder.value = value.folder || (paths.includes(state.folder) ? state.folder : paths[0] || '');
      updateScope();
      document.getElementById('saved-search-error').textContent = '';
      dialog.showModal(); name.focus();
    }
    editor.addEventListener('submit', async event => {
      event.preventDefault();
      const button = editor.querySelector('[type="submit"]'); button.disabled = true;
      const { value, id } = editing;
      try {
        const payload = { name: name.value, scope: scope.value, folder: scope.value === 'folder' ? folder.value : null, filters: value.filters };
        const saved = id ? await api.put(`/api/mail/saved-searches/${id}`, payload)
          : await api.post('/api/mail/saved-searches', payload);
        dialog.close(); await load();
        if (id && id === state.savedSearchId) { apply(saved, { savedSearchId: id }); render(); }
      } catch (error) { document.getElementById('saved-search-error').textContent = t(error.message); }
      finally { button.disabled = false; }
    });
    document.getElementById('cancel-saved-search').addEventListener('click', () => dialog.close());
    function updateScope() {
      folder.disabled = scope.value !== 'folder';
      document.getElementById('saved-search-scope').textContent = scope.value === 'folder'
        ? `${t('单个文件夹')}：${folder.value}` : t('所有可访问文件夹');
    }
    scope.addEventListener('change', updateScope); folder.addEventListener('change', updateScope);
    document.getElementById('save-search').addEventListener('click', () => open(currentValue()));
    document.getElementById('update-saved-search').addEventListener('click', () => {
      const active = searches.find(item => item.id === state.savedSearchId);
      if (active) open({ ...currentValue(), name: active.name }, active.id);
    });
    document.getElementById('starred-view').addEventListener('click', () => {
      apply({ scope: 'all', filters: { flagged: 'starred' } }, { starred: true }); render();
    });
    function title(fallback) {
      return searches.find(item => item.id === state.savedSearchId)?.name || (state.smartKind === 'starred' ? t('星标邮件') : fallback);
    }
    return { load, render, title, clear() { state.savedSearchId = null; state.smartKind = null; render(); } };
  },
};
