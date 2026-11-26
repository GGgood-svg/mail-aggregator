'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');
const { adminCredentials } = require('../../server/admin-setup-input');
const WIZARD_PORT = 8090;
const PAIR_MS = 15 * 60_000;
const DONE_MS = 5 * 60_000;
const JOB_MS = 2 * 60 * 60_000;
const MAX_LINE = 8192;
const TOKEN = /^[0-9a-f]{64}$/;
const LANGUAGES = new Set(['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR', 'de-DE']);
const SECURITY_PROFILES = new Set(['strict', 'trusted-lan']);
const validWebPort = port => Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== WIZARD_PORT;
const validData = (data, ...keys) => Boolean(data && Object.getPrototypeOf(data) === Object.prototype
  && Object.keys(data).length === keys.length && keys.every(key => Object.hasOwn(data, key)));
const token = () => randomBytes(32).toString('hex');
const sameToken = (left, right) => Boolean(typeof left === 'string' && left.length === right?.length
  && /^[0-9a-f]+$/i.test(left) && timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii')));
const response = (status, body) => ({ status, body });
const fail = (status, error) => response(status, { error });

function installOptions(data) {
  if (!validData(data, 'username', 'password', 'webPort', 'language', 'securityProfile') || !validWebPort(data.webPort)
      || !LANGUAGES.has(data.language) || !SECURITY_PROFILES.has(data.securityProfile)) return null;
  const credentials = adminCredentials(data);
  return credentials && { ...credentials, webPort: data.webPort, language: data.language, securityProfile: data.securityProfile };
}

class InstallSession {
  constructor({ ip, preflight, start, now = Date.now }) {
    this.ip = ip;
    this.preflight = preflight;
    this.start = start;
    this.now = now;
    this.code = randomBytes(8).toString('hex').toUpperCase();
    this.deadline = now() + PAIR_MS;
    this.attempts = 0;
    this.phase = 'pairing';
    this.step = 0;
    this.webPort = 8080;
  }

  printedCode() { return this.code.match(/.{4}/g).join('-'); }
  expired() { return this.now() >= this.deadline; }

  snapshot() {
    return { phase: this.phase, step: this.step, detail: this.detail, checks: this.checks, webPort: this.webPort,
      error: this.error, csrf: this.csrf, passwordAvailable: this.phase === 'succeeded' && Boolean(this.imapPassword),
      panel: this.phase === 'succeeded' ? `http://${this.ip}:${this.webPort}/` : undefined };
  }

  handle({ op, session, csrf, data }) {
    if ((this.expired() && this.phase !== 'installing') || this.phase === 'closing') return fail(410, 'expired');
    if (op === 'pair') {
      if (this.phase !== 'pairing') return fail(409, 'paired');
      if (this.attempts >= 12) return fail(429, 'pair_limit');
      const code = validData(data, 'code') && typeof data.code === 'string' && data.code.length <= 32
        ? data.code.trim().replace(/-/g, '').toUpperCase() : '';
      if (!sameToken(code, this.code)) {
        this.attempts++;
        return fail(401, 'wrong_code');
      }
      this.session = token();
      this.csrf = token();
      this.phase = 'configure';
      this.deadline = this.now() + PAIR_MS;
      this.code = null;
      return { ...response(200, this.snapshot()), cookie: this.session };
    }
    if (!sameToken(session, this.session)) return fail(401, 'pair_required');
    if (op === 'status') return response(200, this.snapshot());
    if (!sameToken(csrf, this.csrf)) return fail(403, 'csrf');

    if (op === 'preflight' || op === 'install') {
      if (this.phase !== 'configure') return fail(409, 'already_started');
      const options = op === 'install' ? installOptions(data) : null;
      if (op === 'install' ? !options : !validData(data, 'webPort') || !validWebPort(data.webPort)) {
        return fail(400, 'invalid_options');
      }
      this.webPort = data.webPort;
      this.checks = this.preflight(data.webPort);
      if (op === 'preflight') return response(200, this.snapshot());
      if (!this.checks.every(item => item.ok)) return response(409, { ...this.snapshot(), error: 'preflight_blocked' });
      this.phase = 'installing';
      this.deadline = this.now() + JOB_MS;
      this.imapPassword = randomBytes(16).toString('hex');
      try { this.start(options, this.imapPassword); }
      catch (_) { this.complete(false, 'installer_unavailable'); }
      return response(202, this.snapshot());
    }
    if (!validData(data)) return fail(400, 'invalid_options');
    if (op === 'reveal') {
      if (this.phase !== 'succeeded' || !this.imapPassword) return fail(409, 'password_unavailable');
      const password = this.imapPassword;
      this.imapPassword = null;
      return response(200, { user: 'mailuser', password });
    }
    if (op === 'finish' && (this.phase === 'succeeded' || this.phase === 'failed')) {
      this.clear();
      this.phase = 'closing';
      return { ...response(200, { ok: true }), close: true };
    }
    return fail(409, 'not_available');
  }

  progress(step, detail) {
    if (this.phase !== 'installing') return;
    if (step === this.step + 1 && step <= 9) { this.step = step; this.detail = undefined; }
    else if (step === this.step) this.detail = detail;
  }

  complete(ok, error = 'install_failed') {
    if (this.phase !== 'installing') return;
    this.phase = ok ? 'succeeded' : 'failed';
    this.error = ok ? undefined : error;
    if (!ok) this.imapPassword = null;
    this.deadline = this.now() + DONE_MS;
  }

  clear() { this.code = this.session = this.csrf = this.imapPassword = null; }
}

// The private pipe carries bounded JSON records; a malformed line stops the peer.
function receiveLines(stream, onLine, onInvalid, limit = MAX_LINE) {
  let pending = Buffer.alloc(0), invalid = false;
  stream.on('data', chunk => {
    if (invalid) return;
    try {
      let start = 0;
      while (start < chunk.length) {
        const next = chunk.indexOf(10, start);
        const end = next === -1 ? chunk.length : next;
        if (pending.length + end - start > limit) throw Error('oversize frame');
        pending = Buffer.concat([pending, chunk.subarray(start, end)]);
        if (next === -1) return;
        const line = pending.toString('utf8');
        pending = Buffer.alloc(0);
        onLine(line);
        start = next + 1;
      }
    } catch (_) { invalid = true; onInvalid(); }
  });
}

const send = (stream, value) => stream.write(`${JSON.stringify(value)}\n`);
module.exports = { InstallSession, WIZARD_PORT, validWebPort, installOptions, TOKEN, MAX_LINE, receiveLines, send };
