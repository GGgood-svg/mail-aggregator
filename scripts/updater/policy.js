'use strict';
const { ensure, TARGET } = require('./release');
const DAY = 86400000;
const MINUTE = 60000;
const RETRY = 15 * MINUTE;
const defaults = { mode: 'check', channel: 'stable', start: '03:00', end: '05:00', timezone: 'UTC' };
const hhmm = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
function formatter(zone) { return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
function settings(value) {
  ensure(value && ['off', 'check', 'auto'].includes(value.mode) && ['stable', 'preview'].includes(value.channel)
    && typeof value.start === 'string' && hhmm.test(value.start) && typeof value.end === 'string' && hhmm.test(value.end) && value.start !== value.end
    && typeof value.timezone === 'string' && /^[A-Za-z0-9_+./-]{1,80}$/.test(value.timezone), 'invalid_settings');
  try { formatter(value.timezone).format(0); } catch (_) { ensure(false, 'invalid_timezone'); }
  const { mode, channel, start, end, timezone } = value;
  const skipTag = value.skipTag ?? null;
  const holdUntil = value.holdUntil ?? null;
  ensure(skipTag === null || typeof skipTag === 'string' && TARGET.test(skipTag), 'invalid_skip_version');
  ensure(holdUntil === null || Number.isSafeInteger(holdUntil) && holdUntil > 0 && holdUntil <= 8.64e15, 'invalid_hold_time');
  return { mode, channel, start, end, timezone, skipTag, holdUntil };
}
function within(value, clock, fmt = formatter(value.timezone)) {
  const time = fmt.format(clock);
  return value.start < value.end ? time >= value.start && time < value.end : time >= value.start || time < value.end;
}
function nextWindow(value, after) {
  const fmt = formatter(value.timezone);
  if (within(value, after, fmt)) return after;
  const first = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  // Check actual instants so DST gaps and repeated wall-clock hours are honored.
  for (let time = first; time < first + 3 * DAY; time += MINUTE) if (within(value, time, fmt)) return time;
  return after + DAY;
}
function patchSettings(current, value, candidateTag, now = Date.now()) {
  const next = settings({ ...current, ...Object.fromEntries(Object.entries(value || {}).filter(([, field]) => field !== undefined)) });
  if (next.skipTag !== current.skipTag && next.skipTag !== null) ensure(next.skipTag === candidateTag, 'invalid_skip_version');
  if (next.holdUntil !== current.holdUntil && next.holdUntil !== null) {
    ensure(next.holdUntil > now && next.holdUntil <= now + 180 * DAY, 'invalid_hold_time');
  }
  return next;
}
function autoStatus(value, tag, time, earliest = time) {
  if (!tag || value.mode !== 'auto') return { reason: null, at: null };
  if (value.skipTag === tag) return { reason: 'version_skipped', at: null };
  const held = value.holdUntil > time;
  return { reason: held ? 'auto_paused' : null, at: nextWindow(value, Math.max(time, earliest, value.holdUntil || 0)) };
}
function allowAutomatic(value, tag, time) {
  return value.mode === 'auto' && value.skipTag !== tag && !(value.holdUntil > time) && within(value, time);
}
module.exports = { DAY, RETRY, defaults, settings, within, nextWindow, patchSettings, autoStatus, allowAutomatic };
