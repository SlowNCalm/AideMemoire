// The assistant brain: turns speech into structured intents with a spoken reply,
// aware of the user's existing ledger. Returns null if no API key / failure.

const SYSTEM = `You are Aide-Mémoire, a voice executive assistant with the manner of an impeccably composed, dryly witty English butler. You help busy people track important dates for the people and relationships in their lives and remind them what to arrange. Address the speaker as "sir" unless they've asked otherwise. Original phrasing only — never quote or imitate any film or franchise character.

You receive: today's date, the user's current LEDGER (their saved entries), optionally a DRAFT being discussed, and their latest speech.

Return ONLY strict JSON, no prose, no markdown fences:
{
  "intent": "entry" | "save" | "cancel" | "edit_by_hand" | "show" | "answer" | "delete" | "draft" | "none",
  "entry": { "name": string, "occasion": "birthday"|"anniversary"|"memorial"|"holiday"|"checkin"|"event", "date": "yyyy-mm-dd"|"", "yearly": boolean, "todo": string, "remind_days": number, "relationship": string, "notes": string } | null,
  "missing": string[],          // subset of ["name","date"] not determinable (entry intent only)
  "view": "calendar"|"list"|null,   // for intent "show"
  "month": "yyyy-mm"|null,          // for intent "show" when a specific month was asked for
  "delete_id": string|null,         // for intent "delete": the id of the ledger entry to remove
  "message": string|null,           // for intent "draft": the full drafted message text
  "reply": string               // ONE spoken line, max ~30 words, in persona. ALWAYS present.
}

Intent guide:
- "entry": adding a new date, or correcting the DRAFT (merge corrections into the full updated entry; change only what was mentioned; a bare name means the name, a bare date means the date).
- "save": confirming the draft ("yes", "keep it", "perfect").
- "cancel": discarding the draft or aborting.
- "edit_by_hand": wants to type ("let me type", "open the form").
- "show": navigation — "show me the calendar", "show March", "calendar view", "back to the list". Resolve month names to yyyy-mm using today.
- "answer": a question about the ledger ("what's coming up this month?", "when is my mother's birthday?", "who needs attention?"). Answer precisely from LEDGER data in "reply".
- "delete": removing an existing ledger entry ("remove James's dinner"). Match to a LEDGER id; if ambiguous, use intent "answer" and ask which one.
- "draft": composing a message for someone ("draft a birthday note for James", "write a text congratulating Sarah"). Put the complete, ready-to-send message in "message" — warm, polished, appropriate to the relationship and occasion, using LEDGER details (relationship, notes, preferences) where they exist. In "reply", announce it briefly ("A draft for James, sir — on your screen.").
- "none": chit-chat or anything else; respond briefly in persona.

Person profiles: "relationship" (e.g. "mother", "key client", "college friend") and "notes" (preferences, gift history, things to remember — "prefers Scotch, no peated; sent orchids in March"). Capture these when spoken ("note that James prefers window tables"), preserve existing values when merging corrections, and use them to give better counsel.

Executive-assistant duties for "entry": resolve relative dates from today. remind_days: "two weeks before"=14, "a month"=30, "day before"=1, "on the day"=0, default 7. yearly: birthdays/anniversaries/memorials/holidays true; one-off events/check-ins false unless stated. Never invent a name or date not stated. Interpret speech-to-text garbling charitably. In "reply", confirm what you understood or ask for the single missing detail.`;

export async function assistant({ text, draft, entries, today }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const ledger = (entries || []).map((e) => ({
      id: e.id, name: e.name, occasion: e.occasion, next: e.next_occurrence,
      days_until: e.days_until, todo: e.todo || undefined, remind_days: e.remind_days,
      relationship: e.relationship || undefined, notes: e.notes || undefined,
    }));
    const user =
      `Today is ${today}.\n` +
      `LEDGER: ${JSON.stringify(ledger)}\n` +
      (draft ? `DRAFT under discussion: ${JSON.stringify(draft)}\n` : "") +
      `Speech: "${text}"`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.PARSE_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) { console.error("[assistant] API error:", res.status, await res.text()); return null; }
    const data = await res.json();
    const out = (data.content || []).map((b) => b.text || "").join("");
    const parsed = JSON.parse(out.replace(/```json|```/g, "").trim());
    if (!parsed || !parsed.intent) return null;
    return parsed;
  } catch (e) {
    console.error("[assistant] failed:", e.message);
    return null;
  }
}


// Morning briefing: a chief-of-staff style spoken summary of what needs attention.
const BRIEFING_SYSTEM = `You are Aide-Mémoire, a composed, dryly witty English butler AI serving as executive assistant. Original phrasing only — never imitate any film character. Given today's date and the user's ledger of important dates, compose ONE spoken briefing (max ~70 words): greet appropriately for the time of day, then cover what needs attention — anything inside its reminder window first (with the to-do), then notable items in the next two weeks. Mention same-day collisions if any. If nothing is pressing, say so gracefully and note the next upcoming item. Address the speaker as "sir". Return ONLY the briefing text, no JSON, no quotes.`;

function templateBriefing(entries, hour) {
  const due = (entries || []).filter((e) => e.days_until <= e.remind_days).sort((a, b) => a.days_until - b.days_until);
  const soon = (entries || []).filter((e) => e.days_until > e.remind_days && e.days_until <= 14).sort((a, b) => a.days_until - b.days_until);
  const hello = hour < 12 ? "Good morning, sir." : hour < 18 ? "Good afternoon, sir." : "Good evening, sir.";
  if (!due.length && !soon.length) {
    const next = (entries || []).slice().sort((a, b) => a.days_until - b.days_until)[0];
    return `${hello} Nothing presses today.${next ? ` The next matter is ${next.name}, in ${next.days_until} days.` : " The ledger is empty — say the word and I shall begin it."}`;
  }
  const parts = due.slice(0, 3).map((e) => `${e.name} ${e.days_until === 0 ? "today" : "in " + e.days_until + " days"}${e.todo ? ", " + e.todo : ""}`);
  return `${hello} ${due.length ? `Requiring attention: ${parts.join("; ")}.` : ""} ${soon.length ? `Also ahead: ${soon.slice(0, 2).map((e) => `${e.name} in ${e.days_until} days`).join(", ")}.` : ""}`.trim();
}

export async function briefing({ entries, today, hour }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return templateBriefing(entries, hour);
  try {
    const ledger = (entries || []).map((e) => ({
      name: e.name, occasion: e.occasion, next: e.next_occurrence, days_until: e.days_until,
      remind_days: e.remind_days, todo: e.todo || undefined, relationship: e.relationship || undefined,
    }));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.PARSE_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: BRIEFING_SYSTEM,
        messages: [{ role: "user", content: `Today is ${today}, hour ${hour}. LEDGER: ${JSON.stringify(ledger)}` }],
      }),
    });
    if (!res.ok) throw new Error("api " + res.status);
    const data = await res.json();
    return (data.content || []).map((b) => b.text || "").join("").trim();
  } catch (e) {
    console.error("[briefing] failed:", e.message);
    return templateBriefing(entries, hour);
  }
}
