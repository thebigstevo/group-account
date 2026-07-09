const session = require('express-session');

class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        expires INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) {
        this.destroy(sid, () => callback(null, null));
        return;
      }
      callback(null, JSON.parse(row.data));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 86400000;
      this.db.prepare(`
        INSERT INTO sessions (sid, expires, data)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET
          expires = excluded.expires,
          data = excluded.data
      `).run(sid, expires, JSON.stringify(sess));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

module.exports = SQLiteSessionStore;
