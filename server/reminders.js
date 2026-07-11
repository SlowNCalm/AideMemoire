import { Entries, Users, Sent } from "./db.js";

export function todayISO(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || process.env.TIMEZONE || "America/Toronto" }).format(new Date());
}
function toParts(iso) { const [y, m, d] = iso.split("-").map(Number); return { y, m, d }; }

export function nextOccurrence(entry, today) {
  today = today || todayISO();
  if (!entry.yearly) return entry.date;
  const t = toParts(today), b = toParts(entry.date);
  const pad = (n) => String(n).padStart(2, "0");
  let c = `${t.y}-${pad(b.m)}-${pad(b.d)}`;
  if (c < today) c = `${t.y + 1}-${pad(b.m)}-${pad(b.d)}`;
  return c;
}
export function daysUntil(entry, today) {
  today = today || todayISO();
  const a = new Date(today + "T00:00:00Z"), b = new Date(nextOccurrence(entry, today) + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}
function humanDays(d) { return d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`; }

// Executive-assistant conflict check: other entries landing on (or adjacent to)
// the same occurrence date.
export function findConflicts(userId, entry, excludeId) {
  const today = todayISO();
  const occ = nextOccurrence(entry, today);
  const out = [];
  for (const e of Entries.forUser(userId)) {
    if (e.id === excludeId) continue;
    const eo = nextOccurrence(e, today);
    const gap = Math.abs(Math.round((new Date(occ) - new Date(eo)) / 86400000));
    if (gap <= 1) out.push({ id: e.id, name: e.name, occasion: e.occasion, date: eo, gap });
  }
  return out;
}

const OCCASION_LABELS = { birthday: "Birthday", anniversary: "Anniversary", memorial: "Memorial", holiday: "Holiday / tradition", checkin: "Check-in", event: "Event" };
const esc = (s = "") => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.REMINDER_EMAIL_FROM || "Aide-Mémoire <onboarding@resend.dev>";
  if (!key || !to) { console.warn("[reminders] missing RESEND_API_KEY or recipient"); return false; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  if (!res.ok) { console.error("[reminders] send failed:", res.status, await res.text()); return false; }
  return true;
}

async function sendSMS(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !tok || !from || !to) return false;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) { console.error("[reminders] SMS failed:", res.status, await res.text()); return false; }
  return true;
}

async function sweepUser(user) {
  const today = todayISO(user.timezone);
  const due = [];
  for (const e of Entries.forUser(user.id)) {
    const occ = nextOccurrence(e, today);
    const d = daysUntil(e, today);
    if (d >= 0 && d <= e.remind_days && !Sent.has(e.id, occ)) due.push({ entry: e, occurrence: occ, days: d });
  }
  if (!due.length) return 0;
  due.sort((a, b) => a.days - b.days);

  const lines = due.map(({ entry, days }) =>
    `• ${entry.name} — ${OCCASION_LABELS[entry.occasion] || "Date"} ${humanDays(days)}${entry.todo ? " — " + entry.todo : ""}`);
  const rows = due.map(({ entry, days, occurrence }) => `<tr><td style="padding:10px 14px;border-bottom:1px solid #2a2620;">
      <strong style="color:#e8e3d8;">${esc(entry.name)}</strong>
      <span style="color:#9a927f;"> — ${OCCASION_LABELS[entry.occasion] || "Date"}, ${occurrence}</span><br/>
      <span style="color:#c6a15b;font-weight:600;">${humanDays(days)}</span>
      ${entry.todo ? `<div style="color:#cfc8b8;margin-top:4px;">To arrange: ${esc(entry.todo)}</div>` : ""}</td></tr>`).join("");
  const subject = due.length === 1
    ? `Reminder: ${due[0].entry.name} — ${(OCCASION_LABELS[due[0].entry.occasion] || "date").toLowerCase()} ${humanDays(due[0].days)}`
    : `Your briefing: ${due.length} dates need attention`;
  const html = `<div style="background:#12100e;padding:32px;font-family:Georgia,serif;">
      <h2 style="color:#c6a15b;font-weight:500;margin:0 0 4px;">Aide-Mémoire</h2>
      <p style="color:#9a927f;margin:0 0 20px;">Your private remembrancer</p>
      <table style="width:100%;border-collapse:collapse;background:#1a1712;border-radius:8px;">${rows}</table></div>`;

  const ok = await sendEmail({ to: user.email, subject, html, text: lines.join("\n") });
  if (user.phone) await sendSMS(user.phone, `Aide-Mémoire — ${subject}\n${lines.join("\n")}`);
  if (ok) { for (const { entry, occurrence } of due) Sent.mark(entry.id, occurrence); return due.length; }
  return 0;
}

export async function runReminderSweep(onlyUserId) {
  let sent = 0;
  const users = onlyUserId ? [Users.byId(onlyUserId)].filter(Boolean) : Users.all();
  for (const u of users) sent += await sweepUser(u);
  console.log(`[reminders] ${todayISO()}: sent ${sent} reminder email(s) across ${users.length} account(s).`);
  return { sent };
}
