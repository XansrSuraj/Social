import { useCallback, useEffect, useState } from "react";
import { Activity, ArrowUpRight, BellRing, Loader2, Play, Radio, RefreshCw } from "lucide-react";
import { BrandIcon, useApp } from "../app/core.jsx";

/* The FM → channels pipeline, live: every card FM sent, and what became of it on each channel.
   Reads /api/pipeline (the ledger the 5-minute tick keeps); nothing here judges anything itself. */

const STATUS = {
  verified:       { g: "✓", cls: "ok",   t: "on the channel" },
  late:           { g: "✓", cls: "okh",  t: "arrived late" },
  waiting:        { g: "⏳", cls: "none", t: "checking — inside the 20-min window" },
  new:            { g: "⏳", cls: "none", t: "just seen" },
  missing:        { g: "✗", cls: "miss", t: "not on the channel after 20 min" },
  reader_failed:  { g: "!", cls: "lang", t: "the channel couldn't be read" },
  assumed:        { g: "≈", cls: "okc",  t: "Viber — taken on FM's word" },
  unwatched:      { g: "–", cls: "na",   t: "not watched yet (link missing)" },
  unverifiable:   { g: "?", cls: "na",   t: "can't be checked (Instagram 18+)" },
  fm_pending:     { g: "…", cls: "none", t: "FM hasn't sent it yet" },
  fm_failed:      { g: "✗", cls: "miss", t: "FM failed to send it" },
  fm_unconfirmed: { g: "?", cls: "lang", t: "FM can't confirm" },
  unchecked:      { g: "·", cls: "na",   t: "not checked — sent before the pipeline was watching" },
};
const ICON = { telegram_direct: "tgbot" };
const LANG = { vietnamese: "VN", english: "EN", portuguese: "PT", hindi: "HI" };
const ist = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16);
const istDay = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const ago = ms => { if (!ms) return "never"; const m = Math.round((Date.now() - ms) / 60e3); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago"; };

export default function Live() {
  const { toast } = useApp();
  const [s, setS] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [day, setDay] = useState(istDay(Date.now()));
  const load = useCallback(async () => {
    try { const r = await fetch("api/pipeline", { cache: "no-store" }); const j = await r.json(); if (!j.ok) throw new Error(j.error || "failed"); setS(j); setErr(""); }
    catch (e) { setErr(String(e.message || e)); }
  }, []);
  useEffect(() => { load(); const t = setInterval(() => { if (!document.hidden) load(); }, 20000); return () => clearInterval(t); }, [load]);

  const act = async (op, label) => {
    setBusy(op);
    try {
      const r = await fetch("api/pipeline?op=" + op, { cache: "no-store" }); const j = await r.json();
      toast(j.skipped ? `Skipped — ${j.skipped}` : j.ok ? `${label} done` : (j.error || `${label} failed`), j.ok ? "check-check" : "triangle-alert");
      await load();
    } catch (e) { toast(String(e.message || e), "triangle-alert"); }
    setBusy("");
  };

  if (!s) return (
    <section className="rp-head"><div className="wrap">
      <span className="eyebrow">SportsFC · Live pipeline</span>
      <h1 className="display l">FM → <b>every channel</b></h1>
      <p className="rp-when">{err ? "Couldn't load the pipeline — " + err : <><Loader2 className="spin" style={{ width: 16, verticalAlign: -3 }} /> Loading…</>}</p>
    </div></section>
  );

  const days = [...new Set(s.deliveries.map(e => istDay(e.when)))].sort().reverse();
  const list = s.deliveries.filter(e => istDay(e.when) === day);
  const sets = {};
  for (const e of list) (sets[e.dropKey || e.setId] = sets[e.dropKey || e.setId] || []).push(e);
  const drops = Object.values(sets).sort((a, b) => Math.min(...b.map(e => e.when)) - Math.min(...a.map(e => e.when)));
  const checked = list.filter(e => e.mode === "verify" && e.fmState === "sent" && e.status !== "unverifiable");
  const okN = checked.filter(e => e.status === "verified" || e.status === "late").length;
  const problems = list.filter(e => ["missing", "fm_failed", "reader_failed", "fm_unconfirmed"].includes(e.status)).length;
  const readers = Object.entries(s.readers || {});
  const down = readers.filter(([, h]) => h.down);
  const tickFresh = s.lastTickAt && Date.now() - s.lastTickAt < 12 * 60e3;

  return (
    <>
      <section className="rp-head">
        <div className="wrap">
          <div className="rp-head-row">
            <div>
              <span className="eyebrow">SportsFC · Live pipeline</span>
              <h1 className="display l">FM → <b>every channel</b></h1>
              <div className="rp-when">Every card FM sends is looked for on each channel within 20 minutes — automatically, every 5 minutes. Every result and problem goes to Teams, your phone (ntfy) and WhatsApp.</div>
            </div>
            <div className="rp-actions">
              <button className="btn btn-line btn-sm" disabled={!!busy} onClick={() => act("tick", "Check")}>{busy === "tick" ? <Loader2 className="spin" /> : <Play />}Check now</button>
              <button className="btn btn-line btn-sm" disabled={!!busy || !(s.whatsapp.configured || s.whatsapp.push || s.whatsapp.teams)} onClick={() => act("test-alert", "Test alert")}
                title={s.whatsapp.configured || s.whatsapp.push || s.whatsapp.teams ? "Send one test alert (once per 10 min)" : "No alert channel is set up yet"}><BellRing />Test alert</button>
              <button className="btn btn-line btn-sm" onClick={load}><RefreshCw />Refresh</button>
            </div>
          </div>
        </div>
      </section>

      <section className="section tight" style={{ paddingTop: 24 }}>
        <div className="wrap">
          <div className="stats live-stats">
            <div className="stat"><div className="v"><span className={`dot ${tickFresh ? "ok live" : "bad"}`} /> {ago(s.lastTickAt)}</div><div className="k label">Last automatic check</div>
              <div className="s">{s.lastTick ? `${s.lastTick.checked} checked · ${s.lastTick.ms} ms` : "not run yet"}</div></div>
            <div className="stat"><div className="v">{s.fm && s.fm.ok ? s.fm.count : <em>down</em>}</div><div className="k label">FM deliveries (36 h)</div>
              <div className="s">{s.fm && s.fm.ok ? "feed OK" : (s.fm && s.fm.lastError) || "not read yet"}</div></div>
            <div className="stat"><div className="v">{okN}<span style={{ color: "var(--muted-2)" }}>/{checked.length}</span></div><div className="k label">Confirmed on the channel</div>
              <div className="s">{problems ? <span style={{ color: "var(--red)" }}>{problems} problem{problems === 1 ? "" : "s"}</span> : "no problems"} · {day}</div></div>
            <div className="stat"><div className="v">{s.whatsapp.configured || s.whatsapp.push || s.whatsapp.teams ? "On" : <em>Off</em>}</div>
              <div className="k label">Alerts · Teams {s.whatsapp.teams ? "✓" : "✗"} · Push {s.whatsapp.push ? "✓" : "✗"} · WhatsApp {s.whatsapp.configured ? "✓" : "✗"}</div>
              <div className="s">{s.whatsapp.configured || s.whatsapp.push || s.whatsapp.teams
                ? (s.whatsapp.log[0] ? `last: ${s.whatsapp.log[0].ok ? "sent" : "failed"}${s.whatsapp.log[0].via ? " (" + s.whatsapp.log[0].via + ")" : ""} ${ago(s.whatsapp.log[0].at)}` : "nothing sent yet")
                : "set TEAMS_WEBHOOK_URL, NTFY_TOPIC or WhatsApp"}</div></div>
          </div>
          {down.length > 0 && <div className="alert" style={{ marginTop: 14 }}><span className="kind missing">reader down</span>
            <span className="txt">{down.map(([id, h]) => <span key={id}><b>{id}</b> — {h.lastError} · </span>)}</span></div>}

          <div className="tabs">
            {days.map(d => <button key={d} className={`tab${d === day ? " on" : ""}`} onClick={() => setDay(d)}>{d === istDay(Date.now()) ? "Today" : d}</button>)}
            {!days.length && <span className="label" style={{ alignSelf: "center" }}>No FM deliveries yet</span>}
          </div>

          <div className="drops">
            {drops.map(ds => {
              const first = Math.min(...ds.map(e => e.when));
              const bad = ds.filter(e => ["missing", "fm_failed", "reader_failed", "fm_unconfirmed"].includes(e.status));
              const langs = [...new Set(ds.map(e => e.language))];
              return (
                <div key={ds[0].dropKey || ds[0].setId} className={`card live-drop${bad.length ? " gap" : ""}`}>
                  <div className="drop-time">
                    <b className="mono">{ist(first)}</b>
                    <span className="pill un">{[...new Set(ds.map(e => e.card))].join(" + ")}</span>
                    <span className="pill un">{ds.some(e => e.deliveryMode === "now") ? "sent now" : "scheduled"}</span>
                    <span className={`pill ${bad.length ? "short" : ds.some(e => ["waiting", "new", "fm_pending"].includes(e.status)) ? "sg" : "ok"}`}>
                      {bad.length ? `${bad.length} problem${bad.length === 1 ? "" : "s"}` : ds.some(e => ["waiting", "new", "fm_pending"].includes(e.status)) ? "checking…" : "delivered"}</span>
                  </div>
                  {langs.map(lg => (
                    <div key={lg} className="live-row">
                      <span className="lang-tag">{LANG[lg] || lg}</span>
                      <div className="live-chips">
                        {ds.filter(e => e.language === lg).sort((a, b) => a.channel.localeCompare(b.channel)).map(e => {
                          const st = STATUS[e.status] || STATUS.waiting;
                          const tip = `${e.label} — ${st.t}` + (e.lag != null ? ` (+${e.lag} min${e.sim != null ? `, caption ${e.sim}%` : ""})` : "") +
                                      (e.readNote ? ` — ${e.readNote}` : "") + (e.why ? ` — ${e.why}` : "") + (e.capProblem ? ` — ⚠ ${e.capProblem}` : "");
                          const inner = <><BrandIcon platform={ICON[e.channel] || e.channel} /><span className={`cl ${st.cls}`}>{st.g}</span>
                            {e.lag != null && <span className="live-lag">+{Math.max(0, Math.round(e.lag))}m</span>}{e.capProblem && <span className="live-warn">⚠</span>}</>;
                          return e.postUrl
                            ? <a key={e.cardId} className="live-chip" href={e.postUrl} target="_blank" rel="noopener noreferrer" title={tip}>{inner}</a>
                            : <span key={e.cardId} className="live-chip" title={tip}>{inner}</span>;
                        })}
                      </div>
                    </div>
                  ))}
                  {bad.map(e => <div key={e.cardId} className="note-miss">{e.label}: {STATUS[e.status].t}{e.capProblem ? ` — likely why: ${e.capProblem}` : ""}{e.readNote ? ` — ${e.readNote}` : ""}</div>)}
                  {ds.filter(e => e.capProblem && !bad.includes(e)).map(e => <div key={e.cardId + "c"} className="note-warn">{e.label}: {e.capProblem}</div>)}
                </div>
              );
            })}
          </div>

          <div className="live-grid">
            <div className="card live-panel">
              <h3><BellRing /> Alerts</h3>
              {(s.alerts || []).length ? s.alerts.slice(0, 30).map((a, i) => (
                <div key={i} className="live-alert"><span className="mono">{istDay(a.at).slice(5)} {ist(a.at)}</span><span>{a.text.replace(/\*/g, "")}</span></div>
              )) : <div className="empty" style={{ padding: 20 }}>No alerts yet.</div>}
            </div>
            <div className="card live-panel">
              <h3><Activity /> Readers</h3>
              {readers.length ? readers.sort().map(([id, h]) => (
                <div key={id} className="live-reader"><span className={`dot ${h.down ? "bad" : h.ok ? "ok" : h.soft ? "" : "warn"}`} /><b>{id}</b>
                  <span>{h.ok ? `${h.source || "ok"} · ${ago(h.lastOkAt)}` : h.soft ? "18+ — waiting for the age restriction to be lifted" : `failing · ${String(h.lastError || "").slice(0, 80)}`}</span></div>
              )) : <div className="empty" style={{ padding: 20 }}>Readers are only asked when a card is due.</div>}
              <h3 style={{ marginTop: 20 }}><Radio /> What FM sends, and how it's checked</h3>
              {(s.coverage || []).map(c => (
                <div key={c.fm} className="live-reader"><span className={`dot ${c.mode === "verify" ? "ok" : c.mode === "assume" ? "warn" : ""}`} /><b>{c.fm}</b>
                  <span>{c.mode === "verify" ? c.account.replace(/^https?:\/\/(www\.)?/, "") + (c.soft ? " — 18+, checked once the restriction is lifted" : "") : c.mode === "assume" ? "Viber — taken on FM's word" : c.why}</span></div>
              ))}
            </div>
          </div>
          <div className="foot-note">Times in IST. A ✓ means the post was found on the channel with the same caption. Hover a mark for the detail; click it to open the post.
            {s.lastReportMerge && <> The daily-check report is updated with every read (last {ago(s.lastReportMerge.at)}).</>}
            {" "}<a href="#/report" style={{ color: "var(--red)" }}>Open the daily check <ArrowUpRight style={{ width: 13, verticalAlign: -2 }} /></a></div>
        </div>
      </section>
    </>
  );
}
