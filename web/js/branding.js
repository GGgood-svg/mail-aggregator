// 拉取branding配置并应用到当前页面。登录页在未登录状态下也需要这个,
// 所以 /api/branding 是公开接口,这里不经过requireLogin()那套鉴权流程。
async function applyBranding() {
  let branding = {};
  try {
    branding = await fetch('/api/branding', { credentials: 'same-origin' }).then((r) => r.json());
  } catch (e) {
    // 拉取失败就用页面里已经写好的默认文案,不影响页面其它功能
    return;
  }

  if (branding.browser_title) {
    document.title = branding.browser_title;
  }

  const sidebarBrand = document.getElementById('sidebar-brand-text');
  if (sidebarBrand && branding.sidebar_title) {
    sidebarBrand.textContent = branding.sidebar_title; // textContent安全,不需要escapeHtml
  }

  const loginTitle = document.getElementById('login-title-text');
  if (loginTitle && branding.login_title) {
    loginTitle.textContent = branding.login_title;
  }

  const appSubtitle = document.getElementById('app-subtitle-text');
  if (appSubtitle && branding.app_subtitle) {
    appSubtitle.textContent = branding.app_subtitle;
  }

  const footer = document.getElementById('footer-text');
  if (footer) {
    footer.textContent = branding.footer_text || '';
  }

  return branding;
}
// 注意: 这里不自动调用applyBranding(),由每个页面自己在合适的时机调用
// (比如login.html需要先套用branding,再根据是否是首次建管理员这个业务逻辑
// 决定要不要覆盖标题文案,调用时机由页面自己控制更清晰,不产生竞态)。
