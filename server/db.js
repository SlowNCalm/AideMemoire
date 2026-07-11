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

// migration: single-user era entries have no user_id column value
try { db.exec("ALTER TABLE entries ADD COLUMN user_id TEXT"); } catch { /* already there */ }

export const Users = {
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
  create: (e) => db.prepare(`INSERT INTO entries (id, user_id, name, occasion, date, yearly, todo, remind_days)
    VALUES (@id, @user_id, @name, @occasion, @date, @yearly, @todo, @remind_days)`).run(e),
  update: (e) => db.prepare(`UPDATE entries SET name=@name, occasion=@occasion, date=@date,
    yearly=@yearly, todo=@todo, remind_days=@remind_days WHERE id=@id AND user_id=@user_id`).run(e),
  remove: (id, userId) => {
    db.prepare("DELETE FROM sent_reminders WHERE entry_id = ?").run(id);
    return db.prepare("DELETE FROM entries WHERE id = ? AND user_id = ?").run(id, userId);
  },
  // legacy single-user rows get adopted by the first account ever created
  adoptOrphans: (userId) => db.prepare("UPDATE entries SET user_id = ? WHERE user_id IS NULL").run(userId),
};

export const Sent = {
  has: (entryId, occ) => !!db.prepare("SELECT 1 FROM sent_reminders WHERE entry_id = ? AND occurrence_date = ?").get(entryId, occ),
  mark: (entryId, occ) => db.prepare("INSERT OR IGNORE INTO sent_reminders (entry_id, occurrence_date) VALUES (?, ?)").run(entryId, occ),
};

export default db;
