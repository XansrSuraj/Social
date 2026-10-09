/**
 * The system's health, from the ledger — one verdict per part, for the website's Health page
 * (GET /api/pipeline → health). Pure: the ledger and the clock in, a plain object out (tested in
 * test/pipeline.test.js).
 *
 *   ok    working, and recently proven so
 *   warn  working with a caveat (one failed read, not read for a while, a channel restricted)
 *   bad   not working — checks against it are not being made
 *   off   not set up
 *
 * Every reader is read at least every PROBE_MIN minutes by the pipeline whether a card is due or not,
 * so "last read" here is never older than that while the clock runs.
 */
const { FM_CHANNELS, labelOf } = require("./channels.js");

const PROBE_MIN = 30;
const METHOD = {
  x: "FxTwitter API — free", facebook: "Facebook Reels page — free", instagram: "Instagram profile embed — free",
  tiktok: "TikTok creator embed — free", youtube: "YouTube channel page — free", telegram: "t.me public preview — free",
  tgbot: "Telegram user session (MTProto)",
};
const mins = ms => Math.round(ms / 60e3);
const ago = (now, at) => { if (!at) return "never"; const m = mins(now - at); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const rate = hist => (hist && hist.length ? Math.round(100 * hist.filter(h => h.ok).length / hist.length) : null);

function healthOf(led, now, outputs = {}) {
  const groups = [];

  /* ── the pipeline itself ── */
  const tickAge = led.lastTickAt ? now - led.lastTickAt : null;
  const lastHour = (led.tickLog || []).filter(t => now - t.at < 3600e3);
  const crash = led.lastCrash && now - led.lastCrash.at < 60 * 60e3 ? led.lastCrash : null;
  const errs = (led.lastTick && led.lastTick.errors) || [];
  groups.push({ id: "pipeline", title: "Pipeline", items: [
    { id: "clock", name: "Automatic checks (clock)",
      state: tickAge == null ? "bad" : tickAge < 3 * 60e3 ? "ok" : tickAge < 12 * 60e3 ? "warn" : "bad",
      detail: tickAge == null ? "has never run" : `last check ${ago(now, led.lastTickAt)} · ${lastHour.length} checks in the last hour (every minute expected)` +
        (tickAge >= 12 * 60e3 ? " — the clock (cron-job.org / GitHub Actions) has stopped" : ""),
      lastOkAt: led.lastTickAt || null },
    { id: "run", name: "Check runs",
      state: crash ? "bad" : errs.length ? "warn" : led.lastTick ? "ok" : "bad",
      detail: crash ? `crashed ${ago(now, crash.at)}: ${String(crash.error).split("\n")[0].slice(0, 160)}`
        : errs.length ? `last check finished with ${errs.length} error${errs.length === 1 ? "" : "s"}: ${errs.join(" · ").slice(0, 200)}`
        : led.lastTick ? `last check took ${(led.lastTick.ms / 1000).toFixed(1)} s · ${led.lastTick.checked} post${led.lastTick.checked === 1 ? "" : "s"} checked · ${(led.lastTick.read || []).length} channel${(led.lastTick.read || []).length === 1 ? "" : "s"} read`
        : "no check has finished yet" },
    { id: "report", name: "Daily-check report sync",
      state: !led.lastReportMerge ? "warn" : now - led.lastReportMerge.at < 2 * PROBE_MIN * 60e3 ? "ok" : "warn",
      detail: led.lastReportMerge ? `posts merged into the report ${ago(now, led.lastReportMerge.at)} (${led.lastReportMerge.channels} channel${led.lastReportMerge.channels === 1 ? "" : "s"})` : "nothing merged yet",
      lastOkAt: led.lastReportMerge ? led.lastReportMerge.at : null },
  ] });

  /* ── FM Deliveries ── */
  const fm = led.fm || {};
  groups.push({ id: "fm", title: "FM Deliveries feed", items: [
    { id: "fm", name: "FM Deliveries (prod)",
      state: fm.ok ? (now - (fm.lastOkAt || 0) < 12 * 60e3 ? "ok" : "warn") : fm.failingSince ? "bad" : "warn",
      detail: fm.ok ? `answered ${ago(now, fm.lastOkAt)} · ${fm.count} deliveries in the last 36 h` + (fm.ms != null ? ` · ${(fm.ms / 1000).toFixed(1)} s` : "") +
          (fm.newestAt ? ` · newest delivery ${ago(now, fm.newestAt)}` : "")
        : fm.failingSince ? `not answering since ${ago(now, fm.failingSince)} — ${fm.lastError || "no answer"}` : "not read yet",
      since: fm.ok ? null : fm.failingSince || null, lastOkAt: fm.lastOkAt || null, uptime: rate(fm.history), history: (fm.history || []).slice(0, 30) },
  ] });

  /* ── the channel readers (scrapers) ── */
  const seen = new Set(), readers = [];
  for (const [k, v] of Object.entries(FM_CHANNELS)) {
    if (!v.read || v.mode === "skip" || seen.has(v.read.id)) continue;
    seen.add(v.read.id);
    const [ch, lg] = k.split("/");
    const h = (led.readers || {})[v.read.id] || null;
    const readAge = h && h.lastReadAt ? now - h.lastReadAt : null;
    let state, detail;
    if (!h || !h.lastReadAt && !h.lastOkAt) { state = "warn"; detail = "not read yet — it will be within " + PROBE_MIN + " min"; }
    else if (v.soft && !h.ok) { state = "warn"; detail = `can't be read while the account is 18+ — checked on every drop, verified automatically once the restriction is lifted`; }
    else if (h.ok && readAge != null && readAge > (2 * PROBE_MIN + 5) * 60e3) { state = "warn"; detail = `last read ${ago(now, h.lastReadAt)} — older than it should be`; }
    else if (h.ok) { state = "ok"; detail = `read ${ago(now, h.lastReadAt || h.lastOkAt)} · ${h.posts != null ? h.posts + " posts in 30 h" : "ok"}` + (h.newestPostAt ? ` · newest post ${ago(now, h.newestPostAt)}` : ""); }
    else if (h.down) { state = "bad"; detail = `not readable since ${ago(now, h.failingSince || h.lastFailAt)} — ${String(h.lastError || "").replace(/ — the paid fallback is skipped on automatic checks/, "").slice(0, 160)} · retried every minute`; }
    else { state = "warn"; detail = `the last read failed (${ago(now, h.lastFailAt)}) — ${String(h.lastError || "").slice(0, 140)} · retrying`; }
    readers.push({ id: v.read.id, name: labelOf(ch, lg), platform: v.read.platform, account: v.read.url, method: METHOD[v.read.platform] || v.read.platform,
      source: h && h.source || null, state, detail, since: h && !h.ok ? h.failingSince || null : null, lastOkAt: h && h.lastOkAt || null,
      lastReadAt: h && h.lastReadAt || null, uptime: rate(h && h.history), history: (h && h.history || []).slice(0, 30), soft: !!v.soft });
  }
  groups.push({ id: "readers", title: "Channel readers (scrapers)", items: readers });

  /* ── where alerts go ── */
  const log = led.waLog || [];
  const lastOf = via => log.find(l => (l.via || "whatsapp") === via);
  const outs = [["teams", "Microsoft Teams", outputs.teams], ["push", "Phone push (ntfy)", outputs.push], ["whatsapp", "WhatsApp (CallMeBot)", outputs.whatsapp]];
  groups.push({ id: "alerts", title: "Alerts", items: outs.map(([via, name, on]) => {
    const l = lastOf(via);
    return { id: via, name, state: !on ? "off" : !l ? "ok" : l.ok ? "ok" : "bad",
      detail: !on ? "not set up" : !l ? "set up · nothing sent yet" : l.ok ? `last message delivered ${ago(now, l.at)}` : `the last send failed ${ago(now, l.at)} — ${l.error || "no reason given"}`,
      lastOkAt: (log.find(x => (x.via || "whatsapp") === via && x.ok) || {}).at || null };
  }) });

  const all = groups.flatMap(g => g.items);
  const bad = all.filter(i => i.state === "bad"), warn = all.filter(i => i.state === "warn");
  const core = ["clock", "run", "fm"];
  return {
    at: now, overall: bad.some(i => core.includes(i.id)) ? "down" : bad.length || warn.length ? "degraded" : "ok",
    summary: bad.length ? `${bad.length} not working: ${bad.map(i => i.name).join(", ")}` : warn.length ? `${warn.length} to keep an eye on: ${warn.map(i => i.name).join(", ")}` : "Everything is working",
    counts: { ok: all.filter(i => i.state === "ok").length, warn: warn.length, bad: bad.length, off: all.filter(i => i.state === "off").length },
    groups,
  };
}

module.exports = { healthOf };
