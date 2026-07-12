// The assistant brain: turns speech into structured intents with a spoken reply,
// aware of the user's existing ledger. Returns null if no API key / failure.

const SYSTEM = `You are Aide-Mémoire, a voice executive assistant with the manner of an impeccably composed, dryly witty English butler. Your core duty is tracking important dates and relationships — but like any first-rate executive assistant, you are broadly knowledgeable and answer ANY question put to you: arithmetic and calculations (be precise), general knowledge, business and finance concepts, current events (search the web when the answer could have changed or you're unsure), advice, translations, anything. Address the speaker as "sir" unless they've asked otherwise. Original phrasing only — never quote or imitate any film or franchise character.

Replies are SPOKEN aloud: keep them under ~70 words, conversational, no markdown, no lists — flowing speech. For calculations, state the answer first, method only if asked.

You receive: today's date, the user's current LEDGER (their saved entries), optionally a DRAFT being discussed, recent conversation HISTORY, and their latest speech.

CRITICAL — continuity: resolve pronouns and references ("her", "that dinner", "make it the 15th instead") using HISTORY and the DRAFT. If details for an entry were given across several turns (name in one, date in another), carry ALL of them into "entry" — never drop what was already established. When entry details are incomplete, you MUST use intent "entry" with the known fields filled and "missing" listing what's absent — never intent "answer" — so the details are preserved while you ask.

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
- "answer": ANY question — about the ledger ("what's coming up this month?"), or about anything else in the world ("what's 15% of 2.4 million?", "what time is it in Singapore?", "explain a reverse merger", "who won the match last night?"). Ledger questions: answer precisely from LEDGER data. World questions: answer from knowledge, searching the web first when the answer is time-sensitive or uncertain. Put the full spoken answer in "reply".
- "delete": removing an existing ledger entry ("remove James's dinner"). Match to a LEDGER id; if ambiguous, use intent "answer" and ask which one.
- "draft": composing a message for someone ("draft a birthday note for James", "write a text congratulating Sarah"). Put the complete, ready-to-send message in "message" — warm, polished, appropriate to the relationship and occasion, using LEDGER details (relationship, notes, preferences) where they exist. In "reply", announce it briefly ("A draft for James, sir — on your screen.").
- "none": chit-chat or anything else; respond briefly in persona.

Person profiles: "relationship" (e.g. "mother", "key client", "college friend") and "notes" (preferences, gift history, things to remember — "prefers Scotch, no peated; sent orchids in March"). Capture these when spoken ("note that James prefers window tables"), preserve existing values when merging corrections, and use them to give better counsel.

Executive-assistant duties for "entry": resolve relative dates from today. remind_days: "two weeks before"=14, "a month"=30, "day before"=1, "on the day"=0, default 7. yearly: birthdays/anniversaries/memorials/holidays true; one-off events/check-ins false unless stated. Never invent a name or date not stated. Interpret speech-to-text garbling charitably. In "reply", confirm what you understood or ask for the single missing detail.`;

// ---------------- provider abstraction ----------------
// LLM_PROVIDER=anthropic (default) | openai-compatible (Qwen, DeepSeek, OpenAI, Groq…)
// For Qwen: LLM_PROVIDER=qwen, QWEN_API_KEY=sk-…, optional QWEN_MODEL (default qwen-plus),
// optional QWEN_BASE_URL (default DashScope international compatible-mode endpoint).
function providerConfig() {
  const p = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
  if (p === "anthropic") return { kind: "anthropic", key: process.env.ANTHROPIC_API_KEY };
  // generic OpenAI-compatible path; qwen gets sensible defaults
  const isQwen = p === "qwen";
  return {
    kind: "openai",
    key: process.env.OPENAI_COMPAT_API_KEY || (isQwen ? process.env.QWEN_API_KEY : process.env.OPENAI_API_KEY),
    base: process.env.OPENAI_COMPAT_BASE_URL || process.env.QWEN_BASE_URL ||
      (isQwen ? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" : "https://api.openai.com/v1"),
    model: process.env.OPENAI_COMPAT_MODEL || process.env.QWEN_MODEL || (isQwen ? "qwen-plus" : "gpt-4o-mini"),
  };
}

// One call, either provider. tools only supported on Anthropic (web search).
async function chatLLM({ system, user, maxTokens, tools }) {
  const cfg = providerConfig();
  if (!cfg.key) return null;

  if (cfg.kind === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.PARSE_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        ...(tools && process.env.WEB_SEARCH !== "off" ? { tools } : {}),
      }),
    });
    if (!res.ok) { console.error("[llm] anthropic error:", res.status, await res.text()); return null; }
    const data = await res.json();
    return (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
  }

  // OpenAI-compatible (Qwen / DeepSeek / OpenAI / Groq …)
  const res = await fetch(`${cfg.base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) { console.error("[llm] openai-compat error:", res.status, await res.text()); return null; }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

// The model may emit prose around the JSON (especially after web searches);
// pull out the last JSON object that contains an "intent" key.
function extractJson(text) {
  const clean = text.replace(/```json|```/g, "");
  try { return JSON.parse(clean.trim()); } catch { /* keep hunting */ }
  const idx = clean.lastIndexOf('{"intent"');
  const start = idx >= 0 ? idx : clean.indexOf("{");
  if (start < 0) return null;
  // walk to the balanced closing brace
  let depth = 0;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    else if (clean[i] === "}") { depth--; if (depth === 0) { try { return JSON.parse(clean.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

export async function assistant({ text, draft, entries, today, history }) {
  if (!providerConfig().key) return null;
  try {
    const ledger = (entries || []).map((e) => ({
      id: e.id, name: e.name, occasion: e.occasion, next: e.next_occurrence,
      days_until: e.days_until, todo: e.todo || undefined, remind_days: e.remind_days,
      relationship: e.relationship || undefined, notes: e.notes || undefined,
    }));
    const hist = (history || []).slice(-8).map((h) => `${h.role === "user" ? "User" : "You"}: ${h.text}`).join("\n");
    const user =
      `Today is ${today}.\n` +
      `LEDGER: ${JSON.stringify(ledger)}\n` +
      (hist ? `HISTORY:\n${hist}\n` : "") +
      (draft ? `DRAFT under discussion: ${JSON.stringify(draft)}\n` : "") +
      `Speech: "${text}"`;
    const out = await chatLLM({
      system: SYSTEM,
      user,
      maxTokens: 900,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    });
    if (!out) return null;
    const parsed = extractJson(out);
    if (!parsed || !parsed.intent) return null;
    return parsed;
  } catch (e) {
    console.error("[assistant] failed:", e.message);
    return null;
  }
}


// Morning briefing: a chief-of-staff style spoken summary of what needs attention.
const BRIEFING_SYSTEM = `You are Aide-Mémoire, a composed, dryly witty English butler AI serving as executive assistant. Original phrasing only — never imitate any film character. Given today's date and the user's ledger of important dates, compose ONE spoken briefing (max ~85 words): greet appropriately for the time of day, then cover what needs attention — anything inside its reminder window first (with the to-do), then notable items in the next two weeks. Mention same-day collisions if any. If a NEGLECTED list is provided, close with ONE gentle relationship-health nudge (e.g. "And if I may — it has been some time since anything was planned for X; perhaps a call."). If nothing is pressing, say so gracefully and note the next upcoming item. Address the speaker as "sir". Return ONLY the briefing text, no JSON, no quotes.`;

// People with no touchpoint on the horizon — the quiet relationship leaks.
export function neglectedPeople(entries) {
  const byName = {};
  for (const e of entries || []) {
    const k = e.name.toLowerCase();
    byName[k] = Math.min(byName[k] ?? Infinity, e.days_until);
  }
  return Object.entries(byName)
    .filter(([, days]) => days > 60)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, days]) => ({ name: name.replace(/\b\w/g, (c) => c.toUpperCase()), days_until_next: days }));
}

function templateBriefing(entries, hour) {
  const due = (entries || []).filter((e) => e.days_until <= e.remind_days).sort((a, b) => a.days_until - b.days_until);
  const soon = (entries || []).filter((e) => e.days_until > e.remind_days && e.days_until <= 14).sort((a, b) => a.days_until - b.days_until);
  const hello = hour < 12 ? "Good morning, sir." : hour < 18 ? "Good afternoon, sir." : "Good evening, sir.";
  if (!due.length && !soon.length) {
    const next = (entries || []).slice().sort((a, b) => a.days_until - b.days_until)[0];
    return `${hello} Nothing presses today.${next ? ` The next matter is ${next.name}, in ${next.days_until} days.` : " The ledger is empty — say the word and I shall begin it."}`;
  }
  const parts = due.slice(0, 3).map((e) => `${e.name} ${e.days_until === 0 ? "today" : "in " + e.days_until + " days"}${e.todo ? ", " + e.todo : ""}`);
  const neg = neglectedPeople(entries);
  const nudge = neg.length ? ` And if I may — nothing is planned for ${neg[0].name} in the next two months; perhaps a call.` : "";
  return (`${hello} ${due.length ? `Requiring attention: ${parts.join("; ")}.` : ""} ${soon.length ? `Also ahead: ${soon.slice(0, 2).map((e) => `${e.name} in ${e.days_until} days`).join(", ")}.` : ""}`.trim()) + nudge;
}

export async function briefing({ entries, today, hour }) {
  if (!providerConfig().key) return templateBriefing(entries, hour);
  try {
    const ledger = (entries || []).map((e) => ({
      name: e.name, occasion: e.occasion, next: e.next_occurrence, days_until: e.days_until,
      remind_days: e.remind_days, todo: e.todo || undefined, relationship: e.relationship || undefined,
    }));
    const neglected = neglectedPeople(entries);
    const out = await chatLLM({
      system: BRIEFING_SYSTEM,
      user: `Today is ${today}, hour ${hour}. LEDGER: ${JSON.stringify(ledger)}` +
        (neglected.length ? ` NEGLECTED: ${JSON.stringify(neglected)}` : ""),
      maxTokens: 320,
    });
    if (!out) return templateBriefing(entries, hour);
    return out.trim();
  } catch (e) {
    console.error("[briefing] failed:", e.message);
    return templateBriefing(entries, hour);
  }
}
