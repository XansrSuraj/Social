/**
 * The FM → channels pipeline (see PIPELINE.md).
 *
 *   GET /api/pipeline                 status for the Live page: today's deliveries and what became of
 *                                     each, reader health, the alert log, when it last ran
 *   GET /api/pipeline?op=tick         run one tick (pipeline/tick.js). Called every minute by cron-job.org
 *                                     (&fast=1), every 30 min by .github/workflows/pipeline.yml (backup)
 *                                     and once a day by Vercel's cron.
 *                                     Safe to call by anyone: a tick within 40 s of the last one, or
 *                                     while another runs, does nothing, and it only ever reads.
 *   GET /api/pipeline?op=test-alert   send one test alert to every channel (at most one per 10 minutes)
 *   GET /api/pipeline?op=report&at=16:30[&day=YYYY-MM-DD]   send that drop's full report again (once a minute)
 *
 * Optional PIPELINE_KEY: when set, op=tick and op=test-alert need ?key=… (or Vercel's cron header).
 */
const { upstreamGet } = require("../fm-deliveries-client.js");
const { waitUntil } = require("@vercel/functions");
const { collectChannels } = require("./collect.js");
const store = require("../pipeline/store.js");
const wa = require("../pipeline/whatsapp.js");
const teams = require("../pipeline/teams.js");
const { dropData, dropText } = require("../pipeline/report.js");
const { tick, PIPELINE_URL } = require("../pipeline/tick.js");
const { FM_CHANNELS, labelOf } = require("../pipeline/channels.js");
const { healthOf } = require("../pipeline/health.js");

/* every FM delivery queued OR sent since `since` (both time fields, so nothing falls between) */
async function fmDeliveries({ since }) {
  const byId = new Map();
  for (const timeField of ["queued", "sent"]) {
    for (let page = 1; page <= 6; page++) {
      const { status, body } = await upstreamGet("prod", "/api/fm-deliveries-feed", { since, timeField, limit: "500", page: String(page) });
      if (status !== 200 || !body || !Array.isArray(body.deliveries))
        throw new Error(`FM feed HTTP ${status}${body && body.error ? " — " + String(body.error).slice(0, 160) : ""}`);
      for (const d of body.deliveries) if (d && d.cardId) byId.set(d.cardId, d);
      if (!body.hasNextPage) break;
    }
  }
  return [...byId.values()];
}

const authorised = req => {
  const key = process.env.PIPELINE_KEY;
  if (!key) return true;
  const q = (req.query && req.query.key) || "";
  const cron = process.env.CRON_SECRET && req.headers && req.headers.authorization === "Bearer " + process.env.CRON_SECRET;
  return q === key || !!cron;
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  const op = (req.query && req.query.op) || "status";

  try {
    if (op === "tick") {
      if (!authorised(req)) return res.status(401).json({ ok: false, error: "PIPELINE_KEY required" });
      const run = tick({ fm: fmDeliveries, collect: collectChannels, store, wa, owner: "tick:" + Date.now() });
      /* ?fast=1 — answer at once and finish in the background (Vercel's waitUntil). For a caller with a
         short timeout: cron-job.org's free plan cuts a request at 30 s and switches a job off after 25
         failures in a row, and a tick that reads many channels can take longer than that. */
      if (req.query && req.query.fast) {
        waitUntil(run.catch(e => console.error("pipeline tick failed:", e)));
        return res.status(202).json({ ok: true, started: true });
      }
      return res.status(200).json(await run);
    }

    if (op === "test-alert") {
      if (!authorised(req)) return res.status(401).json({ ok: false, error: "PIPELINE_KEY required" });
      if (!wa.configured() && !wa.pushConfigured() && !teams.configured())
        return res.status(200).json({ ok: false, error: "No alert channel is set up — set TEAMS_WEBHOOK_URL, NTFY_TOPIC and/or WHATSAPP_PHONE + CALLMEBOT_APIKEY on Vercel, then redeploy." });
      const lock = await store.lockLedger("test-alert");
      if (!lock) return res.status(409).json({ ok: false, error: "a tick is running — try again in a minute" });
      const led = lock.ledger;
      if (led.lastTestAt && Date.now() - led.lastTestAt < 10 * 60e3) {
        await store.saveLedger(led, lock.updatedAt, true);
        return res.status(429).json({ ok: false, error: "one test per 10 minutes" });
      }
      led.lastTestAt = Date.now();
      const testText = `✅ *SportsFC pipeline* — alerts are working.\n${PIPELINE_URL}`;
      const log = [], left = [];
      if (wa.configured()) {
        const r = await wa.flush([{ kind: "test", text: testText }]);
        left.push(...r.left); log.push(...r.log.map(x => ({ ...x, via: "whatsapp" })));
      }
      if (wa.pushConfigured()) {
        try { await wa.push(testText, { click: PIPELINE_URL }); log.push({ at: Date.now(), ok: true, via: "push", kind: "test" }); }
        catch (e) { left.push(1); log.push({ at: Date.now(), ok: false, via: "push", error: String(e.message || e) }); }
      }
      if (teams.configured()) {
        try { await teams.post(teams.card([{ kind: "test", text: "✅ *Teams alerts are working* — this channel will get every drop's report, every problem, and the daily summary at 23:00 IST." }], { link: PIPELINE_URL }));
              log.push({ at: Date.now(), ok: true, via: "teams", kind: "test" }); }
        catch (e) { left.push(1); log.push({ at: Date.now(), ok: false, via: "teams", error: String(e.message || e) }); }
      }
      led.waLog = [...log, ...(led.waLog || [])].slice(0, 60);
      await store.saveLedger(led, lock.updatedAt, true);
      return res.status(200).json({ ok: !left.length, log });
    }

    /* op=report&at=16:30[&day=2026-10-05] — the full drop report for a past drop, sent again to every
       alert channel (at most once a minute) */
    if (op === "report") {
      if (!authorised(req)) return res.status(401).json({ ok: false, error: "PIPELINE_KEY required" });
      const m = String((req.query && req.query.at) || "").match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return res.status(400).json({ ok: false, error: "give ?at=HH:MM (IST)" });
      const day = (req.query && req.query.day) || new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
      const target = Date.parse(`${day}T${m[1].padStart(2, "0")}:${m[2]}:00+05:30`);
      const lock = await store.lockLedger("report");
      if (!lock) return res.status(409).json({ ok: false, error: "a check is running — try again in a minute" });
      const led = lock.ledger;
      if (led.lastManualReportAt && Date.now() - led.lastManualReportAt < 60e3) {
        await store.saveLedger(led, lock.updatedAt, true);
        return res.status(429).json({ ok: false, error: "one report a minute" });
      }
      const drops = {};
      for (const e of Object.values(led.deliveries || {})) if (e.dropKey) (drops[e.dropKey] = drops[e.dropKey] || []).push(e);
      const near = Object.values(drops).map(list => ({ list, first: Math.min(...list.map(e => e.when)) }))
        .filter(x => Math.abs(x.first - target) <= 60 * 60e3).sort((a, b) => Math.abs(a.first - target) - Math.abs(b.first - target))[0];
      if (!near) { await store.saveLedger(led, lock.updatedAt, true); return res.status(404).json({ ok: false, error: `no drop within an hour of ${m[0]} on ${day}` }); }
      led.lastManualReportAt = Date.now();
      const d = dropData(near.list);
      const text = dropText(d, PIPELINE_URL), log = [];
      const title = (d.problems.length ? "⚠️ " : "✅ ") + `Drop report ${new Date(d.when + 5.5 * 3600e3).toISOString().slice(11, 16)} ${d.card}`;
      if (wa.pushConfigured()) {
        try { await wa.push(text, { problem: d.problems.length > 0, click: PIPELINE_URL, title }); log.push({ at: Date.now(), ok: true, via: "push", kind: "report" }); }
        catch (e) { log.push({ at: Date.now(), ok: false, via: "push", error: String(e.message || e) }); }
      }
      if (teams.configured()) {
        try { await teams.post(teams.card([{ kind: "slot", text, report: d }], { link: PIPELINE_URL })); log.push({ at: Date.now(), ok: true, via: "teams", kind: "report" }); }
        catch (e) { log.push({ at: Date.now(), ok: false, via: "teams", error: String(e.message || e) }); }
      }
      if (wa.configured()) { const r = await wa.flush([{ kind: "report", text }]); log.push(...r.log.map(x => ({ ...x, via: "whatsapp" }))); }
      led.waLog = [...log, ...(led.waLog || [])].slice(0, 60);
      await store.saveLedger(led, lock.updatedAt, true);
      return res.status(200).json({ ok: log.length > 0 && log.every(x => x.ok), drop: { at: d.when, card: d.card, ok: d.ok, checked: d.checked, problems: d.problems.length }, log });
    }

    /* status — public and read-only; nothing secret is in the ledger (no keys, no numbers) */
    const led = await store.readLedger();
    const deliveries = Object.values(led.deliveries || {}).sort((a, b) => (b.when || 0) - (a.when || 0))
      .map(({ caption, ...e }) => ({ ...e, captionHead: String(caption || "").replace(/\s+/g, " ").slice(0, 140) }));
    return res.status(200).json({
      ok: true, now: new Date().toISOString(),
      /* the Health page: one verdict per part — clock, FM, every reader, every alert channel */
      health: healthOf(led, Date.now(), { teams: teams.configured(), push: wa.pushConfigured(), whatsapp: wa.configured() }),
      lastTick: led.lastTick || null, lastTickAt: led.lastTickAt || null, ticks: led.ticks || 0, startedAt: led.startedAt || null,
      lastCrash: led.lastCrash || null, fm: led.fm || null, readers: led.readers || {},
      whatsapp: { configured: wa.configured(), push: wa.pushConfigured(), teams: teams.configured(), outbox: (led.outbox || []).length, log: led.waLog || [] },
      alerts: (led.alerts || []).slice(0, 80), deliveries, lastReportMerge: led.lastReportMerge || null,
      /* a reader's id → the name people know it by ("x-vn" → "X VN"), for the System status panel */
      readerLabels: Object.fromEntries(Object.entries(FM_CHANNELS).filter(([, v]) => v.read)
        .map(([k, v]) => [v.read.id, labelOf(...k.split("/"))])),
      /* accounts not created yet are left out entirely — FM sends there, distribution drops it */
      coverage: Object.entries(FM_CHANNELS).filter(([, v]) => v.mode !== "skip")
        .map(([k, v]) => ({ fm: k, mode: v.mode, soft: !!v.soft, account: v.read ? v.read.url : null, why: v.why || null })),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
