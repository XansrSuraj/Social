import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Copy, History, Inbox, Info, Layers, Link2, Loader2, Pause, Play, RadioTower,
  RefreshCw, RotateCcw, Terminal, Video } from "lucide-react";
import { BrandIcon, useApp } from "../app/core.jsx";
import { authFetch } from "../app/admin.js";
import { webUrl } from "../app/viewmodel.js";

/* FM Deliveries — a read-only viewer over the CMS's FM Deliveries feed, through this site's own proxy
   (api/fm-deliveries.js keeps the x-api-key server-side). Every filter the feed accepts, the four outcome
   counts, every row with every field, and a link that reproduces the view. Nothing here writes anything.

   Language: the feed's `language` filter matches fmLanguageKey — Portuguese is filed as "portuguese-br"
   (a filter of "portuguese" found nothing on 9 Oct). The choices below are FM's own keys, and the proxy
   also accepts "portuguese". */

const ENVS = ["prod", "test", "dev"];
const LANGS = [["english", "English"], ["vietnamese", "Vietnamese"], ["portuguese-br", "Portuguese (Brazil)"], ["spanish-mx", "Spanish (Mexico)"]];
const NARRATION = ["english", "vietnamese", "portuguese", "hindi", "thai"];
const CHANNELS = ["youtube", "telegram", "telegram_direct", "x", "facebook", "instagram", "tiktok", "viber", "whatsapp", "whatsapp_direct"];
const FALLBACK = { states: ["queued", "sending", "sent", "failed", "unknown", "skipped"], outcomes: ["delivered", "failed", "pending", "unconfirmed"] };
const OUTCOME = { delivered: ["ok", "Delivered"], failed: ["short", "Failed / skipped"], pending: ["un", "Pending"], unconfirmed: ["sg", "Unconfirmed"] };
const ICON = { telegram_direct: "tgbot" };
const BLANK = { timeField: "queued", since: "", until: "", channel: "", language: "", states: [], outcomes: [], matchId: "", cardId: "", narration: "" };

const istFull = iso => { const t = Date.parse(iso); return isFinite(t) ? new Date(t + 5.5 * 3600e3).toISOString().slice(0, 19).replace("T", " ") + " IST" : "—"; };
const rel = iso => {
  const t = Date.parse(iso); if (!isFinite(t)) return "—";
  const d = Math.round((t - Date.now()) / 1000), a = Math.abs(d);
  for (const [u, s] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]]) if (a >= s || u === "s") { const n = Math.max(1, Math.round(a / s)); return d <= 0 ? `${n}${u} ago` : `in ${n}${u}`; }
  return "—";
};
/* local day boundaries (the viewer's clock — IST for the team) */
const dayStart = off => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off); return d.toISOString(); };
const toLocal = iso => { if (!iso) return ""; const d = new Date(iso); if (!isFinite(d)) return ""; const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocal = s => { if (!s) return ""; const d = new Date(s); return isFinite(d) ? d.toISOString() : ""; };

/* the view lives in the hash's query (#/fm?env=prod&…), so a filtered view is a link */
function fromHash() {
  const p = new URLSearchParams((location.hash.split("?")[1]) || "");
  const f = { ...BLANK };
  if (p.get("timeField") === "sent") f.timeField = "sent";
  for (const k of ["since", "until", "channel", "language", "matchId", "cardId", "narration"]) if (p.get(k)) f[k] = p.get(k);
  if (f.language === "portuguese") f.language = "portuguese-br";
  if (p.get("states")) f.states = p.get("states").split(",").filter(Boolean);
  if (p.get("outcomes")) f.outcomes = p.get("outcomes").split(",").filter(Boolean);
  return { env: ENVS.includes(p.get("env")) ? p.get("env") : "prod", f, group: p.get("group") || "",
           limit: Math.max(1, Math.min(500, Number(p.get("limit")) || 50)), page: Math.max(1, Number(p.get("page")) || 1) };
}
function toHash({ env, f, group, limit, page }) {
  const p = new URLSearchParams();
  p.set("env", env);
  if (f.timeField !== "queued") p.set("timeField", f.timeField);
  for (const k of ["since", "until", "channel", "language", "matchId", "cardId", "narration"]) if (f[k]) p.set(k, f[k]);
  if (f.states.length) p.set("states", f.states.join(","));
  if (f.outcomes.length) p.set("outcomes", f.outcomes.join(","));
  if (group) p.set("group", group);
  if (limit !== 50) p.set("limit", limit);
  if (page !== 1) p.set("page", page);
  /* replaceState: no hashchange, so the page neither re-mounts nor jumps to the top */
  history.replaceState(null, "", "#/fm?" + p.toString());
}

async function apiGet(path, params) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  let r; try { r = await authFetch(url.toString()); } catch (e) { return { ok: false, status: 0, error: "Network error: " + (e.message || e) }; }
  const text = await r.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch (e) {}
  if (!r.ok) return { ok: false, status: r.status, error: (body && (body.error || body.message || body.detail)) || text || `HTTP ${r.status}`, body };
  return { ok: true, status: r.status, body };
}

function FmRow({ row, isOpen, att, onFlip, onAttempts, onCopy }) {
  const [cls, word] = OUTCOME[row.outcome] || OUTCOME.pending;
  const tpl = row.template && row.template.label;
  return (
    <div className={`card fm-row ${row.outcome || "pending"}${isOpen ? " open" : ""}`}>
      <button className="fm-top" onClick={() => onFlip(row.cardId)} aria-expanded={isOpen}>
        <span className="fm-plat">{["youtube", "telegram", "telegram_direct", "x", "facebook", "instagram", "tiktok"].includes(row.channel)
          ? <BrandIcon platform={ICON[row.channel] || row.channel} /> : <RadioTower />}</span>
        <span className="fm-main">
          <span className="fm-head">
            <b>{row.channel || "?"}</b>
            <span className="tg">{row.language || "—"}{row.fmLanguageKey && row.fmLanguageKey !== row.language ? ` → filed as ${row.fmLanguageKey}` : ""}</span>
            <span className={`pill ${cls}`}>{row.state || word}</span>
            {row.failureStage && <span className="tg warn">owner: {row.failureStage}</span>}
            {row.distributionCaveat && <span className="tg warn"><AlertTriangle /> no matchId</span>}
            {tpl && <span className="fm-tpl">{tpl}</span>}
          </span>
          {row.caption ? <span className="fm-cap">{row.caption}</span>
            : row.state === "skipped" ? <span className="fm-cap"><i>No card was built — see the reason below</i></span> : null}
          <span className="fm-meta">
            {row.match && row.match.matchId && <span><Link2 />{row.match.matchId}</span>}
            <span className="mono">{row.cardId}</span>
            <span>{row.attemptCount != null ? row.attemptCount : "—"} attempt{row.attemptCount === 1 ? "" : "s"}</span>
            {row.deliveryMode && <span>{row.deliveryMode === "now" ? "sent now" : row.deliveryMode}</span>}
          </span>
        </span>
        <span className="fm-when" title={row.queuedAt}>
          <b>{rel(row.sentAt || row.queuedAt)}</b>
          <small>{row.sentAt ? "sent" : "queued"} · {istFull(row.sentAt || row.queuedAt).slice(11, 16)} IST</small>
          <ChevronDown className="fm-chev" />
        </span>
      </button>
      {row.error && <div className="note-miss fm-note"><b>{row.state === "skipped" ? "Why the CMS skipped this:" : "Error:"}</b> {row.error}</div>}
      {row.outcome === "unconfirmed" && <div className="note-warn fm-note">FM timed out — this may or may not have been delivered. Counted as neither failed nor delivered.</div>}
      {isOpen && (
        <div className="fm-body">
          <div className="fm-grid">
            {[["queuedAt", istFull(row.queuedAt)], ["sentAt", istFull(row.sentAt)], ["scheduledAt", istFull(row.scheduledAt)], ["broadcastScheduledTime", istFull(row.broadcastScheduledTime)],
              ["setId", row.setId], ["collection", row.collection], ["template.id", row.template && row.template.id], ["template.kind", row.template && row.template.kind],
              ["captionSource", row.captionSource], ["fmStatus", row.fmStatus], ["publishedBy", row.publishedBy], ["competitionId", row.match && row.match.competitionId]]
              .map(([k, v]) => <div key={k}><span className="label">{k}</span><span className="fm-v">{v || "—"}</span></div>)}
            <div><span className="label">match</span><span className="fm-v">{row.match && webUrl(row.match.url) ? <a href={webUrl(row.match.url)} target="_blank" rel="noopener noreferrer">{row.match.matchId || "open"} ↗</a> : "—"}</span></div>
            <div><span className="label">cdnUrl</span><span className="fm-v">{row.cdnUrl ? <a href={row.cdnUrl} target="_blank" rel="noopener noreferrer">open ↗</a> : "—"}</span></div>
          </div>
          <div className="fm-actions">
            {row.asset && webUrl(row.asset.url) && <a className="btn btn-line btn-sm" href={webUrl(row.asset.url)} target="_blank" rel="noopener noreferrer"><Video />Open {row.asset.kind || "asset"}</a>}
            <button className="btn btn-line btn-sm" onClick={() => onCopy(row.cardId)}><Copy />Copy cardId</button>
            {!att && <button className="btn btn-line btn-sm" onClick={() => onAttempts(row)}><History />Load attempts</button>}
          </div>
          {att && (att.loading ? <div className="fm-att"><Loader2 className="spin" /> Loading attempts…</div>
            : att.error ? <div className="note-miss fm-note">Couldn't load attempts: {att.error}</div>
            : att.list && att.list.length ? <div className="fm-att">{att.list.map((a, i) => (
                <div key={i}><span className="tg">{a.status || a.state || "?"}</span> <span className="mono">{istFull(a.time || a.at || a.sentAt)}</span> {a.error && <span className="fm-err">{a.error}</span>}</div>))}</div>
            : <div className="fm-att">No separate attempts list — the full row is below.</div>)}
          <details className="fm-raw"><summary>Raw JSON — every field the feed returned</summary><pre>{JSON.stringify((att && att.row) || row, null, 2)}</pre></details>
        </div>
      )}
    </div>
  );
}

export default function Fm() {
  const { toast, logout } = useApp();
  const init = useMemo(fromHash, []);
  const [env, setEnv] = useState(init.env);
  const [f, setF] = useState(init.f);
  const [group, setGroup] = useState(init.group);
  const [limit, setLimit] = useState(init.limit);
  const [page, setPage] = useState(init.page);
  const [auto, setAuto] = useState(true);
  const [vocab, setVocab] = useState(FALLBACK);
  const [d, setD] = useState({ rows: [], pageOutcomes: null, totalPages: 1, total: 0, hasNext: false });
  const [kpi, setKpi] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [updated, setUpdated] = useState(0);
  const [open, setOpen] = useState(() => new Set());
  const [attempts, setAttempts] = useState({});
  const [seen, setSeen] = useState({ ch: new Set(), lang: new Set() });
  const seq = useRef(0);

  const query = useCallback((extra = {}) => ({
    env, timeField: f.timeField !== "queued" ? f.timeField : undefined, since: f.since || undefined, until: f.until || undefined,
    channel: f.channel || undefined,
    /* Hindi and Thai cards are filed under english — query that and narrow on this page */
    language: f.narration && ["hindi", "thai"].includes(f.narration) ? "english" : (f.language || undefined),
    state: f.states.length ? f.states.join(",") : undefined, outcome: f.outcomes.length ? f.outcomes.join(",") : undefined,
    matchId: f.matchId || undefined, cardId: f.cardId || undefined, limit, page, ...extra,
  }), [env, f, limit, page]);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    const res = await apiGet("/api/fm-deliveries", query());
    if (my !== seq.current) return;
    setLoading(false);
    if (res.status === 401 && res.body && res.body.admin === false) { logout(); return; }   // our session ran out (not FM's own 401) — back to the sign-in
    if (!res.ok) { setError({ status: res.status, message: res.error }); setD({ rows: [], pageOutcomes: null, totalPages: 1, total: 0, hasNext: false }); return; }
    const b = res.body || {};
    let rows = Array.isArray(b.deliveries) ? b.deliveries : [];
    if (f.narration) rows = rows.filter(r => r && r.language === f.narration);
    setSeen(s => ({ ch: new Set([...s.ch, ...rows.map(r => r.channel).filter(Boolean)]), lang: new Set([...s.lang, ...rows.map(r => r.fmLanguageKey).filter(Boolean)]) }));
    setD({ rows, pageOutcomes: b.pageOutcomes || null, totalPages: b.totalPages || 1, total: typeof b.totalDeliveries === "number" ? b.totalDeliveries : rows.length, hasNext: !!b.hasNextPage });
    setError(null); setUpdated(Date.now());
    /* the four outcome counts for the whole window, whatever outcome filter is on */
    const outs = ["delivered", "failed", "pending", "unconfirmed"];
    const counts = await Promise.all(outs.map(o => apiGet("/api/fm-deliveries", query({ limit: 1, page: 1, state: undefined, outcome: o }))));
    if (my !== seq.current) return;
    setKpi(Object.fromEntries(outs.map((o, i) => [o, counts[i].ok && counts[i].body && typeof counts[i].body.totalDeliveries === "number" ? counts[i].body.totalDeliveries : null])));
  }, [query, f.narration, logout]);

  useEffect(() => { toHash({ env, f, group, limit, page }); load(); }, [env, f, group, limit, page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    apiGet("/api/fm-deliveries-meta", { env }).then(r => {
      const b = r.ok && r.body;
      setVocab(b ? { states: (b.states || []).map(x => (typeof x === "string" ? x : x.state)).filter(Boolean), outcomes: b.outcomes || FALLBACK.outcomes } : FALLBACK);
    });
  }, [env]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => { if (!document.hidden) load(); }, 20000);
    return () => clearInterval(t);
  }, [auto, load]);

  /* every filter change starts at page 1; text filters wait for typing to stop */
  const set = patch => { setPage(1); setF(x => ({ ...x, ...patch })); };
  const [typing, setTyping] = useState({ matchId: f.matchId, cardId: f.cardId });
  useEffect(() => { const t = setTimeout(() => { if (typing.matchId !== f.matchId || typing.cardId !== f.cardId) set(typing); }, 450); return () => clearTimeout(t); }, [typing]); // eslint-disable-line react-hooks/exhaustive-deps
  const preset = name => {
    const w = { all: ["", ""], yesterday: [dayStart(-1), dayStart(0)], today: [dayStart(0), dayStart(1)], tomorrow: [dayStart(1), dayStart(2)],
                "7d": [dayStart(-6), dayStart(1)], "30d": [dayStart(-29), dayStart(1)] }[name];
    set({ since: w[0], until: w[1] });
  };
  const reset = () => { setTyping({ matchId: "", cardId: "" }); setGroup(""); setPage(1); setF({ ...BLANK }); };
  const toggle = (k, v) => set({ [k]: f[k].includes(v) ? f[k].filter(x => x !== v) : [...f[k], v] });
  const copy = async text => { try { await navigator.clipboard.writeText(text); toast("Copied", "copy"); } catch (e) { toast("Couldn't copy — select it by hand", "triangle-alert"); } };
  const curl = () => {
    const q = query(); const qs = Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    copy(`curl -sS "${location.origin}/api/fm-deliveries?${qs}"`);
  };
  const flip = id => setOpen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const loadAttempts = async row => {
    setAttempts(a => ({ ...a, [row.cardId]: { loading: true } }));
    const r = await apiGet("/api/fm-deliveries", { env, cardId: row.cardId, attempts: "true", limit: 1 });
    const one = r.ok && r.body && Array.isArray(r.body.deliveries) ? r.body.deliveries[0] : null;
    const list = one && (one.attempts || one.attemptsList || one.sendAttempts);
    setAttempts(a => ({ ...a, [row.cardId]: r.ok ? { list: Array.isArray(list) ? list : null, row: one } : { error: r.error } }));
  };

  const presetOn = name => {
    const w = { yesterday: [dayStart(-1), dayStart(0)], today: [dayStart(0), dayStart(1)], tomorrow: [dayStart(1), dayStart(2)],
                "7d": [dayStart(-6), dayStart(1)], "30d": [dayStart(-29), dayStart(1)] }[name];
    return name === "all" ? !f.since && !f.until : w && f.since === w[0] && f.until === w[1];
  };
  const langChoices = [...LANGS, ...[...seen.lang].filter(k => !LANGS.some(([v]) => v === k)).map(k => [k, k])];
  const chChoices = [...new Set([...CHANNELS, ...seen.ch])];
  const caveat = d.rows.filter(r => r && r.distributionCaveat).length;
  const groups = useMemo(() => {
    if (!group) return null;
    const m = new Map();
    for (const r of d.rows) { const k = group === "channel" ? r.channel || "(no channel)" : group === "language" ? r.fmLanguageKey || "(none)" : r.language || "(unknown)";
      if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [group, d.rows]);

  return (
    <>
      <section className="rp-head">
        <div className="wrap">
          <div className="rp-head-row">
            <div>
              <span className="eyebrow">SportsFC · FM Deliveries</span>
              <h1 className="display l">What FM <b>sent</b></h1>
              <div className="rp-when">Every card the CMS handed to FM, per channel and language — read-only, straight from the FM Deliveries feed.
                {updated ? <> Updated <b>{rel(new Date(updated).toISOString())}</b>{auto ? " · refreshes every 20 s" : " · paused"}.</> : null}</div>
            </div>
            <div className="rp-actions">
              <div className="seg" role="group" aria-label="Environment">
                {ENVS.map(e => <button key={e} className={env === e ? "on" : ""} onClick={() => { setPage(1); setEnv(e); }}>{e[0].toUpperCase() + e.slice(1)}</button>)}
              </div>
              <button className="btn btn-line btn-sm" onClick={() => setAuto(a => !a)}>{auto ? <Pause /> : <Play />}{auto ? "Live" : "Paused"}</button>
              <button className="btn btn-line btn-sm" onClick={load} disabled={loading}>{loading ? <Loader2 className="spin" /> : <RefreshCw />}Refresh</button>
            </div>
          </div>
        </div>
      </section>

      <section className="section tight" style={{ paddingTop: 24 }}>
        <div className="wrap">
          {error && <div className="note-miss fm-banner"><b>HTTP {error.status || "error"}.</b> {error.message}
            {error.status === 503 ? " — this environment isn't configured on this deployment." : error.status === 401 ? " — check the x-api-key for this environment." : error.status === 400 ? " — one of the filters wasn't understood." : ""}</div>}
          {caveat > 0 && <div className="note-warn fm-banner"><AlertTriangle /> <b>{caveat} card{caveat > 1 ? "s" : ""} on this page carr{caveat > 1 ? "y" : "ies"} no matchId</b> — FM reports success, but distribution 404s on the empty match segment and skips it. A known issue outside the CMS.</div>}
          {f.narration && ["hindi", "thai"].includes(f.narration) && <div className="note-warn fm-banner"><Info /> {f.narration} cards are filed with FM under <b>english</b> — this queries english and narrows on this page; the totals are all English-filed cards.</div>}
          {group && <div className="note-warn fm-banner"><Layers /> Grouping covers the {d.rows.length} cards on this page — raise “Per page” for a fuller picture.</div>}

          <div className="stats fm-kpis">
            {Object.entries(OUTCOME).map(([o, [cls, word]]) => {
              const on = f.outcomes.length === 1 && f.outcomes[0] === o;
              return (
                <button key={o} className={`stat fm-kpi ${o}${on ? " on" : ""}`} onClick={() => set({ outcomes: on ? [] : [o] })} title={`Show only ${word.toLowerCase()}`}>
                  <div className="v">{kpi[o] == null ? (loading ? "…" : "—") : kpi[o].toLocaleString()}</div>
                  <div className="k label">{word}</div>
                  <div className="s"><span className={`pill ${cls}`}>{on ? "filtered" : "tap to filter"}</span></div>
                </button>
              );
            })}
          </div>

          <div className="card fm-filters">
            <div className="fm-frow">
              <span className="label">Window</span>
              {[["yesterday", "Yesterday"], ["today", "Today"], ["tomorrow", "Tomorrow"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["all", "All time"]].map(([k, l]) =>
                <button key={k} className={`chipf${presetOn(k) ? " on" : ""}`} onClick={() => preset(k)}>{l}</button>)}
            </div>
            <div className="fm-frow">
              <label className="fld"><span>By</span><select value={f.timeField} onChange={e => set({ timeField: e.target.value })}><option value="queued">queuedAt</option><option value="sent">sentAt</option></select></label>
              <label className="fld"><span>Since (your time)</span><input type="datetime-local" value={toLocal(f.since)} onChange={e => set({ since: fromLocal(e.target.value) })} /></label>
              <label className="fld"><span>Until (your time)</span><input type="datetime-local" value={toLocal(f.until)} onChange={e => set({ until: fromLocal(e.target.value) })} /></label>
              <label className="fld"><span>Channel</span><select value={f.channel} onChange={e => set({ channel: e.target.value })}><option value="">any</option>{chChoices.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
              <label className="fld"><span>Language (FM key)</span><select value={f.language} onChange={e => set({ language: e.target.value })}><option value="">any</option>{langChoices.map(([v, l]) => <option key={v} value={v}>{l} — {v}</option>)}</select></label>
              <label className="fld"><span>Narration (this page)</span><select value={f.narration} onChange={e => set({ narration: e.target.value })}><option value="">any</option>{NARRATION.map(n => <option key={n} value={n}>{n}</option>)}</select></label>
            </div>
            <div className="fm-frow">
              <label className="fld fm-grow"><span>Match ID(s)</span><input value={typing.matchId} placeholder="sr:sport_event:12345" onChange={e => setTyping(t => ({ ...t, matchId: e.target.value.trim() }))} /></label>
              <label className="fld fm-grow"><span>Card / set ID</span><input value={typing.cardId} placeholder="cardId or setId" onChange={e => setTyping(t => ({ ...t, cardId: e.target.value.trim() }))} /></label>
              <label className="fld"><span>Group by</span><select value={group} onChange={e => setGroup(e.target.value)}><option value="">none</option><option value="channel">channel</option><option value="language">FM language key</option><option value="narration">narration language</option></select></label>
              <label className="fld"><span>Per page</span><select value={limit} onChange={e => { setPage(1); setLimit(Number(e.target.value)); }}>{[25, 50, 100, 200, 500].map(n => <option key={n}>{n}</option>)}</select></label>
            </div>
            <div className="fm-frow">
              <span className="label">State</span>
              {vocab.states.map(s => <button key={s} className={`chipf${f.states.includes(s) ? " on" : ""}`} onClick={() => toggle("states", s)}>{s}</button>)}
              <span style={{ flex: 1 }} />
              <button className="btn btn-line btn-sm" onClick={curl}><Terminal />Copy as curl</button>
              <button className="btn btn-line btn-sm" onClick={reset}><RotateCcw />Reset</button>
            </div>
            <div className="fm-hint">The time filter uses {f.timeField === "sent" ? <><b>sentAt</b> — cards that never went out (skipped, failed before FM) have none and are left out.</> : <><b>queuedAt</b> — the one time every row has, skipped cards included.</>}
              {" "}Language matches FM's <b>fmLanguageKey</b>: Portuguese is <code>portuguese-br</code>; Hindi and Thai are filed under <code>english</code>.</div>
          </div>

          <div className="fm-strip">
            {loading && !d.rows.length ? <span><Loader2 className="spin" /> Loading…</span> : !error && <>
              <span><b>{d.total.toLocaleString()}</b> in this window</span>
              {d.pageOutcomes && <span title="this page only">this page: {d.pageOutcomes.delivered || 0} delivered · {d.pageOutcomes.failed || 0} failed · {d.pageOutcomes.pending || 0} pending · {d.pageOutcomes.unconfirmed || 0} unconfirmed</span>}
              <span>{f.since ? "oldest first (a since is set)" : "newest first"}</span>
            </>}
          </div>

          {!error && !loading && !d.rows.length && <div className="card empty"><Inbox /><b>Nothing here</b><div>No cards match these filters in this window.</div></div>}
          {groups ? groups.map(([name, rows]) => (
            <div key={name} className="fm-group">
              <div className="fm-group-h"><b>{name}</b><span className="label">{rows.length} card{rows.length === 1 ? "" : "s"}</span></div>
              {rows.map(r => <FmRow key={r.cardId} row={r} isOpen={open.has(r.cardId)} att={attempts[r.cardId]} onFlip={flip} onAttempts={loadAttempts} onCopy={copy} />)}
            </div>
          )) : d.rows.map(r => <FmRow key={r.cardId} row={r} isOpen={open.has(r.cardId)} att={attempts[r.cardId]} onFlip={flip} onAttempts={loadAttempts} onCopy={copy} />)}

          {d.rows.length > 0 && (
            <div className="fm-pager">
              <button className="btn btn-line btn-sm" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}><ChevronLeft />Prev</button>
              <span className="label">Page {page} of {d.totalPages}</span>
              <button className="btn btn-line btn-sm" disabled={!d.hasNext && page >= d.totalPages} onClick={() => setPage(p => p + 1)}>Next<ChevronRight /></button>
            </div>
          )}
          <div className="foot-note">Read-only view of the FM Deliveries feed ({env}) through this site's proxy — nothing here can write to the CMS. Times in IST.
            {" "}The same data as an API: <span className="mono">/api/fm-deliveries?env={env}&amp;…</span></div>
        </div>
      </section>
    </>
  );
}
