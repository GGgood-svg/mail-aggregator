const { normalizeHost, isValidHost } = require('./validation');

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Remote mail images are absent from the DOM until the user explicitly opts in.
  // Referrer-Policy remains no-referrer, so loading never leaks the panel URL.
  "img-src 'self' data: https: http:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function parseTrustProxy(value) {
  if (value === undefined || value === null || String(value).trim() === '') return false;
  const text = String(value).trim().toLowerCase();
  if (['false', '0', 'off', 'none'].includes(text)) return false;
  if (['loopback', 'linklocal', 'uniquelocal'].includes(text)) return text;
  if (/^[1-9]$|^10$/.test(text)) return Number(text);
  return false;
}

function parseCookieSecure(value) {
  const text = String(value === undefined ? 'auto' : value).trim().toLowerCase();
  if (['true', '1', 'on'].includes(text)) return true;
  if (['false', '0', 'off'].includes(text)) return false;
  return 'auto';
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(text)) return true;
  if (['false', '0', 'off', 'no'].includes(text)) return false;
  return fallback;
}

function isLoopbackAddress(value) {
  const address = String(value || '').toLowerCase();
  if (address === '::1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (!/^127(?:\.\d{1,3}){3}$/.test(ipv4)) return false;
  return ipv4.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function resolveBindHost(value, fallback = '127.0.0.1') {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const host = normalizeHost(value);
  return isValidHost(host) ? host : fallback;
}

function isLoopbackBindHost(value) {
  const host = String(value || '').trim().toLowerCase();
  return host === 'localhost' || isLoopbackAddress(host);
}

function validateHttpSecurityConfig({ bindHost, trustProxy, cookieSecure, requireHttps }) {
  const errors = [];
  if (trustProxy !== false && !isLoopbackBindHost(bindHost)) {
    errors.push('启用可信代理时，MAIL_AGG_BIND_HOST 必须是本机回环地址，避免客户端伪造转发协议头');
  }
  if (requireHttps && trustProxy === false) {
    errors.push('MAIL_AGG_REQUIRE_HTTPS=true 时必须配置 MAIL_AGG_TRUST_PROXY');
  }
  if (requireHttps && cookieSecure !== true) {
    errors.push('MAIL_AGG_REQUIRE_HTTPS=true 时必须配置 MAIL_AGG_COOKIE_SECURE=true');
  }
  return errors;
}

function requireHttpsMiddleware(enabled) {
  return (req, res, next) => {
    if (!enabled || req.secure) return next();
    const message = '此管理面板只接受 HTTPS 请求，请通过已配置 TLS 的反向代理访问';
    res.status(426);
    if (String(req.path || req.url || '').startsWith('/api/')) return res.json({ error: message });
    return res.type('text/plain').send(message);
  };
}

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  if (req.secure) {
    // Do not includeSubDomains automatically: the operator may not control every
    // subdomain of the public hostname used for this panel.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  if (String(req.path || req.url || '').startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}

module.exports = {
  CSP,
  parseTrustProxy,
  parseCookieSecure,
  parseBoolean,
  isLoopbackAddress,
  isLoopbackBindHost,
  resolveBindHost,
  validateHttpSecurityConfig,
  requireHttpsMiddleware,
  securityHeaders,
};
