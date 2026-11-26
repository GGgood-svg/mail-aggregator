/* global Api, I18n */
'use strict';
function initNotificationHistory() {
  const target = document.getElementById('notification-save-btn');
  if (!target) return;
  const t = source => I18n.t(source) || source;
  const make = (tag, text = '') => { const item = document.createElement(tag); item.textContent = text; return item; };
  const area = make('details'); const status = make('p'); const rows = make('ul');
  const refresh = make('button', t('刷新投递记录')); const more = make('button', t('更早的投递记录'));
  const types = { 'sync.recovered': '同步已恢复', 'sync.failed': '同步失败', 'capacity.low': '存储容量不足', 'capacity.recovered': '存储容量已恢复', 'restore.committed':'配置恢复完成', 'restore.rolled_back':'配置恢复已回退',
    'update.installed':'应用更新已安装', 'update.rolled_back':'应用更新已回退', 'update.failed':'应用更新失败' };
  const names = { queued: '待发送', retrying: '等待重试', sending: '正在投递', sent: '已投递', failed: '投递失败',
    suppressed: '未发送', uncertain: '投递结果需核对' };
  let nextBefore = null, loading = false;
  status.className = 'hint'; status.setAttribute('role', 'status');
  for (const button of [refresh, more]) { button.type = 'button'; button.className = 'btn secondary'; }
  area.append(make('summary', t('通知投递记录')), status, rows, refresh, more);
  more.hidden = true;
  target.parentElement.append(area);
  async function fetchRows(append = false) {
    if (loading) return;
    refresh.disabled = more.disabled = loading = true;
    try {
      const after = append && nextBefore ? `&before=${encodeURIComponent(nextBefore)}` : '';
      const page = await Api.get(`/api/notifications/history?limit=25${after}`);
      if (!append) rows.replaceChildren();
      for (const item of page.events || []) {
        const isSync = item.event === 'sync.failed' || item.event === 'sync.recovered';
        const hasJobId = isSync && Number.isSafeInteger(item.jobId) && item.jobId > 0;
        const subject = item.operation ? `${t('操作编号')} ${item.operation.id.slice(0, 8)}${item.operation.to ? ` (${item.operation.from} -> ${item.operation.to})` : ''}`
          : item.mount ? `${t('存储卷')} ${item.mount.id.slice(0, 8)}` : hasJobId ? `${t('同步任务')} #${item.jobId}` : '';
        const type = t(types[item.event] || '状态未知');
        const due = item.nextAttemptAt ? ` · ${t('下次尝试')}: ${new Date(item.nextAttemptAt).toLocaleString()}` : '';
        const row = make('li', `${new Date(item.occurredAt).toLocaleString()} · `);
        const canOpen = hasJobId && item.jobLinkAvailable === true && typeof item.eventId === 'string' && /^[a-f0-9-]{36}$/.test(item.eventId);
        if (canOpen) {
          const link = make('a', `${t('查看同步任务')} #${item.jobId}`);
          link.href = `/logs.html?job=${item.jobId}&event=${encodeURIComponent(item.eventId)}`;
          row.append(link, ' · ');
        } else if (subject) row.append(subject, ' · ');
        row.append(`${type} · ${t(names[item.state] || '状态未知')}${due}`);
        if (hasJobId && !canOpen) row.append(make('div', t('相关同步任务已不可用或当前账号无权查看。')));
        row.append(make('div', `${t('事件编号')}: ${item.eventId}${item.deliveryCode ? ` · ${item.deliveryCode}` : ''}`));
        rows.append(row);
      }
      nextBefore = page.nextBefore;
      more.hidden = !nextBefore;
      status.textContent = rows.childElementCount ? '' : t('暂无投递记录');
    } catch (error) { status.textContent = error.message; }
    finally { refresh.disabled = more.disabled = loading = false; }
  }
  area.addEventListener('toggle', () => { if (area.open) void fetchRows(); });
  refresh.addEventListener('click', () => void fetchRows());
  more.addEventListener('click', () => void fetchRows(true));
}
