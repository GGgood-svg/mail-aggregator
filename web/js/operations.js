/* global Api, I18n, applyBranding, requireLogin, renderNav */
'use strict';
(async () => {
  const el = id => document.getElementById(`ops-${id}`);
  const tr = text => I18n.t(text) || text;
  const node = (tag, text) => { const item = document.createElement(tag); if (text) item.textContent = text; return item; };
  const eventNames = { setup:'创建初始管理员', login:'登录', logout:'退出登录', password_changed:'修改登录密码', device_revoked:'退出单个设备',
    other_devices_revoked:'退出其他全部设备', user_created:'创建用户', user_changed:'更新用户', user_deleted:'删除用户',
    totp_login:'登录二次验证', totp_enabled:'启用双重验证', totp_recovery_rotated:'重置双重验证恢复码', totp_disabled:'停用双重验证',
    notifications_changed:'修改通知设置', backup:'下载配置备份', backup_pair:'下载配对备份', restore:'恢复配置备份', restore_point:'下载恢复快照',
    sync_requested:'请求同步', sync_retried:'请求重试同步', sync_cancelled:'请求取消同步',
    restore_result:'配置恢复结果', update_result:'应用更新结果',
    update_checked:'检查应用更新', update_settings:'修改应用更新策略', update_install:'请求安装应用更新', service_restart:'请求重启服务', service_uninstall:'请求卸载服务' };
  const outcomes = { success:'成功', accepted:'已受理', rejected:'已拒绝', failed:'失败', rolled_back:'已回退', recovery_required:'需要恢复处理' };
  const uses = { application:'应用数据', database:'数据库', credentials:'凭据', logs:'日志', cache:'缓存', temporary:'临时目录', restore_points:'恢复点', mail:'邮件存储' };
  const checks = { node:'Node.js', imapsync:'imapsync', 'dovecot-command':'Dovecot', 'imap-listener':'IMAP 监听', database:'数据库', disk:'存储容量' };
  const codes = { low_space:'可用空间不足', low_inodes:'文件节点不足', capacity_busy:'容量检查繁忙', capacity_unavailable:'无法检查容量' };
  const format = (n, unit = '') => n === null || n === undefined ? '—' : `${n.toLocaleString()}${unit}`;
  const date = time => time ? new Date(time).toLocaleString() : '—';
  applyBranding();
  const me = await requireLogin();
  if (!me) return;
  if (me.role !== 'operator' && !me.primaryAdmin) { window.location.replace('/index.html'); return; }
  renderNav('operations');

  function graph(points, index, title) {
    const figure = node('figure'); figure.style.margin = '12px 0';
    figure.append(node('figcaption', tr(title)));
    const valid = points.map(point => point?.[index] ?? null);
    const peak = Math.max(1, ...valid.filter(Number.isFinite));
    if (valid.every(v => v === null)) { figure.append(node('span', tr('此时段暂无可用读数'))); return figure; }
    const make = (tag, attrs) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k,v] of Object.entries(attrs)) svg.setAttribute(k, v);
      return svg;
    };
    const svg = make('svg', { viewBox:'0 0 400 65', width:'100%', height:80, role:'img', 'aria-label':tr(title) });
    let drawing = false;
    const edges = [], single = [];
    valid.forEach((value, i) => {
      if (value === null) { drawing = false; return; }
      const x = 5 + i * 390 / (valid.length - 1), y = 59 - value * 52 / peak;
      edges.push(`${drawing ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`);
      if (!drawing && (i === valid.length - 1 || valid[i+1] === null)) single.push([x,y]);
      drawing = true;
    });
    svg.append(make('path',{ d:'M 5 60 H 395', stroke:'var(--panel-border)', fill:'none' }));
    svg.append(make('path',{ d:edges.join(' '), stroke:'var(--accent)', 'stroke-width':2, fill:'none' }));
    for (const [x,y] of single) svg.append(make('circle',{ cx:x, cy:y, r:2, fill:'var(--accent)' }));
    figure.append(svg); return figure;
  }
  let generation = 0;
  async function refresh() {
    const mine = ++generation;
    const period = el('period').value;
    const [summary, trend] = await Promise.allSettled([Api.get('/api/operations/overview'), Api.get(`/api/operations/capacity?period=${period}`)]);
    if (generation !== mine) return;
    if (summary.status === 'fulfilled') {
      const data = summary.value;
      const health = data.health;
      el('health').textContent = health ? `${date(health.at)} · ${health.checks.map(item => `${tr(checks[item.id])}: ${tr(item.ok ? '正常' : '异常')}`).join(' · ')}` : tr('尚无近期服务检查结果');
      el('queue').textContent = `${tr('排队中')}: ${data.queue.queued} · ${tr('同步中')}: ${data.queue.running}`;
      const failures = Object.entries(data.failures).map(([code,n]) => `${code}: ${n}`);
      if (failures.length) el('queue').append(node('p', `${tr('近期失败分类')}: ${failures.join(' · ')}`));
      if (!data.storageAvailable) el('queue').append(node('p', tr('部分运维记录无法保存')));
    } else el('health').textContent = summary.reason.message;
    if (trend.status !== 'fulfilled') { el('capacity-status').textContent = trend.reason.message; return; }
    const { startAt, endAt, volumes } = trend.value;
    el('capacity-status').textContent = volumes.length ? `${date(startAt)} – ${date(endAt)}` : tr('尚无存储样本');
    el('capacity').replaceChildren(...volumes.map(({ mountId, latest, points }) => {
      const details = node('details');
      details.append(node('summary', `${latest.uses.map(use => tr(uses[use])).join(' / ')} · ${mountId.slice(0, 8)}`));
      details.append(node('p', `${tr('最近测量')}: ${date(latest.at)} · ${tr('可用空间')}: ${format(latest.availableMb,' MiB')} · ${tr('可用文件节点')}: ${format(latest.availableInodes)}${latest.code ? ` · ${tr(codes[latest.code])}` : ''}`));
      details.append(graph(points, 0, '可用空间（MiB）'), graph(points, 1, '可用文件节点'));
      return details;
    }));
  }
  el('period').addEventListener('change', refresh);
  el('refresh').addEventListener('click', refresh);
  void refresh();
  if (!me.primaryAdmin) return;
  el('audit-panel').hidden = false;
  function options(target, candidates) {
    for (const [value, name] of [['','全部'], ...Object.entries(candidates)]) {
      const option = node('option', tr(name)); option.value = value; target.append(option);
    }
  }
  options(el('event'), eventNames); options(el('outcome'), outcomes);
  let filter = new URLSearchParams(), auditRows = [], nextBefore = null, loading = false;
  async function fetchAudit(append = false) {
    if (loading) return;
    loading = true; el('audit-more').disabled = true;
    const query = new URLSearchParams(filter);
    if (append && nextBefore) query.set('before', nextBefore);
    try {
      const page = await Api.get(`/api/operations/audit?${query}`);
      auditRows = append ? [...auditRows, ...page.events] : page.events;
      el('audit-rows').replaceChildren(...auditRows.map(event => {
        const row = node('tr');
        [date(event.at), tr(eventNames[event.event]), `${tr(outcomes[event.outcome])}${event.status === null ? '' : ` (${event.status})`}${event.occurrences > 1 ? ` ×${event.occurrences}` : ''}`,
          format(event.actorId), format(event.subjectId), event.operationId || '—', event.id].forEach(text => row.append(node('td', text)));
        return row;
      }));
      nextBefore = page.nextBefore; el('audit-more').hidden = !nextBefore;
      el('audit-export').disabled = !auditRows.length;
      el('audit-status').textContent = auditRows.length ? '' : tr('没有符合条件的审计记录');
    } catch (error) { el('audit-status').textContent = error.message; }
    finally { loading = false; el('audit-more').disabled = false; }
  }
  el('audit-filter').addEventListener('submit', event => {
    event.preventDefault();
    if (loading) return;
    const next = new URLSearchParams();
    for (const [key,value] of new FormData(event.target)) if (value) {
      if (key === 'operationId' && !value.trim()) continue;
      next.set(key, ['from','to'].includes(key) ? new Date(value).getTime() : value.trim());
    }
    filter = next; void fetchAudit();
  });
  el('audit-more').addEventListener('click', () => void fetchAudit(true));
  el('audit-export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(auditRows,null,2)], { type:'application/json' }));
    const link = node('a'); link.href = url; link.download = 'mail-aggregator-audit.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  void fetchAudit();
})();
