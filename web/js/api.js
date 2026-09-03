// CSRF token在登录/me接口返回后缓存在这个模块变量里,不落盘(不用localStorage/sessionStorage),
// 每次页面加载都通过 requireLogin() -> /api/auth/me 重新获取一次
let csrfToken = null;

function setCsrfToken(token) {
  csrfToken = token || null;
}

const Api = (() => {
  async function request(method, url, body) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401 && !url.includes('/auth/')) {
      window.location.href = '/login.html';
      return null;
    }
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      const message = (data && data.error) || `请求失败 (${res.status})`;
      const error = new Error(message);
      error.details = data;
      throw error;
    }
    return data;
  }

  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    del: (url) => request('DELETE', url),
    download: async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        body: JSON.stringify(body || {}),
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '登录或密码验证失败');
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `下载失败 (${res.status})`);
      }
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^";]+)"?/i);
      return {
        blob: await res.blob(),
        filename: match ? match[1] : 'mail-aggregator-backup.tar.gz',
        sha256: res.headers.get('X-Backup-SHA256') || '',
      };
    },
    uploadBackup: async (url, file) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        body: file,
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `上传失败 (${res.status})`);
      return data;
    },
    downloadGet: async (url, fallbackFilename) => {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `下载失败 (${res.status})`);
      }
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^";]+)"?/i);
      return {
        blob: await res.blob(),
        filename: match ? match[1] : fallbackFilename,
        sha256: res.headers.get('X-Backup-SHA256') || '',
      };
    },
  };
})();

// 所有用户可控内容(账号名称/用户名/服务器地址/错误信息等)在拼进innerHTML之前
// 必须经过这个转义,防止存储型XSS。textContent/.value赋值本身是安全的,不需要转义,
// 但只要是用模板字符串拼HTML片段再塞进innerHTML,就必须过这一道。
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message; // textContent本身安全,不需要转义
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmtTime(iso) {
  if (!iso) return '-';
  const raw = String(iso);
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(raw)
    ? raw.replace(' ', 'T')
    : raw.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return '-';
  const now = new Date();
  const diffSec = Math.max(0, Math.floor((now - d) / 1000));
  const locale = (window.I18n && window.I18n.locale) || 'zh-CN';
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  if (diffSec < 60) return relative.format(-diffSec, 'second');
  if (diffSec < 3600) return relative.format(-Math.floor(diffSec / 60), 'minute');
  if (diffSec < 86400) return relative.format(-Math.floor(diffSec / 3600), 'hour');
  return d.toLocaleString(locale);
}

function statusLabel(status) {
  const map = {
    success: '正常',
    failed: '异常',
    timed_out: '已超时',
    running: '同步中',
    queued: '排队中',
    interrupted: '已中断',
    cancelled: '已取消',
  };
  const source = map[status] || '未同步';
  return window.I18n ? window.I18n.t(source) : source;
}

async function requireLogin() {
  try {
    if (window.I18n && window.I18n.ready) await window.I18n.ready;
    const me = await Api.get('/api/auth/me');
    setCsrfToken(me.csrfToken);
    return me;
  } catch (e) {
    window.location.href = '/login.html';
  }
}

async function logout() {
  await Api.post('/api/auth/logout');
  setCsrfToken(null);
  window.location.href = '/login.html';
}

function renderNav(active) {
  const items = [
    { href: '/index.html', label: 'Dashboard', key: 'dashboard' },
    { href: '/mail.html', label: '查看邮件', key: 'mail' },
    { href: '/accounts.html', label: '邮箱账号', key: 'accounts' },
    { href: '/logs.html', label: '同步日志', key: 'logs' },
    { href: '/settings.html', label: '设置', key: 'settings' },
    { href: '/system-info.html', label: '系统信息', key: 'system-info' },
  ];
  const nav = document.getElementById('sidebar-nav');
  if (!nav) return;
  nav.innerHTML = items
    .map(
      (i) =>
        `<a href="${i.href}" class="${i.key === active ? 'active' : ''}">${window.I18n ? window.I18n.t(i.label) : i.label}</a>`
    )
    .join('') + `<a href="#" id="logout-link" style="margin-top:12px;border-top:1px solid var(--panel-border);padding-top:14px;">${window.I18n ? window.I18n.t('退出登录') : '退出登录'}</a>`;
  document.getElementById('logout-link').addEventListener('click', (e) => {
    e.preventDefault();
    logout();
  });
}
