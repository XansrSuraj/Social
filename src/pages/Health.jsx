import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowRight, ArrowUpRight, BellRing, Bug, Clock3, Database, Loader2, LogOut, Megaphone, Play, Radar, RefreshCw, Send, ServerCog, Users } from "lucide-react";
import { BrandIcon, useApp } from "../app/core.jsx";
import { authFetch } from "../app/admin.js";

/* The admin dashboard (#/admin, behind the sign-in): every part of the FM → channels check, end to end —
   the clock that runs it, the FM Deliveries feed, every channel reader (scraper), the report sync, every
   place alerts go — plus every error, every check and every message sent, so a break is found where it
   happened. Everything comes from GET /api/pipeline's admin view (pipeline/health.js and the ledger); the
   page judges nothing itself. Refreshes every minute, like the pipeline. */

const STATE = { ok: { dot: "ok", pill: "ok", t: "Working" }, warn: { dot: "warn", pill: "sg", t: "Check" },
                bad: { dot: "bad", pill: "short", t: "Not working" }, off: { dot: "", pill: "un", t: "Not set up" } };
const OVERALL = { ok: ["ok", "All systems working"], degraded: ["sg", "Working — with things to keep an eye on"], down: ["short", "Not working"] };
const GROUP_ICON = { pipeline: ServerCog, fm: Database, readers: Radar, alerts: BellRing };
const VIA = { teams: "Teams", push: "Phone", whatsapp: "WhatsApp" };
const KIND = { report: "drop report", digest: "23:00 summary", missing: "post missing", not_visible: "maybe 18+ (check the app)", fm_failed: "not sent (FM/CMS)",
               fm_stuck: "stuck in FM", fm_unconfirmed: "FM can't confirm", caption: "caption problem", late: "arrived late", pipeline: "pipeline crash",
               fm_down: "FM feed down", test: "test alert", slot: "drop report", reader_down: "reader down", reader_up: "reader back", reader_failed: "couldn't check" };
const ist = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16);
const istDay = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const stamp = ms => (istDay(ms) === istDay(Date.now()) ? "" : istDay(ms).slice(5) + " ") + ist(ms);
const ago = ms => { if (!ms) return "—"; const m = Math.round((Date.now() - ms) / 60e3); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };
const INCIDENT = new Set(["reader_down", "reader_up", "reader_failed", "fm_down", "pipeline"]);
const worst = items => items.some(i => i.state === "bad") ? "bad" : items.some(i => i.state === "warn") ? "warn" : items.some(i => i.state === "ok") ? "ok" : "off";

/* the last 30 reads, oldest on the left — green read, red failed */
function Bars({ history }) {
  if (!history || !history.length) return null;
  const h = history.slice(0, 30).reverse();
  return (
    <span className="hl-bars" title={`${h.filter(x => x.ok).length} of the last ${h.length} reads worked`}>
      {h.map((x, i) => <i key={i} className={x.ok ? "ok" : "bad"} title={`${stamp(x.at)} — ${x.ok ? "read" : "failed"}`} />)}
    </span>
  );
}

export default function Health() {
  const { toast, logout } = useApp();
  const [s, setS] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [loadedAt, setLoadedAt] = useState(0);
  const refs = useRef({});
  const load = useCallback(async () => {
    try {
      const r = await authFetch("api/pipeline"); const j = await r.json();
      if (!j.ok) throw new Error(j.error || "failed");
      if (!j.admin) { logout(); return; }              // the session ran out, or the password changed — sign in again
      setS(j); setErr(""); setLoadedAt(Date.now());
    } catch (e) { setErr(String(e.message || e)); }
  }, [logout]);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 60000);
    const vis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [load]);

  const act = async (op, done) => {
    setBusy(op);
    try {
      const r = await authFetch("api/pipeline?op=" + op); const j = await r.json();
      if (r.status === 401) { logout(); return; }
      toast(j.skipped ? `Skipped — ${j.skipped}` : j.ok ? done : (j.error || "Failed"), j.ok ? "check-check" : "triangle-alert");
      await load();
    } catch (e) { toast(String(e.message || e), "triangle-alert"); }
    setBusy("");
  };

  if (!s) return (
    <section className="rp-head"><div className="wrap">
      <span className="eyebrow">SportsFC · Admin</span>
      <h1 className="display l">Everything, <b>end to end</b></h1>
      <p className="rp-when">{err ? "Couldn't load the pipeline — " + err : <><Loader2 className="spin" style={{ width: 16, verticalAlign: -3 }} /> Loading…</>}</p>
    </div></section>
  );

  const H = s.health;
  const [, label] = OVERALL[H.overall] || OVERALL.degraded;
  const names = s.readerLabels || {};
  const rename = text => Object.entries(names).reduce((t, [id, l]) => t.split(id).join(l), String(text || ""));
  const incidents = (s.alerts || []).filter(a => INCIDENT.has(a.kind)).slice(0, 12);
  const item = (g, id) => ((H.groups.find(x => x.id === g) || { items: [] }).items.find(i => i.id === id)) || null;
  const group = g => (H.groups.find(x => x.id === g) || { items: [] }).items;
  const jump = id => { const el = refs.current[id]; if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); };

  /* the pipeline, in the order a card travels it — the first red step is where it broke */
  const readers = group("readers"), alertsOut = group("alerts");
  const stepOf = (id, name, items, target, fallback) => {
    const st = worst(items), bad = items.find(i => i.state === "bad") || items.find(i => i.state === "warn");
    return { id, name, state: st, target, detail: bad ? `${items.length > 1 ? bad.name + ": " : ""}${bad.detail}` : fallback };
  };
  const steps = [
    stepOf("clock", "Clock", [item("pipeline", "clock")].filter(Boolean), "ticks", `every minute · last ${ago(s.lastTickAt)}`),
    stepOf("fm", "FM feed", group("fm"), "fm", s.fm && s.fm.ok ? `${s.fm.count} deliveries in 36 h` : "—"),
    stepOf("run", "Check", [item("pipeline", "run")].filter(Boolean), "errors", s.lastTick ? `${s.lastTick.checked} checked · ${(s.lastTick.ms / 1000).toFixed(1)} s` : "—"),
    stepOf("readers", "Readers", readers, "readers", `${readers.filter(i => i.state === "ok").length}/${readers.length} reading`),
    stepOf("report", "Report sync", [item("pipeline", "report")].filter(Boolean), "pipeline", s.lastReportMerge ? `merged ${ago(s.lastReportMerge.at)}` : "—"),
    stepOf("alerts", "Alerts", alertsOut.filter(i => i.state !== "off"), "sent",
      alertsOut.filter(i => i.state !== "off").map(i => VIA[i.id] || i.name).join(" · ") || "none set up"),
  ];

  /* errors: the newest first; the last crash on top when it is the newest thing */
  const errors = (s.errorLog || []).slice(0, 60);
  const day = Date.now() - 24 * 3600e3;
  const errors24 = errors.filter(e => e.at > day).length;
  /* the clock: the last 60 checks, oldest on the left, and the longest gap between two of them */
  const ticks = (s.tickLog || []).slice(0, 60).reverse();
  let gap = null;
  for (let i = 1; i < ticks.length; i++) { const g = ticks[i].at - ticks[i - 1].at; if (!gap || g > gap.ms) gap = { ms: g, at: ticks[i - 1].at }; }
  const avgMs = ticks.length ? Math.round(ticks.reduce((a, t) => a + (t.ms || 0), 0) / ticks.length) : null;
  const sent = (s.whatsapp && s.whatsapp.log || []).slice(0, 40);
  const failedSends = sent.filter(l => !l.ok && l.at > day).length;
  const on = s.whatsapp || {};

  return (
    <>
      <section className="rp-head">
        <div className="wrap">
          <div className="rp-head-row">
            <div>
              <span className="eyebrow">SportsFC · Admin</span>
              <h1 className="display l">Everything, <b>end to end</b></h1>
              <div className="rp-when">The clock, the FM Deliveries feed, every channel reader, the report sync and every alert channel — live, with every error, every check and every message sent. Only you see this page.</div>
            </div>
            <div className="rp-actions">
              <button className="btn btn-line btn-sm" disabled={!!busy} onClick={() => act("tick", "Checked — every due channel was read")}>{busy === "tick" ? <Loader2 className="spin" /> : <Play />}Check now</button>
              <button className="btn btn-line btn-sm" disabled={!!busy || !(on.configured || on.push || on.teams)} onClick={() => act("test-alert", "Test alert sent")}
                title={on.configured || on.push || on.teams ? "Send one test alert to every alert channel (once per 10 min) — it reaches the team's Teams channel too" : "No alert channel is set up yet"}>{busy === "test-alert" ? <Loader2 className="spin" /> : <BellRing />}Test alert</button>
              <button className="btn btn-line btn-sm" onClick={load}><RefreshCw />Refresh</button>
              <a className="btn btn-line btn-sm" href="#/fm"><Database />FM Deliveries</a>
              <button className="btn btn-line btn-sm" onClick={logout}><LogOut />Sign out</button>
            </div>
          </div>
        </div>
      </section>

      <section className="section tight" style={{ paddingTop: 24 }}>
        <div className="wrap">
          <div className={`card hl-hero ${H.overall}`}>
            <div className="hl-hero-main">
              <span className={`dot ${H.overall === "ok" ? "ok live" : H.overall === "down" ? "bad live" : "warn live"}`} />
              <div>
                <div className="hl-hero-t">{label}</div>
                <div className="hl-hero-s">{H.summary}</div>
              </div>
            </div>
            <div className="hl-counts">
              <span className="pill ok">{H.counts.ok} working</span>
              {H.counts.warn > 0 && <span className="pill sg">{H.counts.warn} to check</span>}
              {H.counts.bad > 0 && <span className="pill short">{H.counts.bad} not working</span>}
              {H.counts.off > 0 && <span className="pill un">{H.counts.off} not set up</span>}
              {errors24 > 0 && <span className="pill short">{errors24} error{errors24 === 1 ? "" : "s"} in 24 h</span>}
              {failedSends > 0 && <span className="pill short">{failedSends} failed send{failedSends === 1 ? "" : "s"} in 24 h</span>}
              <span className="hl-upd">updated {ago(loadedAt)} · refreshes every minute</span>
            </div>
          </div>

          {/* the pipeline as a card travels it — click a step for its detail */}
          <div className="card hl-group">
            <div className="hl-group-h"><h3><Activity /> The pipeline, end to end</h3><span className="label">the first red step is where it broke</span></div>
            <div className="ad-flow">
              {steps.map((st, i) => (
                <div key={st.id} className="ad-step-w">
                  <button className={`ad-step ${st.state}`} onClick={() => jump(st.target)} title={st.detail}>
                    <span className="ad-step-h"><span className={`dot ${(STATE[st.state] || STATE.warn).dot}`} /><b>{st.name}</b></span>
                    <span className={`tg ${st.state === "ok" ? "ok" : st.state === "bad" ? "red" : st.state === "warn" ? "warn" : ""}`}>{(STATE[st.state] || STATE.warn).t}</span>
                    <span className="ad-step-d">{rename(st.detail)}</span>
                  </button>
                  {i < steps.length - 1 && <ArrowRight className="ad-arrow" />}
                </div>
              ))}
            </div>
          </div>

          <div className="ad-two">
            {/* every error the pipeline met, newest first */}
            <div className="card hl-group" ref={el => { refs.current.errors = el; }}>
              <div className="hl-group-h"><h3><Bug /> Errors</h3><span className={`pill ${errors24 ? "short" : "ok"}`}>{errors24 ? `${errors24} in 24 h` : "none in 24 h"}</span></div>
              {s.lastCrash && <div className={`ad-crash${Date.now() - s.lastCrash.at < 3600e3 ? " now" : ""}`}>
                <b>Last crash {ago(s.lastCrash.at)}</b> ({stamp(s.lastCrash.at)} IST) — {String(s.lastCrash.error).split("\n")[0].slice(0, 220)}
                {Date.now() - s.lastCrash.at >= 3600e3 && <span className="ad-sub"> · recovered: the checks since ran</span>}</div>}
              <div className="ad-list">
                {errors.length ? errors.map((e, i) => (
                  <div key={i} className="ad-row" title={e.text}>
                    <span className="mono">{stamp(e.at)}</span>
                    <span className={`tg ${e.source === "crash" ? "red" : "warn"}`}>{rename(e.source)}</span>
                    <span className="ad-txt">{rename(e.text)}</span>
                  </div>
                )) : <div className="empty" style={{ padding: 22 }}>No errors logged — every check finished clean.</div>}
              </div>
            </div>

            {/* every message that left — where, what, and whether it got there */}
            <div className="card hl-group" ref={el => { refs.current.sent = el; }}>
              <div className="hl-group-h"><h3><Send /> What was sent</h3>
                <span className="label">{on.outbox ? `${on.outbox} waiting to go out` : "nothing waiting"}</span></div>
              <div className="ad-list">
                {sent.length ? sent.map((l, i) => (
                  <div key={i} className="ad-row" title={l.error || l.text || ""}>
                    <span className="mono">{stamp(l.at)}</span>
                    <span className={`tg ${l.ok ? "ok" : "red"}`}>{VIA[l.via || "whatsapp"] || l.via}</span>
                    <span className="ad-txt">{KIND[l.kind] || l.kind || "message"}{l.ok ? " — delivered" : ` — FAILED: ${l.error || "no reason given"}`}</span>
                  </div>
                )) : <div className="empty" style={{ padding: 22 }}>Nothing sent yet.</div>}
              </div>
            </div>
          </div>

          {/* the clock: is a check running every minute? */}
          <div className="card hl-group" ref={el => { refs.current.ticks = el; }}>
            <div className="hl-group-h"><h3><Clock3 /> The last {ticks.length} checks</h3>
              <span className="label">{avgMs != null ? `${(avgMs / 1000).toFixed(1)} s on average` : ""}{gap ? ` · longest gap ${Math.round(gap.ms / 60e3)} min (after ${stamp(gap.at)})` : ""}</span></div>
            {ticks.length ? <div className="ad-ticks">
              {ticks.map((t, i) => <i key={i} className={t.errors ? "bad" : i && t.at - ticks[i - 1].at > 3 * 60e3 ? "gap" : "ok"}
                style={{ height: `${Math.max(18, Math.min(100, (t.ms || 0) / 300))}%` }}
                title={`${stamp(t.at)} — ${((t.ms || 0) / 1000).toFixed(1)} s${t.errors ? ` · ${t.errors} error${t.errors === 1 ? "" : "s"}` : ""}${i && t.at - ticks[i - 1].at > 3 * 60e3 ? ` · ${Math.round((t.at - ticks[i - 1].at) / 60e3)} min after the one before` : ""}`} />)}
            </div> : <div className="empty" style={{ padding: 22 }}>No checks logged yet.</div>}
            <div className="ad-legend"><span><i className="ok" /> clean</span><span><i className="bad" /> finished with errors</span><span><i className="gap" /> came late (3+ min gap)</span><span>taller = slower</span></div>
          </div>

          {H.groups.map(g => {
            const Icon = GROUP_ICON[g.id] || Activity;
            const bad = g.items.filter(i => i.state === "bad").length, warn = g.items.filter(i => i.state === "warn").length, live = g.items.filter(i => i.state !== "off").length;
            return (
              <div key={g.id} className="card hl-group" ref={el => { refs.current[g.id] = el; }}>
                <div className="hl-group-h">
                  <h3><Icon /> {g.title}</h3>
                  <span className={`pill ${bad ? "short" : warn ? "sg" : !live ? "un" : "ok"}`}>{bad ? `${bad} not working` : warn ? `${warn} to check` : !live ? "not set up" : live > 1 ? `all ${live} working` : "working"}</span>
                </div>
                {g.items.map(i => (
                  <div key={i.id} className={`hl-row ${i.state}`}>
                    <span className={`dot ${(STATE[i.state] || STATE.warn).dot}`} />
                    <div className="hl-name">
                      {i.platform && <BrandIcon platform={i.platform === "tgbot" ? "tgbot" : i.platform} />}
                      <b>{i.name}</b>
                      {i.method && <small>{i.method}</small>}
                    </div>
                    <div className="hl-detail">
                      <span>{i.detail}</span>
                      {i.account && <a href={i.account} target="_blank" rel="noopener noreferrer" className="hl-acc">{i.account.replace(/^https?:\/\/(www\.)?/, "")} <ArrowUpRight /></a>}
                    </div>
                    <div className="hl-side">
                      <span className={`tg ${i.state === "ok" ? "ok" : i.state === "bad" ? "red" : i.state === "warn" ? "warn" : ""}`}>{(STATE[i.state] || STATE.warn).t}</span>
                      {i.uptime != null && <span className="hl-up">{i.uptime}% of last reads</span>}
                      <Bars history={i.history} />
                    </div>
                  </div>
                ))}
              </div>
            );
          })}

          {/* who hears what — pipeline/tick.js step 9 */}
          <div className="card hl-group">
            <div className="hl-group-h"><h3><Megaphone /> Who hears what</h3><span className="label">pipeline/tick.js decides; nothing here changes it</span></div>
            <div className="ad-policy">
              <div><span className={`dot ${on.teams ? "ok" : ""}`} /><b><Users /> Teams — the content team</b>
                <span>Only problems: a post that didn't arrive, wasn't sent, arrived late or with a caption problem — with that drop's report. And the day's summary, once, at 23:00 IST. A drop that went out fine sends nothing.</span></div>
              <div><span className={`dot ${on.push ? "ok" : ""}`} /><b><BellRing /> Phone (ntfy) — you</b>
                <span>All of the above, plus the pipeline's own trouble — a crash, the FM feed down. These never go to Teams.</span></div>
              <div><span className="dot ok" /><b><Activity /> The website</b>
                <span>Everything. Every drop on Live (the content team sees each post and why one didn't go); every error, check, reader and message here.</span></div>
              <div><span className="dot" /><b><Radar /> Never sent</b>
                <span>Reader (scraper) hiccups — a channel that can't be read for a minute recovers on its own. They are under Recent incidents below.</span></div>
            </div>
          </div>

          <div className="card hl-group">
            <div className="hl-group-h"><h3><Activity /> Recent incidents</h3><span className="label">shown here only — scraper hiccups are never sent as notifications</span></div>
            {incidents.length ? incidents.map((a, i) => (
              <div key={i} className="hl-inc"><span className="mono">{istDay(a.at).slice(5)} {ist(a.at)}</span>
                <span>{rename(a.text).replace(/\*/g, "").replace(/ — the paid fallback is skipped on automatic checks/g, "")}</span></div>
            )) : <div className="empty" style={{ padding: 22 }}>No incidents in the log.</div>}
          </div>

          <div className="foot-note">Times in IST. “Working” means proven by a read in the last hour; the bars are each part's last 30 reads (green read, red failed).
            {" "}<a href="#/live" style={{ color: "var(--red)" }}>Open the Live pipeline <ArrowUpRight style={{ width: 13, verticalAlign: -2 }} /></a></div>
        </div>
      </section>
    </>
  );
}
