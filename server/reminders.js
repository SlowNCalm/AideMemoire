import { Entries, Sent } from "./db.js";

const TZ = process.env.TIMEZONE || "America/Toronto";

// "Today" in the configured timezone, as yyyy-mm-dd
export function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

function toParts(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

// Next occurrence (yyyy-mm-dd) of an entry relative to today
export function nextOccurrence(entry, today = todayISO()) {
  if (!entry.yearly) return entry.date;
  const t = toParts(today);
  const b = toParts(entry.date);
  const pad = (n) => String(n).padStart(2, "0");
  let candidate = `${t.y}-${pad(b.m)}-${pad(b.d)}`;
  if (candidate < today) candidate = `${t.y + 1}-${pad(b.m)}-${pad(b.d)}`;
  return candidate;
}

export function daysUntil(entry, today = todayISO()) {
  const occ = nextOccurrence(entry, today);
  const a = new Date(today + "T00:00:00Z");
  const b = new Date(occ + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

function humanDays(d) {
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
}

async function sendEmail({ subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.REMINDER_EMAIL_TO;
  const from = process.env.REMINDER_EMAIL_FROM || "Aide-Mémoire <onboarding@resend.dev>";
  if (!key || !to) {
    console.warn("[reminders] RESEND_API_KEY or REMINDER_EMAIL_TO not set — skipping email.");
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  if (!res.ok) {
    console.error("[reminders] Email send failed:", res.status, await res.text());
    return false;
  }
  return true;
}

const OCCASION_LABELS = {
  birthday: "Birthday",
  anniversary: "Anniversary",
  memorial: "Memorial",
  holiday: "Holiday / tradition",
  checkin: "Check-in",
  event: "Event",
};

/**
 * Runs one reminder sweep. For every entry whose next occurrence falls
 * within its reminder window and which hasn't been emailed for that
 * occurrence yet, send one email (digest style if several are due).
 */
export async function runReminderSweep() {
  const today = todayISO();
  const due = [];

  for (const e of Entries.all()) {
    const occ = nextOccurrence(e, today);
    const d = daysUntil(e, today);
    if (d >= 0 && d <= e.remind_days && !Sent.has(e.id, occ)) {
      due.push({ entry: e, occurrence: occ, days: d });
    }
  }

  if (due.length === 0) {
    console.log(`[reminders] ${today}: nothing due.`);
    return { sent: 0 };
  }

  due.sort((a, b) => a.days - b.days);

  const lines = due.map(({ entry, days }) => {
    const label = OCCASION_LABELS[entry.occasion] || "Date";
    const todo = entry.todo ? ` — ${entry.todo}` : "";
    return `• ${entry.name} — ${label} ${humanDays(days)}${todo}`;
  });

  const htmlRows = due
    .map(({ entry, days, occurrence }) => {
      const label = OCCASION_LABELS[entry.occasion] || "Date";
      return `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid #2a2620;">
          <strong style="color:#e8e3d8;">${escapeHtml(entry.name)}</strong>
          <span style="color:#9a927f;"> — ${label}, ${occurrence}</span><br/>
          <span style="color:#c6a15b;font-weight:600;">${humanDays(days)}</span>
          ${entry.todo ? `<div style="color:#cfc8b8;margin-top:4px;">To do: ${escapeHtml(entry.todo)}</div>` : ""}
        </td></tr>`;
    })
    .join("");

  const subject =
    due.length === 1
      ? `Reminder: ${due[0].entry.name} — ${OCCASION_LABELS[due[0].entry.occasion] || "date"} ${humanDays(due[0].days)}`
      : `Reminders: ${due.length} dates need your attention`;

  const html = `
    <div style="background:#12100e;padding:32px;font-family:Georgia,serif;">
      <h2 style="color:#c6a15b;font-weight:500;margin:0 0 4px;">Aide-Mémoire</h2>
      <p style="color:#9a927f;margin:0 0 20px;">Your private remembrancer</p>
      <table style="width:100%;border-collapse:collapse;background:#1a1712;border-radius:8px;">${htmlRows}</table>
    </div>`;

  const ok = await sendEmail({ subject, html, text: lines.join("\n") });
  if (ok) {
    for (const { entry, occurrence } of due) Sent.mark(entry.id, occurrence);
    console.log(`[reminders] ${today}: emailed ${due.length} reminder(s).`);
    return { sent: due.length };
  }
  return { sent: 0, error: "email_failed" };
}

function escapeHtml(s = "") {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
