import { useCallback, useEffect, useState } from "react";
import { Activity, ArrowUpRight, BellRing, Database, Loader2, Play, Radar, RefreshCw, ServerCog } from "lucide-react";
import { BrandIcon, useApp } from "../app/core.jsx";

/* System health: is every part of the FM → channels check working right now — the clock that runs it,
   the FM Deliveries feed, every channel reader (scraper), and every place alerts go. Everything here
   comes from GET /api/pipeline → health (pipeline/health.js); the page judges nothing itself. Every
   reader is read at least every 30 min by the pipeline whether a card is due or not, so "last read"
   is always recent while the clock runs. Refreshes every 15 s. */

const STATE = { ok: { dot: "ok", pill: "ok", t: "Working" }, warn: { dot: "warn", pill: "sg", t: "Check" },
                bad: { dot: "bad", pill: "short", t: "Not working" }, off: { dot: "", pill: "un", t: "Not set up" } };
const OVERALL = { ok: ["ok", "All systems working"], degraded: ["sg", "Working — with things to keep an eye on"], down: ["short", "Not working"] };
const GROUP_ICON = { pipeline: ServerCog, fm: Database, readers: Radar, alerts: BellRing };
const ist = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16);
const istDay = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const ago = ms => { if (!ms) return "—"; const m = Math.round((Date.now() - ms) / 60e3); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };
const INCIDENT = new Set(["reader_down", "reader_up", "reader_failed", "fm_down", "pipeline"]);

/* the last 30 reads, oldest on the left — green read, red failed */
function Bars({ history }) {
  if (!history || !history.length) return null;
  const h = history.slice(0, 30).reverse();
  return (
    <span className="hl-bars" title={`${h.filter(x => x.ok).length} of the last ${h.length} reads worked`}>
      {h.map((x, i) => <i key={i} className={x.ok ? "ok" : "bad"} title={`${istDay(x.at).slice(5)} ${ist(x.at)} — ${x.ok ? "read" : "failed"}`} />)}
    </span>
  );
}

export default function Health() {
  const { toast } = useApp();
  const [s, setS] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);
  const load = useCallback(async () => {
    try {
      const r = await fetch("api/pipeline", { cache: "no-store" }); const j = await r.json();
      if (!j.ok || !j.health) throw new Error(j.error || "no health in the answer");
      setS(j); setErr(""); setLoadedAt(Date.now());
    } catch (e) { setErr(String(e.message || e)); }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 15000);
    const vis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [load]);

  const checkNow = async () => {
    setBusy(true);
    try {
      const r = await fetch("api/pipeline?op=tick", { cache: "no-store" }); const j = await r.json();
      toast(j.skipped ? `Skipped — ${j.skipped}` : j.ok ? "Checked — every due channel was read" : (j.error || "Check failed"), j.ok ? "check-check" : "triangle-alert");
      await load();
    } catch (e) { toast(String(e.message || e), "triangle-alert"); }
    setBusy(false);
  };

  if (!s) return (
    <section className="rp-head"><div className="wrap">
      <span className="eyebrow">SportsFC · System health</span>
      <h1 className="display l">Is everything <b>working?</b></h1>
      <p className="rp-when">{err ? "Couldn't load the system's health — " + err : <><Loader2 className="spin" style={{ width: 16, verticalAlign: -3 }} /> Loading…</>}</p>
    </div></section>
  );

  const H = s.health;
  const [, label] = OVERALL[H.overall] || OVERALL.degraded;
  const names = s.readerLabels || {};
  const rename = text => Object.entries(names).reduce((t, [id, l]) => t.split(id).join(l), String(text || ""));
  const incidents = (s.alerts || []).filter(a => INCIDENT.has(a.kind)).slice(0, 12);

  return (
    <>
      <section className="rp-head">
        <div className="wrap">
          <div className="rp-head-row">
            <div>
              <span className="eyebrow">SportsFC · System health</span>
              <h1 className="display l">Is everything <b>working?</b></h1>
              <div className="rp-when">The automatic check, the FM Deliveries feed, every channel reader and every alert channel — live. Every reader is read at least every 30 minutes, card due or not.</div>
            </div>
            <div className="rp-actions">
              <button className="btn btn-line btn-sm" disabled={busy} onClick={checkNow}>{busy ? <Loader2 className="spin" /> : <Play />}Check now</button>
              <button className="btn btn-line btn-sm" onClick={load}><RefreshCw />Refresh</button>
              <a className="btn btn-line btn-sm" href="#/live"><Activity />Live pipeline</a>
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
              <span className="hl-upd">updated {ago(loadedAt)} · refreshes every 15 s</span>
            </div>
          </div>

          {H.groups.map(g => {
            const Icon = GROUP_ICON[g.id] || Activity;
            const bad = g.items.filter(i => i.state === "bad").length, warn = g.items.filter(i => i.state === "warn").length, on = g.items.filter(i => i.state !== "off").length;
            return (
              <div key={g.id} className="card hl-group">
                <div className="hl-group-h">
                  <h3><Icon /> {g.title}</h3>
                  <span className={`pill ${bad ? "short" : warn ? "sg" : !on ? "un" : "ok"}`}>{bad ? `${bad} not working` : warn ? `${warn} to check` : !on ? "not set up" : on > 1 ? `all ${on} working` : "working"}</span>
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

          <div className="card hl-group">
            <div className="hl-group-h"><h3><Activity /> Recent incidents</h3><span className="label">shown here only — scraper hiccups are never sent as notifications</span></div>
            {incidents.length ? incidents.map((a, i) => (
              <div key={i} className="hl-inc"><span className="mono">{istDay(a.at).slice(5)} {ist(a.at)}</span>
                <span>{rename(a.text).replace(/\*/g, "").replace(/ — the paid fallback is skipped on automatic checks/g, "")}</span></div>
            )) : <div className="empty" style={{ padding: 22 }}>No incidents in the log.</div>}
          </div>

          <div className="foot-note">Times in IST. “Working” means proven by a read in the last hour; the bars are each part's last 30 reads (green read, red failed).
            {" "}Alerts about posts go to Teams and the phone; this page is where to look for the system itself.
            {" "}<a href="#/live" style={{ color: "var(--red)" }}>Open the Live pipeline <ArrowUpRight style={{ width: 13, verticalAlign: -2 }} /></a></div>
        </div>
      </section>
    </>
  );
}
