'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { listen } = require('../scripts/updater/rpc');
const { requestActivity } = require('./update-activity');

function createUpdateGate({ journal, pending, control, version, database, busy, pause, resume }) {
  let active = 0, held = false, listener, timer;
  function blocked() { return pending ? pending() : Boolean(journal && fs.existsSync(journal)); }
  function transition() {
    const desired = blocked();
    if (held === desired) return desired;
    held = desired;
    if (held) pause(); else resume();
    return held;
  }
  function middleware(req, res, next) {
    if (!journal) return next();
    if (transition()) return res.status(503).json({ error: '应用正在维护，请稍后重试', code: 'update_maintenance' });
    const admission = req[requestActivity] = { closed: false, enter() { active++; return () => active--; } };
    const done = admission.enter();
    const exit = () => { if (!admission.closed) { admission.closed = true; done(); } };
    res.once('finish', exit);
    res.once('close', exit);
    next();
  }
  async function start(server) {
    if (!control) { if (!transition()) resume(); return; }
    // The service-specific runtime directory is created by the unit, owned by
    // mailadmin; a root-owned updater reads only this small fixed response.
    try {
      if (fs.lstatSync(control).isSocket()) fs.unlinkSync(control);
      else throw new Error('update control path is not a socket');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    listener = await listen(control, async command => {
      if (command?.op !== 'probe') return {};
      const paused = transition();
      const addr = server.address();
      let ready = false;
      if (addr && typeof addr !== 'string') {
        const host = addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address === '::' ? '::1' : addr.address;
        ready = await new Promise(resolve => {
          const client = net.connect(addr.port, host);
          client.setTimeout(1500);
          const finish = value => { client.destroy(); resolve(value); };
          client.once('connect', () => finish(true)); client.once('error', () => finish(false)); client.once('timeout', () => finish(false));
        });
      }
      return { version, paused, ready: ready && database(), idle: ready && isIdle() };
    });
    fs.chmodSync(control, 0o600);
    if (!transition()) resume();
    timer = setInterval(transition, 500);
    timer.unref();
  }
  function isIdle() { return transition() && active === 0 && !busy(); }
  return { middleware, start, blocked, isIdle,
    close() { if (timer) clearInterval(timer); listener?.close(); } };
}
module.exports = { createUpdateGate };
