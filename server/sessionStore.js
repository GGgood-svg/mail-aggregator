const session = require('express-session');
const { randomUUID } = require('node:crypto');
const DEVICE_FAMILIES = new Set(['Edge','Firefox','Chrome','Safari','Other']);
const DEVICE_ACTIVITY_INTERVAL = 5 * 60 * 1000;
const { db } = require('./db');

class SqliteSessionStore extends session.Store {
  constructor(database = db, { canPrune = () => true } = {}) {
    super();
    database.exec(`CREATE TABLE IF NOT EXISTS session_devices (public_id TEXT PRIMARY KEY, sid TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL, session_version INTEGER NOT NULL, device_family TEXT NOT NULL, created_at INTEGER, last_seen_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_session_devices_owner ON session_devices(user_id,session_version,last_seen_at);`);
    this.getStmt = database.prepare(`SELECT sess, expires FROM sessions WHERE sid = ?
      AND NOT EXISTS (SELECT 1 FROM session_revocations WHERE sid=? AND expires>?)`);
    this.setStmt = database.prepare(
      `INSERT INTO sessions (sid, sess, expires) SELECT ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM session_revocations WHERE sid=? AND expires>?)
       ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires`
    );
    this.touchStmt = database.prepare(`UPDATE sessions SET expires=? WHERE sid=? AND expires>?
      AND NOT EXISTS (SELECT 1 FROM session_revocations WHERE sid=? AND expires>?)`);
    this.destroyStmt = database.prepare('DELETE FROM sessions WHERE sid = ?');
    this.revokeStmt = database.prepare(`INSERT INTO session_revocations(sid,expires) VALUES(?,?)
      ON CONFLICT(sid) DO UPDATE SET expires=MAX(expires,excluded.expires)`);
    this.pruneStmt = database.prepare('DELETE FROM sessions WHERE expires < ?');
    this.pruneRevocations = database.prepare('DELETE FROM session_revocations WHERE expires < ?');
    this.pruneDevices = database.prepare('DELETE FROM session_devices WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.sid=session_devices.sid)');
    const deviceUpsert = database.prepare(`INSERT INTO session_devices(public_id,sid,user_id,session_version,device_family,created_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(sid) DO UPDATE SET last_seen_at=excluded.last_seen_at
      WHERE session_devices.last_seen_at <= excluded.last_seen_at - ${DEVICE_ACTIVITY_INTERVAL}`);
    const deleteDevice = database.prepare('DELETE FROM session_devices WHERE sid=?');
    function updateDevice(sid, data, now, inserted) {
      if (!Number.isSafeInteger(data.userId) || data.userId <= 0) return;
      deviceUpsert.run(randomUUID(), sid, data.userId, data.sessionVersion || 0,
        DEVICE_FAMILIES.has(data.deviceFamily) ? data.deviceFamily : 'Other', inserted ? now : null, now);
    }
    this.saveAndTrack = database.transaction((sid, data, now, expires) => {
      const wasPresent = this.getStmt.get(sid, sid, now);
      if (this.setStmt.run(sid, JSON.stringify(data), expires, sid, now).changes) updateDevice(sid, data, now, !wasPresent);
    });
    this.touchAndTrack = database.transaction((sid, data, now, expires) => {
      if (this.touchStmt.run(expires, sid, now, sid, now).changes) updateDevice(sid, data, now, false);
    });
    const revokeSid = sid => {
      this.revokeStmt.run(sid, Date.now() + 7 * 24 * 60 * 60 * 1000);
      this.destroyStmt.run(sid);
      deleteDevice.run(sid);
    };
    this.revoke = database.transaction(revokeSid);
    this.trackCurrent = (sid, userId, version) => {
      const now = Date.now();
      if (sid && this.getStmt.get(sid, sid, now)?.expires > now) updateDevice(sid, { userId, sessionVersion: version }, now, false);
    };
    const activeDevices = `FROM session_devices AS devices JOIN sessions ON sessions.sid=devices.sid
      WHERE devices.user_id=? AND devices.session_version=? AND sessions.expires>?`;
    const deviceByPublicId = database.prepare(`SELECT devices.sid ${activeDevices} AND public_id=?`);
    const sessionObject = `CASE WHEN json_valid(sess) THEN sess ELSE '{}' END`;
    const otherSessions = `WHERE sid<>? AND expires>? AND COALESCE(json_extract(${sessionObject},'$.sessionVersion'),0)=?
      AND (json_extract(${sessionObject},'$.userId')=? OR json_extract(${sessionObject},'$.userId')=?)`;
    const markSiblings = database.prepare(`INSERT INTO session_revocations(sid,expires) SELECT sid,? FROM sessions ${otherSessions}
      ON CONFLICT(sid) DO UPDATE SET expires=MAX(expires,excluded.expires)`);
    const deleteSiblings = database.prepare(`DELETE FROM sessions ${otherSessions}`);
    this.readDevices = database.prepare(`SELECT public_id,devices.sid,device_family,created_at,last_seen_at,expires ${activeDevices}
      ORDER BY devices.sid=? DESC,last_seen_at DESC,public_id LIMIT 100`);
    this.revokeDevice = database.transaction((userId, version, current, publicId) => {
      const device = deviceByPublicId.get(userId, version, Date.now(), publicId);
      if (!device) return 'not_found';
      if (device.sid === current) return 'current';
      revokeSid(device.sid);
      return 'revoked';
    });
    this.revokeOtherDevices = database.transaction((userId, version, current, username) => {
      const now = Date.now(), params = [current, now, version, userId, username];
      markSiblings.run(now + 7 * 24 * 60 * 60 * 1000, ...params);
      const result = deleteSiblings.run(...params);
      this.pruneDevices.run();
      return result.changes;
    });

    // 每小时清理一次过期session,避免表无限增长
    setInterval(() => {
      try {
        if (!canPrune()) return;
        this.pruneStmt.run(Date.now());
        this.pruneRevocations.run(Date.now());
        this.pruneDevices.run();
      } catch (e) {
        // 忽略清理错误,不影响主流程
      }
    }, 60 * 60 * 1000).unref();
  }

  listDevices(userId, version, current) {
    this.trackCurrent(current, userId, version);
    return this.readDevices.all(userId, version, Date.now(), current).map(row => ({ id: row.public_id,
      current: row.sid === current, browser: row.device_family, loginAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      lastSeenAt: new Date(row.last_seen_at).toISOString(), expiresAt: new Date(row.expires).toISOString() }));
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, sid, Date.now());
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sessionData, cb) {
    try {
      const maxAge = Math.min(7 * 24 * 60 * 60 * 1000,
        Math.max(0, Number(sessionData.cookie?.maxAge) || 7 * 24 * 60 * 60 * 1000));
      const now = Date.now();
      this.saveAndTrack(sid, sessionData, now, now + maxAge);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.revoke(sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  touch(sid, sessionData, cb) {
    try {
      const now = Date.now();
      const maxAge = Math.min(7 * 24 * 60 * 60 * 1000,
        Math.max(0, Number(sessionData.cookie?.maxAge) || 7 * 24 * 60 * 60 * 1000));
      this.touchAndTrack(sid, sessionData, now, now + maxAge);
      cb && cb(null);
    } catch (error) { cb && cb(error); }
  }
}

module.exports = SqliteSessionStore;
