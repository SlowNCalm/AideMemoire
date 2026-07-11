import { useMemo } from "react";
import { OCCASIONS } from "./lib.js";

// Which day of the shown month (yyyy-mm) an entry lands on, or null.
function dayInMonth(entry, ym) {
  const [y, m] = ym.split("-").map(Number);
  const [ey, em, ed] = entry.date.split("-").map(Number);
  if (entry.yearly) return em === m ? ed : null;
  return ey === y && em === m ? ed : null;
}

const monthLabel = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};
const shift = (ym, delta) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export default function Calendar({ entries, month, onMonth, onSelect }) {
  const { cells, byDay } = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const first = new Date(y, m - 1, 1);
    const daysInMonth = new Date(y, m, 0).getDate();
    const lead = first.getDay(); // 0 = Sunday
    const byDay = {};
    for (const e of entries) {
      const d = dayInMonth(e, month);
      if (d) (byDay[d] = byDay[d] || []).push(e);
    }
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    return { cells, byDay };
  }, [entries, month]);

  const now = new Date();
  const todayYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const todayDay = month === todayYm ? now.getDate() : null;

  return (
    <section style={{ marginTop: 26 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 22, fontWeight: 500, margin: 0 }}>{monthLabel(month)}</h2>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn quiet" style={{ padding: "6px 12px" }} onClick={() => onMonth(shift(month, -1))}>‹</button>
          <button className="btn quiet" style={{ padding: "6px 12px" }} onClick={() => onMonth(todayYm)}>Today</button>
          <button className="btn quiet" style={{ padding: "6px 12px" }} onClick={() => onMonth(shift(month, 1))}>›</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} style={{ textAlign: "center", fontSize: 11, color: "var(--faded)", textTransform: "uppercase", letterSpacing: "0.06em", padding: "4px 0" }}>{d}</div>
        ))}
        {cells.map((d, i) => {
          const items = d ? byDay[d] || [] : [];
          const crowded = items.length > 1;
          return (
            <div key={i} style={{
              minHeight: 76, borderRadius: 8, padding: "5px 6px",
              background: d ? "var(--panel)" : "transparent",
              border: `1px solid ${d === todayDay ? "var(--gold)" : d ? "var(--line)" : "transparent"}`,
            }}>
              {d && (
                <>
                  <div style={{ fontSize: 12, color: d === todayDay ? "var(--gold)" : "var(--faded)", fontWeight: d === todayDay ? 700 : 400, display: "flex", justifyContent: "space-between" }}>
                    <span>{d}</span>
                    {crowded && <span title="Multiple commitments" style={{ color: "var(--red)" }}>⚠</span>}
                  </div>
                  {items.map((e) => {
                    const occ = OCCASIONS.find((o) => o.id === e.occasion) || { emoji: "📌" };
                    return (
                      <button key={e.id} onClick={() => onSelect(e)}
                        title={`${e.name}${e.todo ? " — " + e.todo : ""}`}
                        style={{
                          display: "block", width: "100%", textAlign: "left", marginTop: 3,
                          background: "var(--gold-soft)", color: "var(--gold)", border: "none",
                          borderRadius: 5, padding: "2px 5px", fontSize: 11, fontWeight: 600,
                          cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                        {occ.emoji} {e.name}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 12, color: "var(--faded)", marginTop: 10 }}>
        Days marked ⚠ carry multiple commitments. Tap any name to review or edit. You can also just ask — "show me November", "back to the ledger".
      </p>
    </section>
  );
}
