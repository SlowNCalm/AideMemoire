import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { Entries, Users, Sessions } from "./db.js";
import { runReminderSweep, nextOccurrence, daysUntil, findConflicts, todayISO } from "./reminders.js";
import { assistant, briefing } from "./llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const INVITE_CODE = process.env.INVITE_CODE || ""; // optional: gate signups during beta

// ---------- password helpers ----------
const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
};
const checkPassword = (pw, stored) => {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
};

// ---------- auth ----------
app.post("/api/signup", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "A valid email is required — it's where your reminders go." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (INVITE_CODE && req.body?.invite !== INVITE_CODE) return res.status(403).json({ error: "An invite code is required during the beta." });
  if (Users.byEmail(email)) return res.status(409).json({ error: "That email already has an account — log in instead." });

  const user = { id: "u" + crypto.randomUUID(), email, password_hash: hashPassword(password), timezone: String(req.body?.timezone || "America/Toronto").slice(0, 60) };
  Users.create(user);
  if (Users.count() === 1) Entries.adoptOrphans(user.id); // migrate single-user era data
  const token = crypto.randomBytes(32).toString("hex");
  Sessions.create(token, user.id);
  res.status(201).json({ token, email });
});

app.post("/api/login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const user = Users.byEmail(email);
  if (!user || !checkPassword(String(req.body?.password || ""), user.password_hash))
    return res.status(401).json({ error: "Email or password not recognized." });
  const token = crypto.randomBytes(32).toString("hex");
  Sessions.create(token, user.id);
  res.json({ token, email: user.email });
});

app.post("/api/logout", (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (token) Sessions.destroy(token);
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const user = token && Sessions.user(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
  next();
}

app.get("/api/me", requireAuth, (req, res) => res.json({ email: req.user.email, phone: req.user.phone || "" }));
app.patch("/api/me", requireAuth, (req, res) => {
  const phone = String(req.body?.phone || "").replace(/[^\d+]/g, "").slice(0, 20);
  Users.setPhone(req.user.id, phone);
  res.json({ ok: true, phone });
});

app.get("/api/briefing", requireAuth, async (req, res) => {
  const entries = Entries.forUser(req.user.id).map(enrich);
  const tz = req.user.timezone || process.env.TIMEZONE || "America/Toronto";
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()));
  const reply = await briefing({ entries, today: todayISO(tz), hour });
  res.json({ reply });
});

// ---------- entries ----------
const enrich = (e) => ({ ...e, yearly: !!e.yearly, next_occurrence: nextOccurrence(e), days_until: daysUntil(e) });

app.get("/api/entries", requireAuth, (req, res) => {
  res.json(Entries.forUser(req.user.id).map(enrich));
});

function cleanEntry(body, id, userId) {
  const name = String(body.name || "").trim().slice(0, 120);
  const date = String(body.date || "");
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    id, user_id: userId, name,
    occasion: String(body.occasion || "birthday").slice(0, 40),
    date, yearly: body.yearly ? 1 : 0,
    todo: String(body.todo || "").trim().slice(0, 500),
    remind_days: Math.max(0, Math.min(90, Number(body.remind_days) || 0)),
    relationship: String(body.relationship || "").trim().slice(0, 80),
    notes: String(body.notes || "").trim().slice(0, 1000),
  };
}

app.post("/api/entries", requireAuth, (req, res) => {
  const e = cleanEntry(req.body, "d" + crypto.randomUUID(), req.user.id);
  if (!e) return res.status(400).json({ error: "A name and a valid date are required." });
  const conflicts = findConflicts(req.user.id, e, null);
  Entries.create(e);
  res.status(201).json({ ...enrich(e), conflicts });
});

app.put("/api/entries/:id", requireAuth, (req, res) => {
  if (!Entries.get(req.params.id, req.user.id)) return res.status(404).json({ error: "Not found" });
  const e = cleanEntry(req.body, req.params.id, req.user.id);
  if (!e) return res.status(400).json({ error: "A name and a valid date are required." });
  const conflicts = findConflicts(req.user.id, e, e.id);
  Entries.update(e);
  res.json({ ...enrich(e), conflicts });
});

app.delete("/api/entries/:id", requireAuth, (req, res) => {
  Entries.remove(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- the conversational assistant ----------
app.post("/api/assistant", requireAuth, async (req, res) => {
  const text = String(req.body?.text || "").slice(0, 1500);
  if (!text.trim()) return res.status(400).json({ error: "No speech provided." });
  const entries = Entries.forUser(req.user.id).map(enrich);
  const result = await assistant({
    text,
    draft: req.body?.draft || null,
    entries,
    today: todayISO(req.user.timezone),
  });
  if (!result) return res.json({ fallback: true });
  // pre-compute conflicts for a proposed entry so the client can warn verbally
  if (result.intent === "entry" && result.entry?.date) {
    result.conflicts = findConflicts(req.user.id, { date: result.entry.date, yearly: result.entry.yearly }, req.body?.draft?.id || null);
  }
  res.json(result);
});

// ---------- reminders ----------
const CRON_EXPR = process.env.CRON_EXPR || "0 8 * * *";
cron.schedule(CRON_EXPR, () => runReminderSweep(), { timezone: process.env.TIMEZONE || "America/Toronto" });

const CRON_SECRET = process.env.CRON_SECRET || "";
app.post("/api/reminders/run", async (req, res) => {
  if (CRON_SECRET && req.query.key !== CRON_SECRET) return res.status(401).json({ error: "Bad cron key" });
  res.json(await runReminderSweep());
});
app.post("/api/reminders/test", requireAuth, async (req, res) => {
  res.json(await runReminderSweep(req.user.id));
});

// ---------- static frontend ----------
const dist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Aide-Mémoire listening on :${PORT}`));
