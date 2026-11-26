'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } = require('node:crypto');

const PERIOD = 30_000;
const WINDOW = 5 * 60_000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const token = () => randomBytes(24).toString('base64url');
const fault = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
function hotp(secret, step, digits = 6) {
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(BigInt(step));
  const output = createHmac('sha1', secret).update(input).digest();
  return String((output.readUInt32BE(output.at(-1) & 15) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
function matchingStep(secret, value, now, last = -1) {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value)) return null;
  const step = Math.floor(now / PERIOD);
  const actual = Buffer.from(value);
  const matching = [step + 1, step, step - 1].filter(time => time >= 0 && timingSafeEqual(actual, Buffer.from(hotp(secret, time))));
  // A rare equal code on adjacent time steps must not permit double use.
  if (matching.some(time => time <= last)) return null;
  return matching[0] ?? null;
}
function base32(secret) {
  let rest = 0, bits = 0, result = '';
  for (const byte of secret) {
    rest = (rest << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; result += ALPHABET[(rest >> bits) & 31]; }
  }
  if (bits) result += ALPHABET[(rest << (5 - bits)) & 31];
  return result;
}
function fsyncDir(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writePrivate(filename, buffer) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function ensurePrivate(filename, directory) {
  const stat = fs.lstatSync(filename);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
      || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw fault('totp_state_unavailable', 503);
  return stat;
}
function readBounded(filename, max) {
  if (ensurePrivate(filename, false).size > max) throw fault('totp_state_unavailable', 503);
  return fs.readFileSync(filename);
}

function createTotpSecurity(root, clock = Date.now) {
  const directory = path.join(root, '.web-security');
  const statePath = path.join(directory, 'state.json');
  const keyPath = path.join(directory, 'key');
  const bootstrapMarker = path.join(root, '.web-security-configured');
  let live, key;
  const enrollment = new Map();
  const challenges = new Map();
  const empty = () => ({ version: 1, factors: {} });
  const signature = (dataKey, payload) => createHmac('sha256', dataKey).update('mail-aggregator:totp:state:v1\0').update(payload).digest();
  function pack(dataKey, value) {
    const payload = JSON.stringify(value);
    return JSON.stringify({ payload, mac: signature(dataKey, payload).toString('hex') });
  }
  function init() {
    if (live) return live;
    try { ensurePrivate(directory, true); }
    catch (error) {
      if (error.code === 'ENOENT' && !fs.existsSync(bootstrapMarker)) return empty();
      throw fault('totp_state_unavailable', 503);
    }
    try {
      key = readBounded(keyPath, 32);
      const { payload, mac } = JSON.parse(readBounded(statePath, 256 * 1024));
      if (key.length !== 32 || typeof payload !== 'string' || typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac)
          || !timingSafeEqual(signature(key, payload), Buffer.from(mac, 'hex'))) throw new Error('invalid TOTP state signature');
      const current = JSON.parse(payload);
      if (current.version !== 1 || !current.factors || Array.isArray(current.factors) || typeof current.factors !== 'object') {
        throw new Error('invalid TOTP store');
      }
      for (const [id, entry] of Object.entries(current.factors)) {
        if (!/^\d+$/.test(id) || typeof entry?.generation !== 'string' || !/^[a-zA-Z0-9_-]{32}$/.test(entry.generation)
            || (entry.secret !== null && (typeof entry.secret !== 'string' || !/^[a-zA-Z0-9_-]{64}$/.test(entry.secret)))
            || !Number.isSafeInteger(entry.lastStep) || entry.lastStep < -1 || !Array.isArray(entry.hashes)
            || entry.hashes.length > 10 || entry.hashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('invalid TOTP factor');
      }
      live = current;
      return live;
    } catch (_) { throw fault('totp_state_unavailable', 503); }
  }
  function ensureStore() {
    init();
    if (live) {
      if (!fs.existsSync(bootstrapMarker)) { writePrivate(bootstrapMarker, '1\n'); fsyncDir(root); }
      return;
    }
    const stage = fs.mkdtempSync(path.join(root, '.web-security-stage-'));
    const dataKey = randomBytes(32);
    writePrivate(path.join(stage, 'key'), dataKey);
    writePrivate(path.join(stage, 'state.json'), pack(dataKey, empty()));
    fsyncDir(stage);
    fs.renameSync(stage, directory);
    fsyncDir(root);
    writePrivate(bootstrapMarker, '1\n');
    fsyncDir(root);
    init();
  }
  function row(id) { return init().factors[id] || null; }
  function persist(id, entry) {
    ensureStore();
    const updated = { ...live, factors: { ...live.factors, [id]: entry } };
    const temporary = path.join(directory, `.new-${token()}`);
    writePrivate(temporary, pack(key, updated));
    try { fs.renameSync(temporary, statePath); }
    catch (error) { try { fs.unlinkSync(temporary); } catch (_) {} throw error; }
    // The rename is already visible even if directory fsync subsequently fails.
    live = updated;
    fsyncDir(directory);
  }
  function seal(secret, id) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`mail-aggregator:totp:${id}`));
    return Buffer.concat([iv, cipher.update(secret), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }
  function open(value, id) {
    try {
      const data = Buffer.from(value, 'base64url');
      if (data.length !== 48) throw new Error('invalid secret');
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAAD(Buffer.from(`mail-aggregator:totp:${id}`));
      cipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]);
    } catch (_) { throw fault('totp_state_unavailable', 503); }
  }
  const recoveryHash = (value, id) => createHmac('sha256', key).update(`recovery:v1:${id}:${value}`).digest('hex');
  function recovery(id) {
    const values = Array.from({ length: 10 }, () => randomBytes(16).toString('hex'));
    return { codes: values.map(code => code.match(/.{1,8}/g).join('-')), hashes: values.map(code => recoveryHash(code, id)) };
  }
  function prune(map, maximum) {
    const now = clock();
    for (const [id, item] of map) if (item.expires <= now) map.delete(id);
    while (map.size >= maximum) map.delete(map.keys().next().value);
  }
  function status(user) {
    const entry = row(user.id);
    return { enabled: Boolean(entry?.secret), generation: entry?.generation ?? null, remainingCodes: entry?.hashes.length ?? 0 };
  }
  function begin(user, sid) {
    if (row(user.id)?.secret) throw fault('totp_already_enabled');
    prune(enrollment, 20);
    const secret = randomBytes(20);
    enrollment.set(sid, { id: user.id, sessionVersion: user.session_version, secret, expires: clock() + 10 * 60_000, fails: 0 });
    const seed = base32(secret);
    return { seed, uri: `otpauth://totp/${encodeURIComponent(`Mail Aggregator:${user.username}`)}?secret=${seed}&issuer=Mail%20Aggregator&algorithm=SHA1&digits=6&period=30` };
  }
  function enable(user, sid, value) {
    const previous = row(user.id);
    if (previous?.secret) throw fault('totp_already_enabled');
    const item = enrollment.get(sid);
    if (!item || item.id !== user.id || item.sessionVersion !== user.session_version || item.expires <= clock()) throw fault('totp_setup_expired');
    const step = matchingStep(item.secret, value, clock());
    if (step === null) {
      if (++item.fails >= 5) enrollment.delete(sid);
      throw fault('totp_invalid_code', 401);
    }
    ensureStore();
    const { codes, hashes } = recovery(user.id);
    const generation = token();
    persist(user.id, { generation, secret: seal(item.secret, user.id), lastStep: step, hashes });
    enrollment.delete(sid);
    return { generation, codes };
  }
  function resolveCode(user, entry, value, allowRecovery) {
    const now = clock();
    if (entry.lockedUntil > now) throw fault('totp_rate_limited', 429);
    const step = matchingStep(open(entry.secret, user.id), value, now, entry.lastStep);
    if (step !== null) return { ...entry, lastStep: step, fails: 0, failSince: 0, lockedUntil: 0 };
    const normalized = typeof value === 'string' && value.length <= 40 ? value.replace(/-/g, '').toLowerCase() : '';
    const hash = allowRecovery && /^[a-f0-9]{32}$/.test(normalized) && recoveryHash(normalized, user.id);
    if (hash && entry.hashes.includes(hash)) return { ...entry, hashes: entry.hashes.filter(code => code !== hash), fails: 0, failSince: 0, lockedUntil: 0 };
    const since = entry.failSince > now - WINDOW ? entry.failSince : now;
    const fails = (entry.failSince === since ? entry.fails || 0 : 0) + 1;
    const lockedUntil = fails >= 5 ? now + WINDOW : 0;
    persist(user.id, { ...entry, fails, failSince: since, lockedUntil });
    throw fault(lockedUntil ? 'totp_rate_limited' : 'totp_invalid_code', lockedUntil ? 429 : 401);
  }
  function beginLogin(user, sid, ip) {
    const entry = row(user.id);
    if (!entry?.secret) throw fault('totp_login_expired', 401);
    if (entry.lockedUntil > clock()) throw fault('totp_rate_limited', 429);
    prune(challenges, 100);
    challenges.set(sid, { id: user.id, ip, sessionVersion: user.session_version, generation: entry.generation, expires: clock() + WINDOW });
  }
  function pending(sid, ip) {
    const item = challenges.get(sid);
    return item && item.expires > clock() && item.ip === ip ? item : null;
  }
  function finishLogin(user, sid, ip, value) {
    const item = pending(sid, ip), entry = row(user.id);
    if (!item || !entry?.secret || item.id !== user.id || item.sessionVersion !== user.session_version || item.generation !== entry.generation) {
      throw fault('totp_login_expired', 401);
    }
    const next = resolveCode(user, entry, value, true);
    persist(user.id, next);
    challenges.delete(sid);
    return entry.generation;
  }
  function change(user, value, disable = false) {
    const entry = row(user.id);
    if (!entry?.secret) throw fault('totp_not_enabled');
    const next = resolveCode(user, entry, value, false);
    const result = disable ? { codes: [], hashes: [] } : recovery(user.id);
    const generation = token();
    persist(user.id, { ...next, generation, secret: disable ? null : next.secret, hashes: result.hashes });
    return { generation, codes: result.codes };
  }
  function offlineDisable(user) {
    if (!row(user.id)?.secret) throw fault('totp_not_enabled');
    persist(user.id, { generation: token(), secret: null, hashes: [], lastStep: -1 });
  }
  return { status, begin, enable, beginLogin, pending, finishLogin, change, offlineDisable };
}

module.exports = { createTotpSecurity, matchingStep, hotp, base32, fault };
