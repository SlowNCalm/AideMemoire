import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// On Render, mount a persistent disk at /var/data and set DATA_DIR=/var/data
const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "aide-memoire.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    occasion    TEXT NOT NULL DEFAULT 'birthday',
    date        TEXT NOT NULL,            -- ISO yyyy-mm-dd (original date)
    yearly      INTEGER NOT NULL DEFAULT 1,
    todo        TEXT DEFAULT '',
    remind_days INTEGER NOT NULL DEFAULT 7,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sent_reminders (
    entry_id        TEXT NOT NULL,
    occurrence_date TEXT NOT NULL,        -- which occurrence this reminder was for
    sent_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (entry_id, occurrence_date)
  );
`);

export const Entries = {
  all: () => db.prepare("SELECT * FROM entries ORDER BY created_at DESC").all(),
  get: (id) => db.prepare("SELECT * FROM entries WHERE id = ?").get(id),
  create: (e) =>
    db
      .prepare(
        `INSERT INTO entries (id, name, occasion, date, yearly, todo, remind_days)
         VALUES (@id, @name, @occasion, @date, @yearly, @todo, @remind_days)`
      )
      .run(e),
  update: (e) =>
    db
      .prepare(
        `UPDATE entries SET name=@name, occasion=@occasion, date=@date,
         yearly=@yearly, todo=@todo, remind_days=@remind_days WHERE id=@id`
      )
      .run(e),
  remove: (id) => {
    db.prepare("DELETE FROM sent_reminders WHERE entry_id = ?").run(id);
    return db.prepare("DELETE FROM entries WHERE id = ?").run(id);
  },
};

export const Sent = {
  has: (entryId, occurrenceDate) =>
    !!db
      .prepare("SELECT 1 FROM sent_reminders WHERE entry_id = ? AND occurrence_date = ?")
      .get(entryId, occurrenceDate),
  mark: (entryId, occurrenceDate) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO sent_reminders (entry_id, occurrence_date) VALUES (?, ?)"
      )
      .run(entryId, occurrenceDate),
};

export default db;
