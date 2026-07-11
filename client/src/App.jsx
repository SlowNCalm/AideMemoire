import { useState, useEffect, useRef, useCallback } from "react";
import {
  api, setToken, hasToken, clearToken,
  OCCASIONS, parseUtterance, fmtDate, humanDays,
  speak, stopSpeaking, draftSummary, parseCorrection,
} from "./lib.js";

// ============================================================ App shell
export default function App() {
  const [authed, setAuthed] = useState(hasToken());
  return authed
    ? <Dashboard onLogout={() => { clearToken(); setAuthed(false); }} />
    : <Gate onEnter={() => setAuthed(true)} />;
}

// ============================================================ Access gate
function Gate({ onEnter }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const { token } = await api.login(code);
      setToken(token);
      onEnter();
    } catch {
      setErr("That code wasn't recognized.");
    } finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 380, textAlign: "center" }}>
        <Wordmark />
        <p style={{ color: "var(--faded)", fontSize: 14, margin: "8px 0 28px" }}>
          Private access
        </p>
        <input
          type="password" placeholder="Access code" value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{ textAlign: "center", letterSpacing: "0.2em" }}
        />
        {err && <p style={{ color: "var(--red)", fontSize: 13 }}>{err}</p>}
        <button className="btn" style={{ width: "100%", marginTop: 14 }} disabled={busy || !code} onClick={submit}>
          Enter
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

// ============================================================ Dashboard
function Dashboard({ onLogout }) {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState(null);       // entry being created/edited in the form
  const [toast, setToast] = useState("");
  const toastTimer = useRef();

  const notify = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };

  const refresh = useCallback(async () => {
    try {
      setEntries(await api.list());
    } catch (e) {
      if (e.message === "unauthorized") onLogout();
    }
    setLoaded(true);
  }, [onLogout]);

  useEffect(() => { refresh(); }, [refresh]);

  const save = async (data) => {
    try {
      if (data.id) { await api.update(data); notify("Saved."); }
      else { await api.create(data); notify(`${data.name} added. You'll be emailed ${data.remind_days === 0 ? "on the day" : `${data.remind_days} day${data.remind_days === 1 ? "" : "s"} before`}.`); }
      setDraft(null);
      refresh();
    } catch (e) { notify(e.message); }
  };

  const remove = async (id) => {
    await api.remove(id).catch(() => {});
    refresh();
  };

  const testEmail = async () => {
    notify("Running a reminder sweep…");
    try {
      const r = await api.testReminder();
      notify(r.sent > 0 ? `Sent ${r.sent} reminder email(s). Check your inbox.` : "Nothing is inside its reminder window right now — no email sent.");
    } catch { notify("Sweep failed — check the server logs and your Resend key."); }
  };

  const sorted = [...entries].sort((a, b) => a.days_until - b.days_until);
  const attention = sorted.filter((e) => e.days_until <= e.remind_days);
  const later = sorted.filter((e) => !attention.includes(e));

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
          <button className="btn ghost" onClick={() => setDraft({})}>+ Add by hand</button>
        </div>
      </header>

      <VoicePanel onDraft={(d) => setDraft(d)} paused={draft !== null} />

      {toast && (
        <div className="card fadein" style={{ padding: "12px 16px", margin: "0 0 20px", borderColor: "var(--gold)", color: "var(--gold)", fontSize: 14 }}>
          {toast}
        </div>
      )}

      {attention.length > 0 && (
        <Section title="Requires your attention" accent>
          {attention.map((e) => (
            <EntryCard key={e.id} e={e} highlight onEdit={() => setDraft(e)} onDelete={() => remove(e.id)} />
          ))}
        </Section>
      )}

      <Section title={attention.length ? "On the horizon" : "Everyone"}>
        {loaded && entries.length === 0 && (
          <div style={{ border: "1.5px dashed var(--line)", borderRadius: 14, padding: "40px 24px", textAlign: "center", color: "var(--faded)", fontSize: 14 }}>
            Nothing kept yet. Tap the orb and say something like<br />
            <em style={{ color: "var(--ink)" }}>"My mother's birthday is March 12th — remind me two weeks before to order white orchids."</em>
          </div>
        )}
        {later.map((e) => (
          <EntryCard key={e.id} e={e} onEdit={() => setDraft(e)} onDelete={() => remove(e.id)} />
        ))}
      </Section>

      <footer style={{ marginTop: 40, textAlign: "right" }}>
        <button className="linklike" onClick={onLogout}>Sign out</button>
      </footer>

      {draft !== null && draft._fromVoice && !draft._manual && (
        <VoiceReview
          initial={draft}
          onSave={save}
          onCancel={() => setDraft(null)}
          onEditByHand={(d) => setDraft({ ...d, _manual: true })}
        />
      )}
      {draft !== null && (!draft._fromVoice || draft._manual) && (
        <EntryForm initial={draft} onCancel={() => setDraft(null)} onSubmit={save} />
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

// ============================================================ Voice panel
function VoicePanel({ onDraft, paused }) {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [micError, setMicError] = useState("");
  const recRef = useRef(null);
  const handsFreeRef = useRef(false);
  handsFreeRef.current = handsFree;
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    const rec = recRef.current;
    if (!rec) return;
    if (paused) { try { rec.abort(); } catch { /* noop */ } setListening(false); }
    else if (handsFreeRef.current) { try { rec.start(); setListening(true); } catch { /* noop */ } }
  }, [paused]);

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;

    rec.onresult = (ev) => {
      let interim = "", final = "";
      for (const r of ev.results) (r.isFinal ? (final += r[0].transcript) : (interim += r[0].transcript));
      setTranscript(final || interim);
      if (final.trim()) {
        const parsed = parseUtterance(final);
        onDraft({
          name: parsed.name, occasion: parsed.occasion, date: parsed.date,
          yearly: parsed.yearly, todo: parsed.todo, remind_days: parsed.remind_days,
          _fromVoice: true, _transcript: final.trim(),
        });
        setTranscript("");
      }
    };
    rec.onerror = (ev) => {
      setListening(false);
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed")
        setMicError("Microphone access was blocked. Allow the mic for this site in your browser's address bar, then try again.");
      else if (ev.error !== "aborted" && ev.error !== "no-speech")
        setMicError("Couldn't hear that. Try again.");
    };
    rec.onend = () => {
      setListening(false);
      // hands-free: resume listening automatically
      if (handsFreeRef.current && !pausedRef.current) {
        try { rec.start(); setListening(true); } catch { /* already started */ }
      }
    };
    recRef.current = rec;
    return () => { handsFreeRef.current = false; try { rec.abort(); } catch { /* noop */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () => {
    setMicError("");
    const rec = recRef.current;
    if (!rec) return;
    if (listening) { setHandsFree(false); rec.stop(); setListening(false); }
    else { try { rec.start(); setListening(true); } catch { /* noop */ } }
  };

  const toggleHandsFree = () => {
    setMicError("");
    const next = !handsFree;
    setHandsFree(next);
    const rec = recRef.current;
    if (next && rec && !listening) { try { rec.start(); setListening(true); } catch { /* noop */ } }
    if (!next && rec) { rec.stop(); setListening(false); }
  };

  if (!supported) {
    return (
      <div className="card" style={{ margin: "28px 0 20px", padding: "14px 18px", fontSize: 13, color: "var(--faded)" }}>
        Voice capture isn't supported in this browser — Chrome, Edge, or Safari will enable it. You can still add dates by hand.
      </div>
    );
  }

  return (
    <div className="card" style={{ margin: "28px 0 20px", padding: "22px 24px", display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
      <button
        className={"orb" + (listening ? " listening" : "")}
        onClick={toggle}
        aria-label={listening ? "Stop listening" : "Start dictating a date"}
        title={listening ? "Stop" : "Dictate"}
      >
        {listening ? "◉" : "🎙"}
      </button>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontFamily: "var(--serif)", fontSize: 19, fontStyle: transcript ? "normal" : "italic", color: transcript ? "var(--ink)" : "var(--faded)" }}>
          {transcript || (listening ? "Listening…" : "Tap the orb and speak — name, occasion, date, and what to arrange.")}
        </div>
        {micError
          ? <div style={{ fontSize: 12, color: "var(--red)", marginTop: 6 }}>{micError}</div>
          : <div style={{ fontSize: 12, color: "var(--faded)", marginTop: 6 }}>
              e.g. "James's board dinner is October 4th — remind me a week before to reserve the private room."
            </div>}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: handsFree ? "var(--gold)" : "var(--faded)", cursor: "pointer" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={handsFree} onChange={toggleHandsFree} />
        Hands-free
      </label>
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

// ============================================================ Voice review (hands-free confirm)
function VoiceReview({ initial, onSave, onCancel, onEditByHand }) {
  const [draft, setDraft] = useState(() => {
    const { _fromVoice, _manual, _transcript, ...d } = initial;
    return d;
  });
  const [phase, setPhase] = useState("speaking"); // speaking | listening | done
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const aliveRef = useRef(true);
  const recRef = useRef(null);

  const listenOnce = useCallback(() => new Promise((resolve) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return resolve("");
    const rec = new SR();
    recRef.current = rec;
    rec.lang = "en-US";
    rec.interimResults = true;
    let final = "";
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(final.trim()); } };
    rec.onresult = (ev) => {
      let interim = "";
      for (const r of ev.results) (r.isFinal ? (final += r[0].transcript) : (interim += r[0].transcript));
      setHeard(final || interim);
    };
    rec.onerror = finish;
    rec.onend = finish;
    try { rec.start(); } catch { finish(); }
    setTimeout(() => { try { rec.stop(); } catch { /* noop */ } }, 9000);
  }), []);

  const say = useCallback(async (text) => {
    setPhase("speaking");
    setCaption(text);
    await speak(text);
  }, []);

  // main conversation loop
  useEffect(() => {
    aliveRef.current = true;
    (async () => {
      let opener = null; // a question about a missing field, or the summary
      while (aliveRef.current) {
        const d = draftRef.current;
        const missing = !d.name ? "name" : !d.date ? "date" : null;

        if (opener) await say(opener);
        else if (missing === "name") await say(`I got the date but not the person. Who is this for?`);
        else if (missing === "date") await say(`I have ${d.name}, but no date. When is it?`);
        else await say(`${draftSummary(d)}. Shall I keep it?`);
        if (!aliveRef.current) return;
        opener = null;

        setPhase("listening");
        setHeard("");
        const reply = await listenOnce();
        if (!aliveRef.current) return;

        if (!reply) { opener = "I didn't catch that. You can say yes, cancel, or a correction."; continue; }

        // bare answers to a missing-field question
        if (missing === "name" && reply.split(" ").length <= 4 && !/\d/.test(reply)) {
          const name = reply.replace(/^(it'?s |for |my )/i, "").trim();
          setDraft((p) => ({ ...p, name: name.charAt(0).toUpperCase() + name.slice(1) }));
          continue;
        }

        const result = parseCorrection(reply, draftRef.current);
        if (result.action === "save") {
          const final = draftRef.current;
          if (!final.name || !final.date) { opener = "One more thing first."; continue; }
          aliveRef.current = false;
          setPhase("done");
          await speak(`Kept. I'll email you ${final.remind_days === 0 ? "on the day" : "before"}.`);
          onSave(final);
          return;
        }
        if (result.action === "cancel") {
          aliveRef.current = false;
          stopSpeaking();
          await speak("Discarded.");
          onCancel();
          return;
        }
        if (result.action === "edit") { aliveRef.current = false; stopSpeaking(); onEditByHand(draftRef.current); return; }
        if (result.action === "update") {
          setDraft(result.draft);
          opener = null; // loop re-reads the updated summary
          continue;
        }
        opener = "Sorry, I didn't get that. Say yes to keep it, or tell me what to change — the name, the date, the reminder, or the note.";
      }
    })();
    return () => {
      aliveRef.current = false;
      stopSpeaking();
      try { recRef.current?.abort(); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const occ = OCCASIONS.find((o) => o.id === draft.occasion) || { emoji: "📌", label: "Date" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(10,9,7,0.78)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
      <div className="card fadein" style={{ padding: 28, width: "100%", maxWidth: 480, background: "var(--bg)", textAlign: "center" }}>
        <div className={"orb" + (phase === "listening" ? " listening" : "")}
          style={{ margin: "0 auto 18px", cursor: "default" }} aria-hidden="true">
          {phase === "listening" ? "◉" : "🔊"}
        </div>

        <div style={{ fontFamily: "var(--serif)", fontSize: 24, fontWeight: 600 }}>
          {occ.emoji} {draft.name || "—"}
        </div>
        <div style={{ color: "var(--faded)", fontSize: 14, marginTop: 4 }}>
          {occ.label}{draft.date ? ` · ${fmtDate(draft.date)}` : " · date needed"}
          {" · "}{draft.remind_days === 0 ? "reminder on the day" : `reminder ${draft.remind_days}d before`}
        </div>
        {draft.todo && (
          <div style={{ fontSize: 14, marginTop: 12, padding: "9px 13px", background: "var(--panel-2)", borderRadius: 8, borderLeft: "2px solid var(--gold)", textAlign: "left" }}>
            {draft.todo}
          </div>
        )}

        <div style={{ marginTop: 18, minHeight: 40, fontSize: 14, color: phase === "listening" ? "var(--gold)" : "var(--faded)", fontStyle: "italic" }}>
          {phase === "listening" ? (heard || "Listening… say yes, a correction, or cancel.") : caption}
        </div>

        <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 20 }}>
          <button className="btn quiet" onClick={() => { aliveRef.current = false; stopSpeaking(); onCancel(); }}>Cancel</button>
          <button className="btn ghost" onClick={() => { aliveRef.current = false; stopSpeaking(); onEditByHand(draftRef.current); }}>Edit by hand</button>
          <button className="btn" disabled={!draft.name || !draft.date}
            onClick={() => { aliveRef.current = false; stopSpeaking(); onSave(draftRef.current); }}>
            Keep it
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================ Entry form
function EntryForm({ initial, onCancel, onSubmit }) {
  const fromVoice = initial._fromVoice;
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
          {initial.id ? "Edit" : fromVoice ? "Heard you — confirm the details" : "Add a date"}
        </h2>
        {fromVoice && (
          <p style={{ fontSize: 13, color: "var(--faded)", fontStyle: "italic", margin: "8px 0 0" }}>
            "{initial._transcript}"
          </p>
        )}

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
