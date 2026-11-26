'use strict';
(function () {
  const find = id => document.getElementById(`backup-pair-${id}`);
  const input = find('file');
  if (!input) return;
  const pageSize = 25;
  const maxAccounts = 2000;
  const maxBytes = 4 * 1024 * 1024;
  const hex = /^[a-f0-9]{64}$/;
  const id = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  const coverage = { covered:'已覆盖', outside_snapshot:'不在快照内', unmapped:'无法定位独立目录',
    name_conflict:'目录名冲突', root_not_found:'未找到目录' };
  const comparison = { no_current_match:'当前配置无匹配', same_scope_and_source:'目录与来源相符', name_conflict:'目录名冲突' };
  const status = find('status');
  const translate = text => window.I18n?.t(text) || text;
  const nonnegative = number => Number.isSafeInteger(number) && number >= 0;
  const text = (value, max) => typeof value === 'string' && value.length <= max;
  const dated = value => text(value, 32) && Number.isFinite(Date.parse(value));
  let report = null, page = 0, generation = 0;

  function validate(parsed) {
    if (parsed?.format !== 1 || parsed.verified !== true || !text(parsed.backupSetId,36) || !id.test(parsed.backupSetId)
        || !text(parsed.application?.sha256,64) || !hex.test(parsed.application.sha256)
        || !text(parsed.maildir?.sha256,64) || !hex.test(parsed.maildir.sha256)
        || !dated(parsed.captureStart) || !dated(parsed.captureEnd) || !nonnegative(parsed.appFileCount)
        || !text(parsed.application.version,32) || !text(parsed.snapshot?.id,160) || !nonnegative(parsed.unmappedMessages)
        || !Array.isArray(parsed.accounts) || parsed.accounts.length > maxAccounts) throw new Error('invalid report');
    const ids = new Set();
    const accounts = parsed.accounts.map(row => {
      if (!row || !nonnegative(row.id) || row.id === 0 || ids.has(row.id) || !text(row.name,256)
          || (row.root !== null && !text(row.root,128)) || !nonnegative(row.messages) || !Object.hasOwn(coverage,row.scope)) throw new Error('invalid account');
      ids.add(row.id);
      return { id: row.id, name: row.name, root: row.root, mailCount: row.messages, scope: coverage[row.scope] };
    });
    const compared = new Map();
    if (parsed.localComparison !== undefined) {
      if (!Array.isArray(parsed.localComparison) || parsed.localComparison.length !== accounts.length) throw new Error('invalid comparison');
      for (const row of parsed.localComparison) {
        if (!row || !ids.has(row.backupAccountId) || compared.has(row.backupAccountId) || !Object.hasOwn(comparison,row.status)) throw new Error('invalid comparison');
        compared.set(row.backupAccountId, comparison[row.status]);
      }
    }
    return { accounts, compared, details: [
      ['备份组编号',parsed.backupSetId], ['快照标识',parsed.snapshot.id], ['归档版本',parsed.application.version],
      ['备份时间',`${parsed.captureStart} – ${parsed.captureEnd}`], ['应用归档 SHA-256',parsed.application.sha256],
      ['邮件归档 SHA-256',parsed.maildir.sha256], ['未归入账号的归档邮件数',parsed.unmappedMessages],
    ] };
  }

  function element(tag, value) {
    const node = document.createElement(tag); node.textContent = String(value); return node;
  }
  function render() {
    find('report').hidden = !report;
    find('clear').hidden = !input.value;
    const rows = find('accounts'); rows.replaceChildren();
    const details = find('details'); details.replaceChildren();
    if (!report) return;
    for (const [label, value] of report.details) {
      const data = element('dd', value); data.style.overflowWrap = 'anywhere';
      details.append(element('dt',translate(label)), data);
    }
    const start = page * pageSize;
    const end = Math.min(start + pageSize,report.accounts.length);
    for (const account of report.accounts.slice(start,end)) {
      const row = document.createElement('tr');
      for (const cell of [account.id,account.name,account.root ?? '—',translate(account.scope),account.mailCount,
        report.compared.has(account.id) ? translate(report.compared.get(account.id)) : '—']) row.append(element('td',cell));
      rows.append(row);
    }
    find('pagination').hidden = report.accounts.length <= pageSize;
    find('page').textContent = `${start + 1}–${end} / ${report.accounts.length}`;
    find('previous').disabled = page === 0;
    find('next').disabled = end >= report.accounts.length;
  }
  input.addEventListener('change', async () => {
    const current = ++generation;
    report = null; page = 0; render(); status.textContent = '';
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (!file.size || file.size > maxBytes) throw new Error('file size');
      const parsed = validate(JSON.parse(await file.text()));
      if (current !== generation) return;
      report = parsed; render();
      status.textContent = translate('已读取本机报告。请依据离线校验和演练结果决定下一步。');
    } catch (_) {
      if (current === generation) status.textContent = translate('无法读取报告。请选择配对备份工具生成的规划 JSON。');
    }
  });
  find('clear').addEventListener('click', () => {
    generation++; input.value = ''; report = null; page = 0; render(); status.textContent = ''; input.focus();
  });
  find('previous').addEventListener('click', () => { if (report && page > 0) { page--; render(); } });
  find('next').addEventListener('click', () => { if (report && (page + 1) * pageSize < report.accounts.length) { page++; render(); } });
})();
