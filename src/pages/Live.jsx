import { useCallback, useEffect, useState } from "react";
import { Activity, ArrowUpRight, BellRing, Loader2, Play, Radio, RefreshCw } from "lucide-react";
import { BrandIcon, useApp } from "../app/core.jsx";
import { authFetch } from "../app/admin.js";

/* The FM → channels pipeline, live: every card FM sent, and what became of it on each channel.
   Everyone (the content team) sees each drop — went out where, and why not where it didn't. The admin also
   sees the pipeline's own state: the clock, FM, the alert log, every reader (api/pipeline.js serves each its view).
   Reads /api/pipeline (the ledger the every-minute tick keeps); nothing here judges anything itself. */

const STATUS = {
  verified:       { g: "✓", cls: "ok",   t: "on the channel" },
  late:           { g: "✓", cls: "okh",  t: "arrived late" },
  waiting:        { g: "⏳", cls: "none", t: "checking — inside the 20-min window" },
  new:            { g: "⏳", cls: "none", t: "just seen" },
  missing:        { g: "✗", cls: "miss", t: "not on the channel after 20 min" },
  reader_failed:  { g: "!", cls: "lang", t: "the channel couldn't be read" },
  assumed:        { g: "≈", cls: "okc",  t: "Viber — taken on FM's word" },
  unwatched:      { g: "–", cls: "na",   t: "not watched yet (link missing)" },
  unverifiable:   { g: "?", cls: "na",   t: "can't be checked right now" },
  not_visible:    { g: "⚠", cls: "lang", t: "not on the public profile — maybe 18+ restricted by Instagram (we can't see those) or not posted; check in the app" },
  fm_pending:     { g: "…", cls: "none", t: "FM hasn't sent it yet" },
  fm_failed:      { g: "✗", cls: "miss", t: "FM failed to send it" },
  fm_stuck:       { g: "⏳", cls: "miss", t: "still queued in FM long after its time" },
  fm_other:       { g: "·", cls: "na",   t: "an FM state this page doesn't know yet" },
  fm_failing:     { g: "…", cls: "none", t: "FM failed — waiting 5 min in case the content team sends it again" },
  superseded:     { g: "↻", cls: "na",   t: "a failed first attempt — the content team sent it again" },
  fm_unconfirmed: { g: "?", cls: "lang", t: "FM can't confirm" },
  unchecked:      { g: "·", cls: "na",   t: "not checked — sent before the pipeline was watching" },
};
const ICON = { telegram_direct: "tgbot" };
/* scraper health — shown on this page only, never sent as a notification (pipeline/tick.js, INTERNAL) */
const READER_KINDS = new Set(["reader_down", "reader_up", "reader_failed"]);
const LANG = { vietnamese: "VN", english: "EN", portuguese: "PT", hindi: "HI" };
const ist = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16);
const istDay = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const ago = ms => { if (!ms) return "never"; const m = Math.round((Date.now() - ms) / 60e3); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago"; };

export default function Live() {
  const { toast, admin: signedIn } = useApp();
  const [s, setS] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  /* null = today, worked out on every render — an open tab moves on to the new day at midnight */
  const [picked, setDay] = useState(null);
  const day = picked || istDay(Date.now());
  const load = useCallback(async () => {
    try { const r = await authFetch("api/pipeline"); const j = await r.json(); if (!j.ok) throw new Error(j.error || "failed"); setS(j); setErr(""); }
    catch (e) { setErr(String(e.message || e)); }
  }, [signedIn]);                                        // signing in or out shows the other view at once
  /* every minute — the pipeline itself checks once a minute, so sooner shows nothing new */
  useEffect(() => { load(); const t = setInterval(() => { if (!document.hidden) load(); }, 60000); return () => clearInterval(t); }, [load]);

  const act = async (op, label) => {
    setBusy(op);
    try {
      const r = await authFetch("api/pipeline?op=" + op); const j = await r.json();
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

  /* today is always a tab — an empty one says so — and is first */
  const days = [...new Set([istDay(Date.now()), ...s.deliveries.map(e => istDay(e.when))])].sort().reverse();
  const dayAll = s.deliveries.filter(e => istDay(e.when) === day);
  /* a superseded attempt is not a drop of its own — it is a note on the drop that was sent instead */
  const list = dayAll.filter(e => e.status !== "superseded");
  const retried = dayAll.filter(e => e.status === "superseded");
  const sets = {};
  for (const e of list) (sets[e.dropKey || e.setId] = sets[e.dropKey || e.setId] || []).push(e);
  const drops = Object.values(sets).sort((a, b) => Math.min(...b.map(e => e.when)) - Math.min(...a.map(e => e.when)));
  const checked = list.filter(e => e.mode === "verify" && e.fmState === "sent" && e.status !== "unverifiable");
  const okN = checked.filter(e => e.status === "verified" || e.status === "late").length;
  const problems = list.filter(e => ["missing", "not_visible", "fm_failed", "fm_stuck", "reader_failed", "fm_unconfirmed"].includes(e.status)).length;
  const readers = ((s.health && s.health.groups.find(g => g.id === "readers")) || { items: [] }).items;
  const tickFresh = s.lastTickAt && Date.now() - s.lastTickAt < 12 * 60e3;
  const admin = !!s.admin;

  return (
    <>
      <section className="rp-head">
        <div className="wrap">
          <div className="rp-head-row">
            <div>
              <span className="eyebrow">SportsFC · Live pipeline</span>
              <h1 className="display l">FM → <b>every channel</b></h1>
              <div className="rp-when">Every card FM sends is looked for on each channel within 20 minutes — automatically, every minute.
                {" "}A post that didn't arrive, or arrived with a problem, is posted to the team's Teams channel; everything that went out fine is here, and in the day's summary at 23:00.</div>
            </div>
            <div className="rp-actions">
              {admin && <button className="btn btn-line btn-sm" disabled={!!busy} onClick={() => act("tick", "Check")}>{busy === "tick" ? <Loader2 className="spin" /> : <Play />}Check now</button>}
              {admin && <button className="btn btn-line btn-sm" disabled={!!busy || !(s.whatsapp.configured || s.whatsapp.push || s.whatsapp.teams)} onClick={() => act("test-alert", "Test alert")}
                title={s.whatsapp.configured || s.whatsapp.push || s.whatsapp.teams ? "Send one test alert (once per 10 min)" : "No alert channel is set up yet"}><BellRing />Test alert</button>}
              <button className="btn btn-line btn-sm" onClick={load}><RefreshCw />Refresh</button>
            </div>
          </div>
        </div>
      </section>

      <section className="section tight" style={{ paddingTop: 24 }}>
        <div className="wrap">
          <div className={`stats live-stats${admin ? "" : " pub"}`}>
            <div className="stat"><div className="v"><span className={`dot ${tickFresh ? "ok live" : "bad"}`} /> {ago(s.lastTickAt)}</div><div className="k label">Last automatic check</div>
              <div className="s">{admin ? (s.lastTick ? `${s.lastTick.checked} checked · ${s.lastTick.ms} ms` : "not run yet") : "every minute, automatically"}</div></div>
            {admin && <div className="stat"><div className="v">{s.fm && s.fm.ok ? s.fm.count : <em>down</em>}</div><div className="k label">FM deliveries (36 h)</div>
              <div className="s">{s.fm && s.fm.ok ? "feed OK" : (s.fm && s.fm.lastError) || "not read yet"}</div></div>}
            <div className="stat"><div className="v">{okN}<span style={{ color: "var(--muted-2)" }}>/{checked.length}</span></div><div className="k label">Confirmed on the channel</div>
              <div className="s">{problems ? <span style={{ color: "var(--red)" }}>{problems} problem{problems === 1 ? "" : "s"}</span> : "no problems"} · {day}</div></div>
            {admin && <div className="stat"><div className="v">{s.whatsapp.configured || s.whatsapp.push || s.whatsapp.teams ? "On" : <em>Off</em>}</div>
              <div className="k label">Alerts · Teams {s.whatsapp.teams ? "✓" : "✗"} · Push {s.whatsapp.push ? "✓" : "✗"} · WhatsApp {s.whatsapp.configured ? "✓" : "✗"}</div>
              <div className="s">{s.whatsapp.configured || s.whatsapp.push || s.whatsapp.teams
                ? (s.whatsapp.log[0] ? `last: ${s.whatsapp.log[0].ok ? "sent" : "failed"}${s.whatsapp.log[0].via ? " (" + s.whatsapp.log[0].via + ")" : ""} ${ago(s.whatsapp.log[0].at)}` : "nothing sent yet")
                : "set TEAMS_WEBHOOK_URL, NTFY_TOPIC or WhatsApp"}</div></div>}
          </div>
          {admin && <HealthStrip h={s.health} />}

          <div className="tabs">
            {days.map(d => <button key={d} className={`tab${d === day ? " on" : ""}`} onClick={() => setDay(d)}>{d === istDay(Date.now()) ? "Today" : d}</button>)}

          </div>

          <div className="drops">
            {!drops.length && <div className="card empty" style={{ padding: 28 }}>{day === istDay(Date.now())
              ? <><b>Nothing from FM yet today.</b><div>Every card FM sends today appears here within a minute, and is checked on every channel.</div></>
              : <b>No FM deliveries on {day}.</b>}</div>}
            {drops.map(ds => {
              const first = Math.min(...ds.map(e => e.when));
              const bad = ds.filter(e => ["missing", "not_visible", "fm_failed", "fm_stuck", "reader_failed", "fm_unconfirmed"].includes(e.status));
              const langs = [...new Set(ds.map(e => e.language))];
              return (
                <div key={ds[0].dropKey || ds[0].setId} className={`card live-drop${bad.length ? " gap" : ""}`}>
                  <div className="drop-time">
                    <b className="mono">{ist(first)}</b>
                    <span className="pill un">{[...new Set(ds.map(e => e.card))].join(" + ")}</span>
                    <span className="pill un">{ds.some(e => e.deliveryMode === "now") ? "sent now" : "scheduled"}</span>
                    <span className={`pill ${bad.length ? "short" : ds.some(e => ["waiting", "new", "fm_pending", "fm_failing"].includes(e.status)) ? "sg" : "ok"}`}>
                      {bad.length ? `${bad.length} problem${bad.length === 1 ? "" : "s"}` : ds.some(e => ["waiting", "new", "fm_pending", "fm_failing"].includes(e.status)) ? "checking…" : "delivered"}</span>
                  </div>
                  {langs.map(lg => (
                    <div key={lg} className="live-row">
                      <span className="lang-tag">{LANG[lg] || lg}</span>
                      <div className="live-chips">
                        {ds.filter(e => e.language === lg).sort((a, b) => a.channel.localeCompare(b.channel)).map(e => {
                          const st = STATUS[e.status] || STATUS.waiting;
                          const tip = `${e.label} — ${st.t}` + (e.lag != null ? ` (+${e.lag} min${e.sim != null ? `, caption ${e.sim}%` : ""})` : "") +
                                      (e.why ? ` — ${e.why}` : e.readNote ? ` — ${e.readNote}` : "") + (e.capProblem ? ` — ⚠ ${e.capProblem}` : "");
                          const inner = <><BrandIcon platform={ICON[e.channel] || e.channel} /><span className={`cl ${st.cls}`}>{st.g}</span>
                            {e.lag != null && <span className="live-lag">+{Math.max(0, Math.round(e.lag))}m</span>}{e.capProblem && <span className="live-warn">⚠</span>}</>;
                          return e.postUrl
                            ? <a key={e.cardId} className="live-chip" href={e.postUrl} target="_blank" rel="noopener noreferrer" title={tip}>{inner}</a>
                            : <span key={e.cardId} className="live-chip" title={tip}>{inner}</span>;
                        })}
                      </div>
                    </div>
                  ))}
                  {(() => { const sets = new Set(ds.map(e => e.setId)); const r = retried.filter(e => sets.has(e.setId));
                    return r.length ? <div className="note-warn">A first attempt at {ist(Math.min(...r.map(e => Date.parse(e.queuedAt) || e.when)))} was {r[0].fmState} by {r[0].failureStage === "cms" ? "the CMS" : "FM"} on {r.length} channel{r.length === 1 ? "" : "s"}{r[0].fmError ? ` (${r[0].fmError.replace(/\s*—.*$/, "")})` : ""} — the content team sent it again; this is that send.</div> : null; })()}
                  {bad.map(e => <div key={e.cardId} className={e.status === "not_visible" ? "note-warn" : "note-miss"}>{e.label}: {e.why || STATUS[e.status].t}{!e.why && e.capProblem ? ` — likely why: ${e.capProblem}` : ""}</div>)}
                  {ds.filter(e => e.capProblem && !bad.includes(e)).map(e => <div key={e.cardId + "c"} className="note-warn">{e.label}: {e.capProblem}</div>)}
                </div>
              );
            })}
          </div>

          {admin && <div className="live-grid">
            <div className="card live-panel">
              <h3><BellRing /> Alerts</h3>
              {(s.alerts || []).length ? s.alerts.slice(0, 30).map((a, i) => (
                <div key={i} className="live-alert"><span className="mono">{istDay(a.at).slice(5)} {ist(a.at)}</span>
                  <span>{READER_KINDS.has(a.kind) && <span className="tg" style={{ marginRight: 6 }}>website only</span>}{a.text.replace(/\*/g, "")}</span></div>
              )) : <div className="empty" style={{ padding: 20 }}>No alerts yet.</div>}
            </div>
            <div className="card live-panel">
              <h3><Activity /> Readers <a href="#/admin" className="tg" style={{ marginLeft: "auto" }}>admin dashboard →</a></h3>
              {readers.map(i => (
                <div key={i.id} className="live-reader" title={i.detail}><span className={`dot ${i.state === "ok" ? "ok" : i.state === "bad" ? "bad" : "warn"}`} /><b>{i.name}</b>
                  <span>{i.detail}</span></div>
              ))}
              <h3 style={{ marginTop: 20 }}><Radio /> What FM sends, and how it's checked</h3>
              {(s.coverage || []).map(c => (
                <div key={c.fm} className="live-reader"><span className={`dot ${c.mode === "verify" ? "ok" : c.mode === "assume" ? "warn" : ""}`} /><b>{c.fm}</b>
                  <span>{c.mode === "verify" ? c.account.replace(/^https?:\/\/(www\.)?/, "") + (c.soft ? " — checked quietly while it can't be read" : "") : c.mode === "assume" ? "Viber — taken on FM's word" : c.why}</span></div>
              ))}
            </div>
          </div>}
          <div className="foot-note">Times in IST. A ✓ means the post was found on the channel with the same caption. Hover a mark for the detail; click it to open the post.
            {admin && s.lastReportMerge && <> New posts are merged into the daily-check report (last {ago(s.lastReportMerge.at)}).</>}
            {" "}<a href="#/report" style={{ color: "var(--red)" }}>Open the daily check <ArrowUpRight style={{ width: 13, verticalAlign: -2 }} /></a></div>
        </div>
      </section>
    </>
  );
}

/* The system's health in one line (admin only) — the full picture is the admin dashboard (#/admin). Scraper hiccups live
   there rather than in notifications: the free readers fail for a minute or two and recover on their own. */
function HealthStrip({ h }) {
  if (!h) return null;
  const bad = h.groups.flatMap(g => g.items).filter(i => i.state === "bad");
  return (
    <div className="card live-health">
      <div>
        <span className={`dot ${h.overall === "ok" ? "ok live" : h.overall === "down" ? "bad live" : "warn live"}`} />
        <b>System health</b>
        <span className={`pill ${h.overall === "ok" ? "ok" : h.overall === "down" ? "short" : "sg"}`}>{h.overall === "ok" ? "All systems working" : h.overall === "down" ? "Not working" : "Working, with things to check"}</span>
        <span style={{ color: "var(--muted)" }}>{bad.length ? bad.map(i => `${i.name}: ${i.detail}`).join(" · ").slice(0, 220) : h.summary}</span>
      </div>
      <a className="btn btn-line btn-sm" href="#/admin"><Activity />Open the admin dashboard</a>
    </div>
  );
}
