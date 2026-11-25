const { Store } = require("express-session");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class SqliteSessionStore extends Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
    `);
    this.getStmt = db.prepare("SELECT sess, expire FROM sessions WHERE sid = ?");
    this.setStmt = db.prepare(`
      INSERT INTO sessions (sid, sess, expire)
      VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
    `);
    this.destroyStmt = db.prepare("DELETE FROM sessions WHERE sid = ?");
    db.prepare("DELETE FROM sessions WHERE expire <= ?").run(Date.now());
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);
      if (!row) return callback(null, null);
      if (row.expire <= Date.now()) {
        this.destroyStmt.run(sid);
        return callback(null, null);
      }
      const sess = JSON.parse(row.sess);
      if (sess?.cookie?.expires) sess.cookie.expires = new Date(sess.cookie.expires);
      callback(null, sess);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), sessionExpiry(sess));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      this.destroyStmt.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback) {
    this.set(sid, sess, callback);
  }
}

function sessionExpiry(sess) {
  const expires = sess?.cookie?.expires;
  if (expires) {
    const time = new Date(expires).getTime();
    if (Number.isFinite(time)) return time;
  }
  const maxAge = sess?.cookie?.maxAge;
  if (Number.isFinite(maxAge) && maxAge > 0) return Date.now() + maxAge;
  return Date.now() + SESSION_TTL_MS;
}

module.exports = { SESSION_TTL_MS, SqliteSessionStore };
