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

function isLoopbackAddress(value) {
  const address = String(value || '').toLowerCase();
  if (address === '::1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (!/^127(?:\.\d{1,3}){3}$/.test(ipv4)) return false;
  return ipv4.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function resolveBindHost(value, fallback = '0.0.0.0') {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const host = normalizeHost(value);
  return isValidHost(host) ? host : fallback;
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
  isLoopbackAddress,
  resolveBindHost,
  securityHeaders,
};
