/* global Api, I18n */
'use strict';
function initProfileDevices() {
  const el = id => document.getElementById(id);
  const t = text => I18n.t(text) || text;
  const view = el('devices'), message = el('device-msg'), refresh = el('refresh-devices'), all = el('revoke-other-devices');
  const showDate = time => time ? new Date(time).toLocaleString() : t('未记录');
  let busy = false;
  async function work(run) {
    if (busy) return;
    busy = true; refresh.disabled = all.disabled = true; message.textContent = '';
    try {
      if (run) await run();
      const { devices } = await Api.get('/api/auth/devices');
      view.replaceChildren(...devices.map(device => {
        const row = document.createElement('li');
        row.textContent = `${t(device.browser === 'Other' ? '未知浏览器' : device.browser)} ${device.current ? `(${t('当前会话')})` : ''} · `
          + `${t('登录时间')}: ${showDate(device.loginAt)} · ${t('最近活动')}: ${showDate(device.lastSeenAt)} · ${t('有效期至')}: ${showDate(device.expiresAt)} `;
        if (!device.current) {
          const revoke = document.createElement('button');
          revoke.className = 'btn secondary'; revoke.type = 'button'; revoke.textContent = t('退出此设备');
          revoke.addEventListener('click', () => {
            if (window.confirm(t('确认退出此设备？'))) void work(() => Api.del(`/api/auth/devices/${encodeURIComponent(device.id)}`));
          });
          row.append(revoke);
        }
        return row;
      }));
      if (!devices.length) message.textContent = t('没有可显示的登录设备');
      else if (run) message.textContent = t('已更新登录设备');
    } catch (error) { message.textContent = error.message; }
    finally { busy = false; refresh.disabled = all.disabled = false; }
  }
  refresh.addEventListener('click', () => void work());
  all.addEventListener('click', () => {
    if (window.confirm(t('确认退出其他所有设备？'))) void work(() => Api.post('/api/auth/devices/revoke-others', {}));
  });
  void work();
}
