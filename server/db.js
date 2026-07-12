import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "aide-memoire.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    timezone      TEXT DEFAULT 'America/Toronto',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS entries (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,
    name        TEXT NOT NULL,
    occasion    TEXT NOT NULL DEFAULT 'birthday',
    date        TEXT NOT NULL,
    yearly      INTEGER NOT NULL DEFAULT 1,
    todo        TEXT DEFAULT '',
    remind_days INTEGER NOT NULL DEFAULT 7,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sent_reminders (
    entry_id        TEXT NOT NULL,
    occurrence_date TEXT NOT NULL,
    sent_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (entry_id, occurrence_date)
  );
`);

// migrations (each is a no-op if the column already exists)
try { db.exec("ALTER TABLE entries ADD COLUMN user_id TEXT"); } catch { /* exists */ }
try { db.exec("ALTER TABLE entries ADD COLUMN relationship TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE entries ADD COLUMN notes TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'trial'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN trial_ends TEXT"); } catch { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN stripe_customer TEXT"); } catch { /* exists */ }
db.exec(`CREATE TABLE IF NOT EXISTS calendar_accounts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,           -- 'google' | 'microsoft'
  label         TEXT DEFAULT '',
  access_token  TEXT NOT NULL,
  refresh_token TEXT DEFAULT '',
  expires_at    INTEGER DEFAULT 0,       -- epoch ms
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
)`);
try { db.exec("ALTER TABLE users ADD COLUMN ics_url TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN feed_token TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'beta'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN stripe_customer TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
  user_id TEXT NOT NULL, endpoint TEXT NOT NULL, sub_json TEXT NOT NULL,
  PRIMARY KEY (user_id, endpoint))`); } catch { /* exists */ }

export const Users = {
  setPhone: (id, phone) => db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone, id),
  setPlan: (id, plan) => db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, id),
  setStripeCustomer: (id, cust) => db.prepare("UPDATE users SET stripe_customer = ? WHERE id = ?").run(cust, id),
  byStripeCustomer: (cust) => db.prepare("SELECT * FROM users WHERE stripe_customer = ?").get(cust),
  setTrialEnds: (id, iso) => db.prepare("UPDATE users SET trial_ends = ? WHERE id = ?").run(iso, id),
  setIcs: (id, url) => db.prepare("UPDATE users SET ics_url = ? WHERE id = ?").run(url, id),
  setFeedToken: (id, t) => db.prepare("UPDATE users SET feed_token = ? WHERE id = ?").run(t, id),
  byFeedToken: (t) => db.prepare("SELECT * FROM users WHERE feed_token = ?").get(t),
  setPlan: (id, plan) => db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, id),
  setStripeCustomer: (id, c) => db.prepare("UPDATE users SET stripe_customer = ? WHERE id = ?").run(c, id),
  byStripeCustomer: (c) => db.prepare("SELECT * FROM users WHERE stripe_customer = ?").get(c),
  byEmail: (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()),
  byId: (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id),
  count: () => db.prepare("SELECT COUNT(*) n FROM users").get().n,
  create: (u) => db.prepare("INSERT INTO users (id, email, password_hash, timezone) VALUES (@id, @email, @password_hash, @timezone)").run(u),
  all: () => db.prepare("SELECT * FROM users").all(),
};

export const Sessions = {
  create: (token, userId) => db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, userId),
  user: (token) => db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?").get(token),
  destroy: (token) => db.prepare("DELETE FROM sessions WHERE token = ?").run(token),
};

export const Entries = {
  forUser: (userId) => db.prepare("SELECT * FROM entries WHERE user_id = ? ORDER BY created_at DESC").all(userId),
  get: (id, userId) => db.prepare("SELECT * FROM entries WHERE id = ? AND user_id = ?").get(id, userId),
  create: (e) => db.prepare(`INSERT INTO entries (id, user_id, name, occasion, date, yearly, todo, remind_days, relationship, notes)
    VALUES (@id, @user_id, @name, @occasion, @date, @yearly, @todo, @remind_days, @relationship, @notes)`).run(e),
  update: (e) => db.prepare(`UPDATE entries SET name=@name, occasion=@occasion, date=@date,
    yearly=@yearly, todo=@todo, remind_days=@remind_days, relationship=@relationship, notes=@notes WHERE id=@id AND user_id=@user_id`).run(e),
  remove: (id, userId) => {
    db.prepare("DELETE FROM sent_reminders WHERE entry_id = ?").run(id);
    return db.prepare("DELETE FROM entries WHERE id = ? AND user_id = ?").run(id, userId);
  },
  // legacy single-user rows get adopted by the first account ever created
  adoptOrphans: (userId) => db.prepare("UPDATE entries SET user_id = ? WHERE user_id IS NULL").run(userId),
};

export const Calendars = {
  forUser: (userId) => db.prepare("SELECT * FROM calendar_accounts WHERE user_id = ?").all(userId),
  get: (id, userId) => db.prepare("SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?").get(id, userId),
  upsert: (c) => {
    db.prepare("DELETE FROM calendar_accounts WHERE user_id = ? AND provider = ? AND label = ?").run(c.user_id, c.provider, c.label);
    db.prepare(`INSERT INTO calendar_accounts (id, user_id, provider, label, access_token, refresh_token, expires_at)
      VALUES (@id, @user_id, @provider, @label, @access_token, @refresh_token, @expires_at)`).run(c);
  },
  updateTokens: (id, access, expiresAt) => db.prepare("UPDATE calendar_accounts SET access_token = ?, expires_at = ? WHERE id = ?").run(access, expiresAt, id),
  remove: (id, userId) => db.prepare("DELETE FROM calendar_accounts WHERE id = ? AND user_id = ?").run(id, userId),
};

export const Sent = {
  has: (entryId, occ) => !!db.prepare("SELECT 1 FROM sent_reminders WHERE entry_id = ? AND occurrence_date = ?").get(entryId, occ),
  mark: (entryId, occ) => db.prepare("INSERT OR IGNORE INTO sent_reminders (entry_id, occurrence_date) VALUES (?, ?)").run(entryId, occ),
};

export default db;

export const PushSubs = {
  add: (userId, sub) => db.prepare("INSERT OR REPLACE INTO push_subs (user_id, endpoint, sub_json) VALUES (?, ?, ?)").run(userId, sub.endpoint, JSON.stringify(sub)),
  forUser: (userId) => db.prepare("SELECT sub_json FROM push_subs WHERE user_id = ?").all(userId).map((r) => JSON.parse(r.sub_json)),
  remove: (userId, endpoint) => db.prepare("DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?").run(userId, endpoint),
};
