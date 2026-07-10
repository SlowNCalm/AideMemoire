import * as chrono from "chrono-node";

// ---------------- API ----------------
let token = null;
try { token = window.localStorage.getItem("am_token"); } catch { /* private mode */ }

export function setToken(t) {
  token = t;
  try { window.localStorage.setItem("am_token", t); } catch { /* ignore */ }
}
export function clearToken() {
  token = null;
  try { window.localStorage.removeItem("am_token"); } catch { /* ignore */ }
}
export function hasToken() { return !!token; }

async function req(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  });
  if (res.status === 401) { clearToken(); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed");
  return res.json();
}

export const api = {
  login: (code) => req("/api/login", { method: "POST", body: JSON.stringify({ code }) }),
  list: () => req("/api/entries"),
  create: (e) => req("/api/entries", { method: "POST", body: JSON.stringify(e) }),
  update: (e) => req(`/api/entries/${e.id}`, { method: "PUT", body: JSON.stringify(e) }),
  remove: (id) => req(`/api/entries/${id}`, { method: "DELETE" }),
  testReminder: () => req("/api/reminders/test", { method: "POST" }),
};

// ---------------- occasions ----------------
export const OCCASIONS = [
  { id: "birthday", label: "Birthday", emoji: "🎂", yearly: true, words: ["birthday", "born"] },
  { id: "anniversary", label: "Anniversary", emoji: "💍", yearly: true, words: ["anniversary", "wedding"] },
  { id: "memorial", label: "Memorial", emoji: "🕯️", yearly: true, words: ["memorial", "passing", "remembrance"] },
  { id: "holiday", label: "Holiday / tradition", emoji: "🎁", yearly: true, words: ["holiday", "christmas", "hanukkah", "diwali", "eid", "tradition"] },
  { id: "checkin", label: "Check-in", emoji: "☎️", yearly: false, words: ["check in", "check-in", "call", "follow up", "follow-up", "reach out"] },
  { id: "event", label: "Event", emoji: "📌", yearly: false, words: ["gala", "dinner", "meeting", "opening", "launch", "event", "fundraiser", "board"] },
];

// ---------------- voice transcript → draft entry ----------------
// Handles speech like:
//  "My mother's birthday is March 12th, remind me two weeks before to order white orchids"
//  "Add a check-in with James next Friday, remind me the day before"
//  "The Hendersons' anniversary is June 3rd — book a table at Alo"
export function parseUtterance(text, refDate = new Date()) {
  const t = " " + text.trim() + " ";
  const lower = t.toLowerCase();

  // 1. Date
  const results = chrono.parse(t, refDate, { forwardDate: true });
  let date = "";
  let dateText = "";
  if (results.length > 0) {
    const d = results[0].start.date();
    const pad = (n) => String(n).padStart(2, "0");
    date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    dateText = results[0].text;
  }

  // 2. Occasion
  let occasion = "event";
  for (const o of OCCASIONS) {
    if (o.words.some((w) => lower.includes(w))) { occasion = o.id; break; }
  }
  const occDef = OCCASIONS.find((o) => o.id === occasion);

  // 3. Reminder lead time ("remind me two weeks before / 3 days ahead / a month early")
  let remindDays = 7;
  const numWords = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const lead = lower.match(/remind me (?:about )?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(day|week|month)s?\s*(?:before|ahead|early|in advance)/);
  if (lead) {
    const n = numWords[lead[1]] ?? (Number(lead[1]) || 1);
    remindDays = n * (lead[2] === "week" ? 7 : lead[2] === "month" ? 30 : 1);
  } else if (/remind me (?:on the day|that day|the day of)/.test(lower)) {
    remindDays = 0;
  } else if (/remind me the day before|remind me a day before/.test(lower)) {
    remindDays = 1;
  }

  // 4. Who it's for — possessive before the occasion word, or "for/with NAME"
  let name = "";
  const possessive = t.match(/([A-Z][\w. ]{0,40}?|[Mm]y [\w ]{1,25}?)['’]s?\s+(?:\w+\s+){0,2}(birthday|anniversary|memorial|gala|dinner|opening|launch|event|party)/);
  if (possessive) name = possessive[1].replace(/^my /i, "").trim();
  if (!name) {
    const forMatch = t.match(/\b(?:for|with|on)\s+(my [\w ]{1,25}?|[A-Z][\w]+(?:\s[A-Z][\w]+)?)(?=[\s,.!]|$)/);
    if (forMatch) name = forMatch[1].replace(/^my /i, "").trim();
  }
  name = name ? name.charAt(0).toUpperCase() + name.slice(1) : "";

  // 5. What to do — text after "remind me to …" or "… to <verb>"
  let todo = "";
  const todoMatch =
    t.match(/remind me[^.]*?\bto\s+(.+?)(?:[.!]|$)/i) ||
    t.match(/\s[—–-]\s+(.+?)(?:[.!]|$)/) ||
    t.match(/\bto\s+((?:order|book|send|buy|arrange|call|plan|reserve|get|write|prepare)\b.+?)(?:[.!]|$)/i);
  if (todoMatch) {
    todo = todoMatch[1].trim();
    // strip a trailing lead-time clause if it got captured
    todo = todo.replace(/,?\s*remind me.*$/i, "").trim();
  }

  return {
    name,
    occasion,
    date,
    dateText,
    yearly: occDef ? occDef.yearly : true,
    todo,
    remind_days: remindDays,
    confidence: {
      name: !!name,
      date: !!date,
    },
  };
}

// ---------------- display helpers ----------------
export function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short", month: "long", day: "numeric", year: "numeric",
  });
}
export function humanDays(d) {
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
}
