import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { Entries } from "./db.js";
import { runReminderSweep, nextOccurrence, daysUntil } from "./reminders.js";
import { llmParse } from "./llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const ACCESS_CODE = process.env.ACCESS_CODE || "";
const SECRET = process.env.APP_SECRET || crypto.randomBytes(32).toString("hex");
const CRON_SECRET = process.env.CRON_SECRET || "";

const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
const TOKEN = sign("aide-memoire-session");

// ---------- auth ----------
app.post("/api/login", (req, res) => {
  if (!ACCESS_CODE) return res.json({ token: TOKEN, note: "no ACCESS_CODE set" });
  if (req.body?.code === ACCESS_CODE) return res.json({ token: TOKEN });
  res.status(401).json({ error: "Wrong access code." });
});

function requireAuth(req, res, next) {
  if (!ACCESS_CODE) return next(); // open mode if no code configured
  const h = req.headers.authorization || "";
  if (h === `Bearer ${TOKEN}`) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// ---------- entries API ----------
app.get("/api/entries", requireAuth, (_req, res) => {
  const rows = Entries.all().map((e) => ({
    ...e,
    yearly: !!e.yearly,
    next_occurrence: nextOccurrence(e),
    days_until: daysUntil(e),
  }));
  res.json(rows);
});

function cleanEntry(body, id) {
  const name = String(body.name || "").trim().slice(0, 120);
  const date = String(body.date || "");
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    id,
    name,
    occasion: String(body.occasion || "birthday").slice(0, 40),
    date,
    yearly: body.yearly ? 1 : 0,
    todo: String(body.todo || "").trim().slice(0, 500),
    remind_days: Math.max(0, Math.min(90, Number(body.remind_days) || 0)),
  };
}

app.post("/api/entries", requireAuth, (req, res) => {
  const e = cleanEntry(req.body, "d" + crypto.randomUUID());
  if (!e) return res.status(400).json({ error: "A name and a valid date are required." });
  Entries.create(e);
  res.status(201).json({ ...e, yearly: !!e.yearly, next_occurrence: nextOccurrence(e), days_until: daysUntil(e) });
});

app.put("/api/entries/:id", requireAuth, (req, res) => {
  if (!Entries.get(req.params.id)) return res.status(404).json({ error: "Not found" });
  const e = cleanEntry(req.body, req.params.id);
  if (!e) return res.status(400).json({ error: "A name and a valid date are required." });
  Entries.update(e);
  res.json({ ...e, yearly: !!e.yearly, next_occurrence: nextOccurrence(e), days_until: daysUntil(e) });
});

app.delete("/api/entries/:id", requireAuth, (req, res) => {
  Entries.remove(req.params.id);
  res.json({ ok: true });
});

// ---------- voice parsing (LLM) ----------
app.post("/api/parse", requireAuth, async (req, res) => {
  const text = String(req.body?.text || "").slice(0, 1000);
  if (!text.trim()) return res.status(400).json({ error: "No speech provided." });
  const result = await llmParse({
    text,
    draft: req.body?.draft || null,
    today: new Date().toLocaleDateString("en-CA", { timeZone: process.env.TIMEZONE || "America/Toronto" }),
  });
  if (!result) return res.json({ fallback: true }); // client uses local heuristics
  res.json(result);
});

// ---------- reminder trigger ----------
// Internal cron (works when the service is always-on) …
const CRON_EXPR = process.env.CRON_EXPR || "0 8 * * *"; // 8:00 every morning
cron.schedule(CRON_EXPR, () => runReminderSweep(), {
  timezone: process.env.TIMEZONE || "America/Toronto",
});

// … plus an external trigger so a service like cron-job.org can also fire it.
app.post("/api/reminders/run", async (req, res) => {
  if (CRON_SECRET && req.query.key !== CRON_SECRET)
    return res.status(401).json({ error: "Bad cron key" });
  res.json(await runReminderSweep());
});

// Manual "send me a test sweep now" from the UI
app.post("/api/reminders/test", requireAuth, async (_req, res) => {
  res.json(await runReminderSweep());
});

// ---------- static frontend ----------
const dist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Aide-Mémoire listening on :${PORT}`));
