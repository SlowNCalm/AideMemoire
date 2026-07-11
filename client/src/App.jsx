import { useState, useEffect, useRef, useCallback } from "react";
import {
  api, setToken, hasToken, clearToken,
  OCCASIONS, parseUtterance, fmtDate, humanDays,
  speak, stopSpeaking, draftSummary, parseCorrection, persona, leadPhrase,
} from "./lib.js";
import Calendar from "./Calendar.jsx";

// ============================================================ App shell
export default function App() {
  const [authed, setAuthed] = useState(hasToken());
  return authed
    ? <Dashboard onLogout={() => { clearToken(); setAuthed(false); }} />
    : <Gate onEnter={() => setAuthed(true)} />;
}

// ============================================================ Auth (email + password)
function Gate({ onEnter }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const r = mode === "login" ? await api.login(email, password) : await api.signup(email, password, invite);
      setToken(r.token);
      onEnter();
    } catch (e) { setErr(e.message || "Something went wrong."); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center" }}>
          <Wordmark />
          <p style={{ color: "var(--faded)", fontSize: 14, margin: "8px 0 24px" }}>
            Your executive assistant for the dates that matter.
          </p>
        </div>
        <div style={{ display: "flex", gap: 0, marginBottom: 18, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
          {["login", "signup"].map((m) => (
            <button key={m} onClick={() => { setMode(m); setErr(""); }}
              style={{ flex: 1, padding: "10px 0", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
                background: mode === m ? "var(--gold)" : "transparent", color: mode === m ? "#16130d" : "var(--faded)" }}>
              {m === "login" ? "Log in" : "Create account"}
            </button>
          ))}
        </div>
        <input type="email" placeholder="Email — this is where reminders go" value={email}
          onChange={(e) => setEmail(e.target.value)} style={{ marginBottom: 10 }} />
        <input type="password" placeholder={mode === "signup" ? "Password (8+ characters)" : "Password"} value={password}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} style={{ marginBottom: 10 }} />
        {mode === "signup" && (
          <input placeholder="Invite code (if required)" value={invite}
            onChange={(e) => setInvite(e.target.value)} style={{ marginBottom: 10 }} />
        )}
        {err && <p style={{ color: "var(--red)", fontSize: 13, margin: "4px 0 10px" }}>{err}</p>}
        <button className="btn" style={{ width: "100%" }} disabled={busy || !email || !password} onClick={submit}>
          {mode === "login" ? "Enter" : "Begin"}
        </button>
      </div>
    </div>
  );
}

function Wordmark({ size = 34 }) {
  return (
    <h1 style={{ fontFamily: "var(--serif)", fontWeight: 500, fontSize: size, margin: 0, letterSpacing: "0.02em" }}>
      Aide-<span style={{ color: "var(--gold)", fontStyle: "italic" }}>Mémoire</span>
    </h1>
  );
}

// ============================================================ shared listening helper
// Listens until ~2s of silence after speech (or maxMs). Never cuts you off mid-sentence.
export function listenUntilSilence({ silenceMs = 2000, maxMs = 45000, noSpeechMs = 8000, onPartial } = {}) {
  return new Promise((resolve) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return resolve({ text: "", supported: false });
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;

    let finalBuf = "", interimBuf = "", settled = false, heardAnything = false;
    let silenceTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(silenceTimer);
      clearTimeout(noSpeechTimer);
      clearTimeout(maxTimer);
      try { rec.stop(); } catch { /* noop */ }
      resolve({ text: (finalBuf || interimBuf).trim(), supported: true, stop });
    };
    const stop = () => finish();

    const armSilence = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(finish, silenceMs);
    };

    const noSpeechTimer = setTimeout(() => { if (!heardAnything) finish(); }, noSpeechMs);
    const maxTimer = setTimeout(finish, maxMs);

    rec.onresult = (ev) => {
      heardAnything = true;
      finalBuf = ""; interimBuf = "";
      for (const r of ev.results) (r.isFinal ? (finalBuf += r[0].transcript + " ") : (interimBuf += r[0].transcript));
      onPartial?.((finalBuf + interimBuf).trim());
      armSilence();
    };
    rec.onerror = finish;
    rec.onend = () => { if (!settled && (finalBuf || interimBuf)) finish(); else if (!settled) finish(); };
    try { rec.start(); } catch { finish(); }
  });
}

// ============================================================ Dashboard
function Dashboard({ onLogout }) {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [voiceSeed, setVoiceSeed] = useState(null); // {utterance, result} handed to VoiceReview
  const [manualDraft, setManualDraft] = useState(null);
  const [view, setView] = useState("list");           // "list" | "calendar"
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [thinking, setThinking] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef();

  const notify = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  };

  const refresh = useCallback(async () => {
    try { setEntries(await api.list()); }
    catch (e) { if (e.message === "unauthorized") onLogout(); }
    setLoaded(true);
  }, [onLogout]);

  useEffect(() => { refresh(); }, [refresh]);

  const save = async (data) => {
    try {
      const r = data.id ? await api.update(data) : await api.create(data);
      let msg = data.id ? "Saved." : `${data.name} — kept. Email ${data.remind_days === 0 ? "on the day" : `${data.remind_days}d before`}.`;
      if (r.conflicts?.length) {
        const names = r.conflicts.map((c) => c.name);
        msg += ` ⚠ Same day as ${names.join(", ")}.`;
        speak(persona.conflict(names));
      }
      notify(msg);
      setManualDraft(null); setVoiceSeed(null);
      refresh();
    } catch (e) { notify(e.message); }
  };

  // route every utterance through the assistant
  const handleUtterance = async (text) => {
    setThinking(true);
    let result = null;
    try { result = await api.assistant(text, null); } catch { /* offline/401 handled below */ }
    setThinking(false);

    if (!result || result.fallback) {
      // no AI key on the server — basic local routing
      const lower = text.toLowerCase();
      if (/\b(calendar|month view)\b/.test(lower)) { setView("calendar"); speak(persona.showCalendar()); return; }
      if (/\b(list|ledger)\b/.test(lower) && lower.split(" ").length <= 5) { setView("list"); speak(persona.showList()); return; }
      setVoiceSeed({ utterance: text, result: null });
      return;
    }

    switch (result.intent) {
      case "entry":
        setVoiceSeed({ utterance: text, result });
        break;
      case "show":
        if (result.view) setView(result.view);
        if (result.month) setMonth(result.month);
        if (result.view === "calendar" || result.month) setView("calendar");
        if (result.reply) speak(result.reply);
        break;
      case "delete":
        if (result.delete_id) { await api.remove(result.delete_id).catch(() => {}); refresh(); }
        if (result.reply) { speak(result.reply); notify(result.reply); }
        break;
      case "answer":
      case "none":
      default:
        if (result.reply) { speak(result.reply); notify(result.reply); }
        break;
    }
  };

  const remove = async (id) => { await api.remove(id).catch(() => {}); refresh(); };

  const testEmail = async () => {
    notify("Running a reminder sweep…");
    try {
      const r = await api.testReminder();
      notify(r.sent > 0 ? `Sent ${r.sent} reminder email(s). Check your inbox.` : "Nothing inside its reminder window right now — no email sent.");
    } catch { notify("Sweep failed — check server logs and the Resend key."); }
  };

  const sorted = [...entries].sort((a, b) => a.days_until - b.days_until);
  const attention = sorted.filter((e) => e.days_until <= e.remind_days);
  const later = sorted.filter((e) => !attention.includes(e));
  const busy = voiceSeed !== null || manualDraft !== null || thinking;

  return (
    <div style={{ maxWidth: 780, margin: "0 auto", padding: "44px 20px 100px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div>
          <Wordmark />
          <p style={{ color: "var(--faded)", fontSize: 14, margin: "6px 0 0", maxWidth: 460 }}>
            Speak a date once. It's kept, and you're emailed before it arrives.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn quiet" onClick={testEmail}>Send test email</button>
          <button className="btn ghost" onClick={() => setManualDraft({})}>+ Add by hand</button>
        </div>
      </header>

      <VoicePanel paused={busy} onUtterance={handleUtterance} />

      <div style={{ display: "flex", gap: 8, margin: "0 0 18px" }}>
        {[["list", "Ledger"], ["calendar", "Calendar"]].map(([v, label]) => (
          <button key={v} onClick={() => setView(v)}
            style={{ padding: "7px 16px", borderRadius: 999, fontSize: 13, cursor: "pointer", fontWeight: view === v ? 600 : 400,
              border: `1px solid ${view === v ? "var(--gold)" : "var(--line)"}`,
              background: view === v ? "var(--gold-soft)" : "transparent",
              color: view === v ? "var(--gold)" : "var(--faded)" }}>
            {label}
          </button>
        ))}
        {thinking && <span style={{ alignSelf: "center", fontSize: 13, color: "var(--faded)", fontStyle: "italic" }}>One moment…</span>}
      </div>

      {toast && (
        <div className="card fadein" style={{ padding: "12px 16px", margin: "0 0 20px", borderColor: "var(--gold)", color: "var(--gold)", fontSize: 14 }}>
          {toast}
        </div>
      )}

      {view === "calendar" && (
        <Calendar entries={entries} month={month} onMonth={setMonth}
          onSelect={(e) => setManualDraft(e)} />
      )}

      {view === "list" && attention.length > 0 && (
        <Section title="Requires your attention" accent>
          {attention.map((e) => (
            <EntryCard key={e.id} e={e} highlight onEdit={() => setManualDraft(e)} onDelete={() => remove(e.id)} />
          ))}
        </Section>
      )}

      {view === "list" && (
      <Section title={attention.length ? "On the horizon" : "Everyone"}>
        {loaded && entries.length === 0 && (
          <div style={{ border: "1.5px dashed var(--line)", borderRadius: 14, padding: "40px 24px", textAlign: "center", color: "var(--faded)", fontSize: 14 }}>
            Nothing kept yet. Tap the orb and say something like<br />
            <em style={{ color: "var(--ink)" }}>"My mother's birthday is March 12th — remind me two weeks before to order white orchids."</em>
          </div>
        )}
        {later.map((e) => (
          <EntryCard key={e.id} e={e} onEdit={() => setManualDraft(e)} onDelete={() => remove(e.id)} />
        ))}
      </Section>
      )}

      <footer style={{ marginTop: 40, textAlign: "right" }}>
        <button className="linklike" onClick={() => { api.logout(); onLogout(); }}>Sign out</button>
      </footer>

      {voiceSeed !== null && (
        <VoiceReview
          utterance={voiceSeed.utterance}
          seed={voiceSeed.result}
          onSave={save}
          onCancel={() => setVoiceSeed(null)}
          onEditByHand={(d) => { setVoiceSeed(null); setManualDraft(d); }}
        />
      )}
      {manualDraft !== null && (
        <EntryForm initial={manualDraft} onCancel={() => setManualDraft(null)} onSubmit={save} />
      )}
    </div>
  );
}

function Section({ title, accent, children }) {
  return (
    <section style={{ marginTop: 34 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 22, fontWeight: 500, margin: 0, color: accent ? "var(--gold)" : "var(--ink)" }}>
          {title}
        </h2>
        <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
      </div>
      {children}
    </section>
  );
}

// ============================================================ Voice panel (capture)
// Wake word (hands-free mode only). Tolerant of common speech-to-text mishears.
const WAKE_RE = /\b(?:hey|hay|ok|okay)?[\s,]*(?:jarvis|jarvus|jervis|jarves|travis|davis)\b[,.!]?\s*/i;

function VoicePanel({ onUtterance, paused }) {
  const [supported] = useState(() => !!(window.SpeechRecognition || window.webkitSpeechRecognition));
  const [listening, setListening] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [micError, setMicError] = useState("");
  const sessionRef = useRef(null);
  const handsFreeRef = useRef(false);
  const pausedRef = useRef(false);
  handsFreeRef.current = handsFree;
  pausedRef.current = paused;

  const startSession = useCallback(async () => {
    if (sessionRef.current) return;
    sessionRef.current = true;
    setMicError("");

    // Hands-free: listen forever, but only act on "Hey Jarvis …"
    while (!pausedRef.current) {
      setListening(true);
      const { text, supported: ok } = await listenUntilSilence({
        silenceMs: 2200, maxMs: 60000,
        noSpeechMs: handsFreeRef.current ? 60000 : 12000, // patient while standing by
        onPartial: setTranscript,
      });
      setListening(false);
      setTranscript("");
      if (!ok) { setMicError("Microphone unavailable. Allow mic access for this site, then try again."); break; }

      if (!handsFreeRef.current) {
        // tap-to-talk: the tap was the signal, no wake word needed
        if (text) onUtterance(text);
        break;
      }

      // hands-free: require the wake word
      const m = text.match(WAKE_RE);
      if (!m) continue; // not addressed to us — keep standing by

      let command = text.slice(m.index + m[0].length).trim();
      if (!command) {
        // "Hey Jarvis." on its own → acknowledge and take the next sentence as the command
        await speak(persona.acknowledge());
        if (pausedRef.current) break;
        setListening(true);
        const follow = await listenUntilSilence({ silenceMs: 2200, maxMs: 60000, noSpeechMs: 10000, onPartial: setTranscript });
        setListening(false);
        setTranscript("");
        command = (follow.text || "").replace(WAKE_RE, "").trim();
      }
      if (command) { onUtterance(command); break; } // review opens; loop resumes when it closes
    }
    sessionRef.current = null;
  }, [onUtterance]);

  // resume hands-free listening when a review closes
  useEffect(() => {
    if (!paused && handsFreeRef.current) startSession();
  }, [paused, startSession]);

  const toggle = () => {
    if (listening) { setHandsFree(false); /* session ends itself on silence */ }
    else startSession();
  };
  const toggleHandsFree = () => {
    const next = !handsFree;
    setHandsFree(next);
    if (next && !listening) startSession();
  };

  if (!supported) {
    return (
      <div className="card" style={{ margin: "28px 0 20px", padding: "14px 18px", fontSize: 13, color: "var(--faded)" }}>
        Voice capture isn't supported in this browser — Chrome, Edge, or Safari will enable it. You can still add dates by hand.
      </div>
    );
  }

  return (
    <div className="card" style={{ margin: "28px 0 20px", padding: "22px 24px", display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap", opacity: paused ? 0.5 : 1 }}>
      <button
        className={"orb" + (listening ? " listening" : "")}
        onClick={toggle}
        disabled={paused}
        aria-label={listening ? "Listening" : "Start dictating a date"}
      >
        {listening ? "◉" : "🎙"}
      </button>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontFamily: "var(--serif)", fontSize: 19, fontStyle: transcript ? "normal" : "italic", color: transcript ? "var(--ink)" : "var(--faded)" }}>
          {transcript || (listening
            ? (handsFree ? 'Standing by, sir — say "Hey Jarvis" followed by your request.' : "Listening — take your time, I'll wait for a pause.")
            : "Tap the orb and speak — name, occasion, date, and what to arrange.")}
        </div>
        {micError
          ? <div style={{ fontSize: 12, color: "var(--red)", marginTop: 6 }}>{micError}</div>
          : <div style={{ fontSize: 12, color: "var(--faded)", marginTop: 6 }}>
              {handsFree
                ? 'e.g. "Hey Jarvis, James\'s board dinner is October 4th — remind me a week before to reserve the private room."'
                : 'e.g. "James\'s board dinner is October 4th — remind me a week before to reserve the private room."'}
            </div>}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: handsFree ? "var(--gold)" : "var(--faded)", cursor: "pointer" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={handsFree} onChange={toggleHandsFree} />
        Hands-free · "Hey Jarvis"
      </label>
    </div>
  );
}

// ============================================================ Voice review — understand, confirm once, auto-save
function VoiceReview({ utterance, seed, onSave, onCancel, onEditByHand }) {
  const [draft, setDraft] = useState(null);
  const [phase, setPhase] = useState("thinking"); // thinking | speaking | listening | saving
  const [caption, setCaption] = useState("Understanding…");
  const [heard, setHeard] = useState("");
  const aliveRef = useRef(true);
  const draftRef = useRef(null);
  draftRef.current = draft;

  const parse = useCallback(async (text, currentDraft) => {
    try {
      const r = await api.assistant(text, currentDraft);
      if (r && !r.fallback) return r;
    } catch { /* fall through to local */ }
    // local heuristic fallback (no ANTHROPIC_API_KEY on server)
    if (!currentDraft) {
      const p = parseUtterance(text);
      return { intent: "entry", entry: { name: p.name, occasion: p.occasion, date: p.date, yearly: p.yearly, todo: p.todo, remind_days: p.remind_days }, missing: [!p.name && "name", !p.date && "date"].filter(Boolean) };
    }
    const c = parseCorrection(text, currentDraft);
    if (c.action === "save") return { intent: "save" };
    if (c.action === "cancel") return { intent: "cancel" };
    if (c.action === "edit") return { intent: "edit_by_hand" };
    if (c.action === "update") return { intent: "entry", entry: c.draft, missing: [] };
    return { intent: "entry", entry: currentDraft, missing: [], unclear: true };
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    (async () => {
      // 1. understand the initial utterance (or reuse the dashboard's parse)
      let result = seed || await parse(utterance, null);
      if (!aliveRef.current) return;

      let firstPass = true;
      while (aliveRef.current) {
        if (result.intent === "cancel") { await speak(persona.cancelled()); onCancel(); return; }
        if (result.intent === "edit_by_hand") { onEditByHand(draftRef.current || {}); return; }
        if (result.intent === "save" && draftRef.current?.name && draftRef.current?.date) break;

        const entry = result.entry || draftRef.current;
        if (entry) setDraft(entry);
        const d = entry || {};
        const missing = !d.name ? "name" : !d.date ? "date" : null;

        // 2. speak — either a single missing-field question, or the summary with auto-save notice
        setPhase("speaking");
        const conflictLine = result.conflicts?.length ? " " + persona.conflict(result.conflicts.map((c) => c.name)) : "";
        let prompt;
        if (missing === "name") prompt = result.reply || persona.askName();
        else if (missing === "date") prompt = result.reply || persona.askDate(d.name);
        else if (result.unclear) prompt = persona.unclear();
        else if (result.reply && firstPass) prompt = `${result.reply}${conflictLine} ${persona.savingSuffix()}`;
        else prompt = `${persona.confirmPrefix()} ${draftSummary(d)}.${conflictLine} ${persona.savingSuffix()}`;
        setCaption(prompt);
        await speak(prompt);
        if (!aliveRef.current) return;

        // 3. listen: short grace window on a complete summary, generous window for answers
        setPhase("listening");
        setHeard("");
        const { text } = await listenUntilSilence({
          silenceMs: 2000,
          maxMs: 30000,
          noSpeechMs: missing || result.unclear ? 10000 : 3500, // 3.5s of silence on a summary = consent
          onPartial: setHeard,
        });
        if (!aliveRef.current) return;

        if (!text) {
          if (!missing && !result.unclear) break; // silence after summary → save
          setCaption(persona.stillThere());
          result = { intent: "entry", entry: draftRef.current, missing: [], unclear: true };
          continue;
        }

        // interruption or answer → re-parse with context
        setPhase("thinking");
        setCaption("One moment…");
        result = await parse(text, draftRef.current);
        firstPass = false;
      }

      // 4. save
      if (!aliveRef.current) return;
      const final = draftRef.current;
      setPhase("saving");
      speak(persona.saved(leadPhrase(final.remind_days)));
      onSave(final);
    })();
    return () => { aliveRef.current = false; stopSpeaking(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const d = draft || {};
  const occ = OCCASIONS.find((o) => o.id === d.occasion) || { emoji: "📌", label: "Date" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(10,9,7,0.78)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
      <div className="card fadein" style={{ padding: 28, width: "100%", maxWidth: 480, background: "var(--bg)", textAlign: "center" }}>
        <div className={"orb" + (phase === "listening" ? " listening" : "")}
          style={{ margin: "0 auto 18px", cursor: "default" }} aria-hidden="true">
          {phase === "listening" ? "◉" : phase === "thinking" ? "…" : "🔊"}
        </div>

        {draft ? (
          <>
            <div style={{ fontFamily: "var(--serif)", fontSize: 24, fontWeight: 600 }}>
              {occ.emoji} {d.name || "—"}
            </div>
            <div style={{ color: "var(--faded)", fontSize: 14, marginTop: 4 }}>
              {occ.label}{d.date ? ` · ${fmtDate(d.date)}` : " · date needed"}
              {" · "}{d.remind_days === 0 ? "reminder on the day" : `reminder ${d.remind_days}d before`}
            </div>
            {d.todo && (
              <div style={{ fontSize: 14, marginTop: 12, padding: "9px 13px", background: "var(--panel-2)", borderRadius: 8, borderLeft: "2px solid var(--gold)", textAlign: "left" }}>
                {d.todo}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontFamily: "var(--serif)", fontSize: 19, fontStyle: "italic", color: "var(--faded)" }}>
            "{utterance}"
          </div>
        )}

        <div style={{ marginTop: 18, minHeight: 40, fontSize: 14, color: phase === "listening" ? "var(--gold)" : "var(--faded)", fontStyle: "italic" }}>
          {phase === "listening" ? (heard || caption) : caption}
        </div>

        <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 20 }}>
          <button className="btn quiet" onClick={() => { aliveRef.current = false; stopSpeaking(); onCancel(); }}>Cancel</button>
          <button className="btn ghost" onClick={() => { aliveRef.current = false; stopSpeaking(); onEditByHand(draftRef.current || {}); }}>Edit by hand</button>
          <button className="btn" disabled={!d.name || !d.date}
            onClick={() => { aliveRef.current = false; stopSpeaking(); onSave(draftRef.current); }}>
            Keep it
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================ Entry card
function EntryCard({ e, highlight, onEdit, onDelete }) {
  const [confirm, setConfirm] = useState(false);
  const occ = OCCASIONS.find((o) => o.id === e.occasion) || { emoji: "📌", label: "Date" };
  return (
    <div className="card fadein" style={{ padding: "16px 18px", marginBottom: 10, borderLeft: `3px solid ${highlight ? "var(--gold)" : "var(--line)"}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--serif)", fontSize: 21, fontWeight: 600 }}>{occ.emoji} {e.name}</span>
            <span style={{ color: "var(--faded)", fontSize: 13 }}>{occ.label}</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--faded)", marginTop: 4 }}>
            {fmtDate(e.next_occurrence)}{e.yearly ? " · repeats yearly" : ""} · reminder {e.remind_days === 0 ? "on the day" : `${e.remind_days}d before`}
          </div>
          {e.todo && (
            <div style={{ fontSize: 14, marginTop: 10, padding: "9px 13px", background: "var(--panel-2)", borderRadius: 8, borderLeft: "2px solid var(--gold)" }}>
              {e.todo}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
          <span className="chip" style={{
            background: e.days_until <= 1 ? "var(--red-soft)" : e.days_until <= e.remind_days ? "var(--gold-soft)" : "var(--panel-2)",
            color: e.days_until <= 1 ? "var(--red)" : e.days_until <= e.remind_days ? "var(--gold)" : "var(--faded)",
          }}>
            {humanDays(e.days_until)}
          </span>
          <div style={{ display: "flex", gap: 12 }}>
            <button className="linklike" onClick={onEdit}>Edit</button>
            {!confirm
              ? <button className="linklike" onClick={() => setConfirm(true)}>Delete</button>
              : <button className="linklike" style={{ color: "var(--red)", fontWeight: 700 }} onClick={onDelete}>Confirm?</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================ Entry form (manual fallback)
function EntryForm({ initial, onCancel, onSubmit }) {
  const [name, setName] = useState(initial.name || "");
  const [occasion, setOccasion] = useState(initial.occasion || "birthday");
  const [date, setDate] = useState(initial.date || "");
  const [yearly, setYearly] = useState(initial.yearly ?? true);
  const [todo, setTodo] = useState(initial.todo || "");
  const [remind, setRemind] = useState(initial.remind_days ?? 7);
  const valid = name.trim() && date;

  const label = { display: "block", fontSize: 11, fontWeight: 600, color: "var(--faded)", textTransform: "uppercase", letterSpacing: "0.08em", margin: "18px 0 7px" };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(10,9,7,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}
      onClick={(ev) => ev.target === ev.currentTarget && onCancel()}
    >
      <div className="card fadein" style={{ padding: 26, width: "100%", maxWidth: 480, maxHeight: "92vh", overflowY: "auto", background: "var(--bg)" }}>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 24, fontWeight: 500, margin: 0 }}>
          {initial.id ? "Edit" : "Add a date"}
        </h2>

        <label style={label}>Who is this for?</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mother, James, the Hendersons…" autoFocus={!name} />

        <label style={label}>Occasion</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {OCCASIONS.map((o) => (
            <button key={o.id} onClick={() => { setOccasion(o.id); setYearly(o.yearly); }}
              style={{
                padding: "7px 13px", borderRadius: 999, fontSize: 13, cursor: "pointer",
                border: `1px solid ${occasion === o.id ? "var(--gold)" : "var(--line)"}`,
                background: occasion === o.id ? "var(--gold-soft)" : "transparent",
                color: occasion === o.id ? "var(--gold)" : "var(--ink)",
                fontWeight: occasion === o.id ? 600 : 400,
              }}>
              {o.emoji} {o.label}
            </button>
          ))}
        </div>

        <label style={label}>Date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, marginTop: 12, cursor: "pointer" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={yearly} onChange={(e) => setYearly(e.target.checked)} />
          Repeats every year
        </label>

        <label style={label}>What should be arranged?</label>
        <textarea rows={3} value={todo} onChange={(e) => setTodo(e.target.value)}
          placeholder="Order white orchids, reserve the private room, have a card couriered…" />

        <label style={label}>Email me</label>
        <select value={remind} onChange={(e) => setRemind(Number(e.target.value))}>
          <option value={0}>On the day</option>
          <option value={1}>1 day before</option>
          <option value={3}>3 days before</option>
          <option value={7}>1 week before</option>
          <option value={14}>2 weeks before</option>
          <option value={30}>1 month before</option>
        </select>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 26 }}>
          <button className="btn quiet" onClick={onCancel}>Cancel</button>
          <button className="btn" disabled={!valid}
            onClick={() => onSubmit({
              id: initial.id, name: name.trim(), occasion, date, yearly,
              todo: todo.trim(), remind_days: remind,
            })}>
            {initial.id ? "Save changes" : "Keep this date"}
          </button>
        </div>
      </div>
    </div>
  );
}
