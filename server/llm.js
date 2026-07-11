// Turns free-form speech into a structured entry using the Anthropic API.
// Falls back gracefully (returns null) if no key is configured or the call fails.

const SYSTEM = `You convert spoken requests about remembering dates into strict JSON. The speaker wants to track an important date for someone and be emailed a reminder beforehand.

Return ONLY a JSON object, no prose, no markdown fences:
{
  "intent": "entry" | "save" | "cancel" | "edit_by_hand",
  "entry": {
    "name": string,              // who it's for, e.g. "Mother", "James", "The Hendersons". Capitalize. Empty string if truly not stated.
    "occasion": "birthday" | "anniversary" | "memorial" | "holiday" | "checkin" | "event",
    "date": "yyyy-mm-dd" | "",   // resolve relative dates ("next Friday") using the provided today. If a yearly date like a birthday, any future occurrence is fine.
    "yearly": boolean,           // birthdays/anniversaries/memorials/holidays: true. one-off events/check-ins: false, unless stated otherwise.
    "todo": string,              // what to arrange/do, e.g. "order white orchids". Empty if none.
    "remind_days": number        // days before to email. "two weeks before"=14, "a month"=30, "day before"=1, "on the day"=0. Default 7 if unstated.
  },
  "missing": string[],           // subset of ["name","date"] that could not be determined
  "reply": string                // ONE short spoken line (max ~18 words) in the voice of an impeccably mannered, dryly witty English butler AI. Address the speaker as "sir". Confirm what you understood or ask for the one missing detail. Never obsequious to the point of parody; composed, precise, faintly amused. Original phrasing only — do not quote or imitate lines from any film or franchise.
}

Rules:
- intent "save": the speaker is confirming ("yes", "keep it", "sounds good", "perfect", "save").
- intent "cancel": discarding ("no cancel", "never mind", "scrap that").
- intent "edit_by_hand": they want to type ("let me type", "open the form").
- Otherwise intent "entry".
- If a CURRENT DRAFT is provided, the speech is a correction or addition: merge it into the draft and return the complete updated entry. Only change fields the speaker mentioned. A bare name-like answer means the name; a bare date means the date.
- Never invent a name or date that wasn't stated. Speech-to-text may mangle words; interpret charitably (e.g. "remind me to weeks before" = "two weeks before").`;

export async function llmParse({ text, draft, today }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const user =
      `Today is ${today}.\n` +
      (draft ? `CURRENT DRAFT: ${JSON.stringify(draft)}\n` : "") +
      `Speech: "${text}"`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.PARSE_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      console.error("[parse] Anthropic API error:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const textOut = (data.content || []).map((b) => b.text || "").join("");
    const clean = textOut.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (!parsed || typeof parsed !== "object" || !parsed.intent) return null;
    return parsed;
  } catch (e) {
    console.error("[parse] failed:", e.message);
    return null;
  }
}
