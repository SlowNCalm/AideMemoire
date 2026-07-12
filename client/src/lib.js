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
  signup: (email, password, invite) => req("/api/signup", { method: "POST", body: JSON.stringify({ email, password, invite, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) }),
  login: (email, password) => req("/api/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => req("/api/logout", { method: "POST" }).catch(() => {}),
  list: () => req("/api/entries"),
  create: (e) => req("/api/entries", { method: "POST", body: JSON.stringify(e) }),
  update: (e) => req(`/api/entries/${e.id}`, { method: "PUT", body: JSON.stringify(e) }),
  remove: (id) => req(`/api/entries/${id}`, { method: "DELETE" }),
  testReminder: () => req("/api/reminders/test", { method: "POST" }),
  assistant: (text, draft, history) => req("/api/assistant", { method: "POST", body: JSON.stringify({ text, draft, history }) }),
  briefing: () => req("/api/briefing"),
  me: () => req("/api/me"),
  setPhone: (phone) => req("/api/me", { method: "PATCH", body: JSON.stringify({ phone }) }),
  bulkImport: (entries) => req("/api/entries/bulk", { method: "POST", body: JSON.stringify({ entries }) }),
  calendars: () => req("/api/calendar/list"),
  calendarUrl: (provider) => req(`/api/calendar/url/${provider}`, { method: "POST" }),
  calendarRemove: (id) => req(`/api/calendar/${id}`, { method: "DELETE" }),
  checkout: () => req("/api/billing/checkout", { method: "POST" }),
  billingPortal: () => req("/api/billing/portal", { method: "POST" }),
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

// ---------------- voice conversation helpers ----------------
let cachedVoice = null;
function pickVoice() {
  if (cachedVoice) return cachedVoice;
  try {
    const voices = window.speechSynthesis.getVoices() || [];
    // prefer a refined British male voice; degrade gracefully
    cachedVoice =
      voices.find((v) => /en-GB/i.test(v.lang) && /daniel|george|arthur|male/i.test(v.name)) ||
      voices.find((v) => /en-GB/i.test(v.lang)) ||
      voices.find((v) => /^en/i.test(v.lang)) ||
      null;
  } catch { cachedVoice = null; }
  return cachedVoice;
}
try { window.speechSynthesis.onvoiceschanged = () => { cachedVoice = null; pickVoice(); }; } catch { /* noop */ }

export function speak(text) {
  return new Promise((resolve) => {
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.rate = 0.98;
      u.pitch = 0.92;
      let done = false, started = false;
      const finish = () => { if (!done) { done = true; clearInterval(keepAlive); setTimeout(resolve, 350); } };
      u.onstart = () => { started = true; };
      u.onend = finish;
      u.onerror = finish;
      // Chrome quirks: cancel() immediately before speak() can silently swallow
      // the utterance, and long speech can auto-pause. Delay slightly, nudge
      // with resume(), and retry once if speech never starts.
      setTimeout(() => { try { synth.speak(u); synth.resume(); } catch { finish(); } }, 60);
      // retry ONLY if the engine truly never started (was 900ms — too eager; it
      // cancelled slow-starting speech mid-word, causing audible cut-outs)
      setTimeout(() => {
        if (!started && !done && !synth.speaking && !synth.pending) {
          try { synth.cancel(); synth.speak(u); synth.resume(); } catch { finish(); }
        }
      }, 2500);
      // gentle anti-pause nudge for LONG speech only; frequent resume() on short
      // lines causes stutter on some platforms
      const keepAlive = text.length > 180
        ? setInterval(() => { if (!done && synth.paused) { try { synth.resume(); } catch { /* noop */ } } }, 6000)
        : setInterval(() => {}, 1 << 30);
      setTimeout(finish, 4500 + text.length * 110);
    } catch { resolve(); }
  });
}

// Speak while listening for an interruption ("stop", "wait", "no, make it…").
// Echo-guard: ignores transcripts that are just the TTS voice leaking into the mic.
export function bargeInEnabled() {
  try { return window.localStorage.getItem("am_bargein") !== "off"; } catch { return true; }
}
export function setBargeInEnabled(on) {
  try { window.localStorage.setItem("am_bargein", on ? "on" : "off"); } catch { /* noop */ }
}

export function speakWithBargeIn(text) {
  return new Promise((resolve) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    // Short lines ("Kept.", "The calendar, sir.") don't need interruption support —
    // running a recognizer for them just ducks the speaker and adds start lag.
    if (!SR || !bargeInEnabled() || text.length < 70) {
      speak(text).then(() => resolve({ heard: null }));
      return;
    }

    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
    const spokenWords = new Set(norm(text));
    const STOP = /^(stop|wait|no\b|hold|hang on|cancel|jarvis|actually|excuse me|pause|quiet|one moment|shut)/;
    const novelCount = (t) => norm(t).filter((w) => !spokenWords.has(w)).length;
    const qualifies = (t) => STOP.test(t.trim().toLowerCase()) || novelCount(t) >= 3;
    const stripEcho = (t) => {
      const ws = t.trim().split(/\s+/);
      let i = 0;
      while (i < ws.length && spokenWords.has(ws[i].toLowerCase().replace(/[^a-z0-9']/g, ""))) i++;
      return ws.slice(i).join(" ").trim() || t.trim();
    };

    let done = false, interrupted = false, finalBuf = "", interimBuf = "", silenceTimer = null;
    const rec = new SR();
    rec.lang = "en-US"; rec.continuous = true; rec.interimResults = true;
    const finish = (heard) => {
      if (done) return;
      done = true;
      clearTimeout(silenceTimer);
      try { rec.stop(); } catch { /* noop */ }
      resolve({ heard: heard || null });
    };
    rec.onresult = (ev) => {
      finalBuf = ""; interimBuf = "";
      for (const r of ev.results) (r.isFinal ? (finalBuf += r[0].transcript + " ") : (interimBuf += r[0].transcript));
      const t = (finalBuf + interimBuf).trim();
      if (!interrupted && t && qualifies(t)) { interrupted = true; stopSpeaking(); }
      if (interrupted) {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => finish(stripEcho((finalBuf + interimBuf).trim())), 1800);
      }
    };
    rec.onend = () => { if (interrupted && !done) finish(stripEcho((finalBuf + interimBuf).trim())); };
    try { rec.start(); } catch { /* mic busy: degrade to plain speech */ }

    speak(text).then(() => { if (!interrupted) setTimeout(() => finish(null), 200); });
    setTimeout(() => { if (!done && !interrupted) finish(null); }, 40000); // absolute cap
  });
}

export function stopSpeaking() {
  try { window.speechSynthesis.cancel(); } catch { /* noop */ }
}

// Spoken summary of a draft, plus the question
export function draftSummary(d) {
  const occ = OCCASIONS.find((o) => o.id === d.occasion);
  const parts = [];
  parts.push(`${d.name || "someone"} — ${occ ? occ.label.toLowerCase() : "date"}`);
  if (d.date) parts.push(`on ${spokenDate(d.date)}`);
  parts.push(d.remind_days === 0 ? "reminder on the day" : `reminder ${spokenLead(d.remind_days)} before`);
  if (d.todo) parts.push(`to ${d.todo}`);
  return parts.join(", ");
}
function spokenDate(iso) {
  const [y, m, day] = iso.split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "long", day: "numeric" });
}
function spokenLead(days) {
  if (days % 30 === 0 && days >= 30) return days === 30 ? "one month" : `${days / 30} months`;
  if (days % 7 === 0 && days >= 7) return days === 7 ? "one week" : `${days / 7} weeks`;
  return days === 1 ? "one day" : `${days} days`;
}

// Interpret a spoken reply during review. Returns:
//  { action: "save" } | { action: "cancel" } | { action: "edit" }
//  | { action: "update", draft, changed: [fields] }
//  | { action: "unclear" }
export function parseCorrection(text, draft) {
  const t = " " + text.trim() + " ";
  const lower = t.toLowerCase().trim();

  if (/^(yes|yeah|yep|yup|correct|confirm|confirmed|save|save it|keep it|keep|that's right|that is right|perfect|sounds good|good|done|ok|okay)\b/.test(lower))
    return { action: "save" };
  if (/^(no |cancel|discard|never mind|nevermind|forget it|scrap|stop|delete)/.test(lower) && lower.split(" ").length <= 3)
    return { action: "cancel" };
  if (/\b(edit by hand|type it|manual|let me type|open the form)\b/.test(lower))
    return { action: "edit" };

  const next = { ...draft };
  const changed = [];

  // name: "the name is X" / "it's for X" / "change the name to X" / "call it X"
  const nameM =
    t.match(/\b(?:the name is|name is|it'?s for|change (?:the )?name to|make it for|for)\s+([A-Za-z][\w' ]{0,40}?)(?=[,.!]|$)/i);
  if (nameM && !/^(the|a|an)\b/i.test(nameM[1])) {
    next.name = nameM[1].trim().replace(/^my /i, "");
    next.name = next.name.charAt(0).toUpperCase() + next.name.slice(1);
    changed.push("name");
  }

  // occasion
  for (const o of OCCASIONS) {
    if (o.words.some((w) => lower.includes(w))) {
      if (next.occasion !== o.id) { next.occasion = o.id; next.yearly = o.yearly; changed.push("occasion"); }
      break;
    }
  }

  // reminder lead ("remind me two weeks before", "make the reminder 3 days")
  const numWords = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const lead = lower.match(/remind(?:er)?(?: me)?[^.]*?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*(day|week|month)s?/);
  if (lead) {
    const n = numWords[lead[1]] ?? (Number(lead[1]) || 1);
    next.remind_days = n * (lead[2] === "week" ? 7 : lead[2] === "month" ? 30 : 1);
    changed.push("reminder");
  } else if (/remind(?:er)?(?: me)? on the day|day of/.test(lower)) {
    next.remind_days = 0; changed.push("reminder");
  }

  // to-do: "the note is …" / "to do is …" / "remind me to …" / "have them …"
  const todoM =
    t.match(/\b(?:the note is|note is|to[- ]do is|the task is|task is|remind me to|i need to|i should)\s+(.+?)(?:[.!]|$)/i);
  if (todoM) { next.todo = todoM[1].trim(); changed.push("to-do"); }

  // date: any parseable date in the utterance (checked last, and only if the
  // phrase actually looks date-like, so "remind me two weeks before" doesn't parse)
  if (!changed.includes("reminder") || /\bon\b|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|\d{1,2}(st|nd|rd|th)/.test(lower)) {
    const results = chrono.parse(t, new Date(), { forwardDate: true });
    if (results.length > 0 && /january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next |\d/.test(results[0].text.toLowerCase())) {
      const d = results[0].start.date();
      const pad = (n) => String(n).padStart(2, "0");
      const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (iso !== draft.date) { next.date = iso; changed.push("date"); }
    }
  }

  // bare short answer while a field is missing (handled by caller passing expectField)
  if (changed.length === 0) return { action: "unclear" };
  return { action: "update", draft: next, changed };
}


// ---------------- butler persona ----------------
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const persona = {
  acknowledge: () => pick(["Sir?", "At your service.", "Listening, sir."]),
  askName: () => pick(["Certainly. For whom, sir?", "Of course — who is this for?", "Very good. Whom shall I note this for, sir?"]),
  askDate: (name) => pick([`And the date for ${name}, sir?`, `When shall I mark it for ${name}?`, `${name} — on what date, sir?`]),
  confirmPrefix: () => pick(["As I have it:", "Noted, sir:", "Very good:"]),
  savingSuffix: () => pick(["I'll file it momentarily — do interrupt if I've erred.", "Committing it to the ledger — say stop to amend.", "Filing now, sir — speak up if anything's amiss."]),
  saved: (leadPhrase) => pick([`Done, sir. I shall remind you ${leadPhrase}.`, `Filed. Expect my note ${leadPhrase}.`, `Very good, sir — it's in the ledger. I'll write ${leadPhrase}.`]),
  cancelled: () => pick(["As you wish — discarded.", "Very well, sir. We shall speak of it no more.", "Struck from the record."]),
  unclear: () => pick(["Forgive me, sir — say yes to keep it, or tell me what to amend.", "I didn't quite catch that. Yes to file it, or name the correction."]),
  stillThere: () => pick(["Whenever you're ready, sir. The buttons below also serve.", "I remain at your disposal — voice or buttons, as you prefer."]),
};
persona.conflict = (names) => {
  const list = names.join(" and ");
  const opts = [
    `Do note, sir — that falls on the same day as ${list}.`,
    `A word of caution: that coincides with ${list}, sir.`,
    `Mind the calendar, sir — ${list} lands on the same day.`,
  ];
  return opts[Math.floor(Math.random() * opts.length)];
};
persona.greet = () => {
  const opts = ["At your service, sir.", "Good day, sir. The ledger awaits.", "Welcome back, sir."];
  return opts[Math.floor(Math.random() * opts.length)];
};
persona.voiceCheck = () => {
  const opts = ["You shall hear me perfectly well, sir.", "Loud and clear, sir.", "The voice is in working order, sir."];
  return opts[Math.floor(Math.random() * opts.length)];
};
persona.showCalendar = () => "The calendar, sir.";
persona.showList = () => "The ledger, sir.";

export function leadPhrase(days) {
  if (days === 0) return "on the day itself";
  if (days === 1) return "the day before";
  if (days % 30 === 0 && days >= 30) return days === 30 ? "a month ahead" : `${days / 30} months ahead`;
  if (days % 7 === 0 && days >= 7) return days === 7 ? "a week ahead" : `${days / 7} weeks ahead`;
  return `${days} days ahead`;
}
