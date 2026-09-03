const session = require('express-session');
const { db } = require('./db');

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this.getStmt = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare(
      `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires`
    );
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires < ?');

    // 每小时清理一次过期session,避免表无限增长
    setInterval(() => {
      try {
        this.pruneStmt.run(Date.now());
      } catch (e) {
        // 忽略清理错误,不影响主流程
      }
    }, 60 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge
        ? sessionData.cookie.maxAge
        : 1000 * 60 * 60 * 24 * 7;
      const expires = Date.now() + maxAge;
      this.setStmt.run(sid, JSON.stringify(sessionData), expires);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  touch(sid, sessionData, cb) {
    this.set(sid, sessionData, cb);
  }
}

module.exports = SqliteSessionStore;
