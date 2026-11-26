/* Personal mail metadata is separate from IMAP flags and remains private. */
window.MailLabelsUI = {
  create({ selectedRef, openLabel, onError, t }) {
    const list = document.getElementById('personal-label-list');
    const manager = document.getElementById('personal-label-dialog');
    const choose = document.getElementById('message-label-dialog');
    const form = document.getElementById('personal-label-editor');
    const applied = document.getElementById('message-label-options');
    const manageList = document.getElementById('personal-label-manage-list');
    let labels = [], activeId = null, editing = null, messageGeneration = 0;
    function get(id) { return labels.find(item => item.id === Number(id)); }
    function button(text, click, className = 'btn secondary small') {
      const element = document.createElement('button'); element.type = 'button'; element.className = className;
      element.textContent = text; element.addEventListener('click', click); return element;
    }
    function render() {
      list.replaceChildren(...labels.map(label => {
        const element = button(label.name, () => { activeId = label.id; render(); openLabel(label.id); }, `folder-item${activeId === label.id ? ' active' : ''}`);
        element.dataset.personalLabel = label.id; element.dataset.i18nSkip = ''; return element;
      }));
      manageList.replaceChildren(...labels.map(label => {
        const line = document.createElement('div'); line.className = 'mail-search-actions';
        const name = document.createElement('span'); name.textContent = label.name; name.dataset.i18nSkip = '';
        line.append(name, button(t('重命名标签'), () => { editing = label.id; form.elements.name.value = label.name; form.elements.name.focus(); }),
          button(t('删除标签'), async () => {
            if (!confirm(t('删除标签及其关联？邮件不会被删除。'))) return;
            try { await Api.del(`/api/mail/labels/${label.id}`); if (activeId === label.id) { activeId = null; openLabel(null); } await load(); }
            catch (error) { onError(error); }
          }));
        return line;
      }));
    }
    async function load() {
      const data = await Api.get('/api/mail/labels'); labels = data?.labels || []; render();
      document.dispatchEvent(new Event('mail-labels-loaded'));
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = form.querySelector('[type=submit]'); submit.disabled = true;
      try {
        const value = { name: form.elements.name.value };
        if (editing) await Api.put(`/api/mail/labels/${editing}`, value);
        else await Api.post('/api/mail/labels', value);
        editing = null; form.reset(); await load();
        if (activeId) openLabel(activeId);
      } catch (error) { onError(error); }
      finally { submit.disabled = false; }
    });
    document.getElementById('manage-personal-labels').addEventListener('click', () => {
      editing = null; form.reset(); manager.showModal(); form.elements.name.focus();
    });
    document.getElementById('close-personal-labels').addEventListener('click', () => manager.close());
    document.getElementById('new-personal-label').addEventListener('click', () => { editing = null; form.reset(); form.elements.name.focus(); });
    document.getElementById('close-message-labels').addEventListener('click', () => choose.close());
    choose.addEventListener('close', () => { messageGeneration++; });
    document.getElementById('edit-message-labels').addEventListener('click', async () => {
      const ref = selectedRef(), generation = ++messageGeneration;
      if (!ref.uid || !ref.folder || !ref.uidValidity) return;
      applied.textContent = t('正在加载…'); choose.showModal();
      const query = new URLSearchParams({ folder: ref.folder, uidValidity: ref.uidValidity });
      try {
        const data = await Api.get(`/api/mail/labels/messages/${ref.uid}?${query}`);
        if (generation !== messageGeneration || !choose.open) return;
        if (!data.available) { applied.textContent = t('此文件夹不支持个人标签'); return; }
        if (!labels.length) { applied.textContent = t('请先创建个人标签'); return; }
        applied.replaceChildren(...labels.map(label => {
          const row = document.createElement('label');
          const span = document.createElement('span'); span.textContent = label.name; span.dataset.i18nSkip = '';
          const input = document.createElement('input'); input.type = 'checkbox'; input.checked = data.labelIds.includes(label.id);
          input.addEventListener('change', async () => {
            const assigned = input.checked; input.disabled = true;
            try { await Api.put(`/api/mail/labels/${label.id}/messages/${ref.uid}`, { folder: ref.folder, uidValidity: ref.uidValidity, assigned }); }
            catch (error) { input.checked = !assigned; onError(error); }
            finally { input.disabled = false; }
          });
          row.append(input, span); return row;
        }));
      } catch (error) { if (generation === messageGeneration) { applied.textContent = t(error.message); onError(error); } }
    });
    return { load, get, options: () => labels, select(id) { activeId = id; render(); } };
  },
};
