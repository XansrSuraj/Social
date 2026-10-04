/**
 * The FM → channels pipeline (see PIPELINE.md).
 *
 *   GET /api/pipeline                 status for the Live page: today's deliveries and what became of
 *                                     each, reader health, the alert log, when it last ran
 *   GET /api/pipeline?op=tick         run one tick (pipeline/tick.js). Called every 5 minutes by
 *                                     .github/workflows/pipeline.yml and once a day by Vercel's cron.
 *                                     Safe to call by anyone: a tick within 40 s of the last one, or
 *                                     while another runs, does nothing, and it only ever reads.
 *   GET /api/pipeline?op=test-alert   send one WhatsApp test message (at most one per 10 minutes)
 *
 * Optional PIPELINE_KEY: when set, op=tick and op=test-alert need ?key=… (or Vercel's cron header).
 */
const { upstreamGet } = require("../fm-deliveries-client.js");
const { waitUntil } = require("@vercel/functions");
const { collectChannels } = require("./collect.js");
const store = require("../pipeline/store.js");
const wa = require("../pipeline/whatsapp.js");
const { tick, PIPELINE_URL } = require("../pipeline/tick.js");
const { FM_CHANNELS } = require("../pipeline/channels.js");

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
      if (!wa.configured() && !wa.pushConfigured())
        return res.status(200).json({ ok: false, error: "No alert channel is set up — set NTFY_TOPIC and/or WHATSAPP_PHONE + CALLMEBOT_APIKEY on Vercel, then redeploy." });
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
      led.waLog = [...log, ...(led.waLog || [])].slice(0, 60);
      await store.saveLedger(led, lock.updatedAt, true);
      return res.status(200).json({ ok: !left.length, log });
    }

    /* status — public and read-only; nothing secret is in the ledger (no keys, no numbers) */
    const led = await store.readLedger();
    const deliveries = Object.values(led.deliveries || {}).sort((a, b) => (b.when || 0) - (a.when || 0))
      .map(({ caption, ...e }) => ({ ...e, captionHead: String(caption || "").replace(/\s+/g, " ").slice(0, 140) }));
    return res.status(200).json({
      ok: true, now: new Date().toISOString(),
      lastTick: led.lastTick || null, lastTickAt: led.lastTickAt || null, ticks: led.ticks || 0, startedAt: led.startedAt || null,
      lastCrash: led.lastCrash || null, fm: led.fm || null, readers: led.readers || {},
      whatsapp: { configured: wa.configured(), push: wa.pushConfigured(), outbox: (led.outbox || []).length, log: led.waLog || [] },
      alerts: (led.alerts || []).slice(0, 80), deliveries, lastReportMerge: led.lastReportMerge || null,
      coverage: Object.entries(FM_CHANNELS).map(([k, v]) => ({ fm: k, mode: v.mode, account: v.read ? v.read.url : null, why: v.why || null })),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
