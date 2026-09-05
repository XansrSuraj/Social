/**
 * GET /api/keepalive  ->  { ok, ms, updatedAt }
 *
 * Touches the database on a schedule so the project is never idle.
 *
 * Supabase pauses a free project after ~7 days without activity, and a paused project takes
 * the whole directory offline until somebody restores it by hand — the site reports "Local
 * only" and shows nothing, which reads exactly like the data has been deleted.
 *
 * Opening the site is not activity on its own: the page is static and only /api/data speaks
 * to Postgres, so a week in which nobody happens to open the directory is a week of silence
 * as far as Supabase is concerned. This endpoint removes that dependency on someone visiting.
 *
 * It is a READ, deliberately. A write would move updated_at, and the optimistic-concurrency
 * guard in /api/data compares against exactly that — so a nightly write would hand a spurious
 * "changed on another device" conflict to anyone who happened to be mid-edit.
 *
 * Schedule lives in vercel.json. Safe to call by hand at any time.
 */
const crypto = require("crypto");

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const SECRET = process.env.CRON_SECRET || "";
const TABLE  = "orghub_state";
const ROW_ID = 1;
const TIMEOUT = 12000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x);          // burn a comparison so length isn't leaked by timing
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

/* One rolling snapshot per weekday: 101 = Sunday … 107 = Saturday. */
const SLOT_BASE = 101;

async function snap() {
  const r = await fetch(
    `${SB_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data,updated_at`,
    { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, Accept: "application/json" } }
  );
  if (!r.ok) throw new Error("read for snapshot failed (" + r.status + ")");
  const rows = await r.json();
  const live = Array.isArray(rows) && rows[0] ? rows[0].data : null;

  /* Never let an empty directory become the backup. A wipe — a bad import, a Reset, an
     overwrite — is exactly the thing these snapshots exist to undo, and copying it over them
     every night for a week would quietly destroy the only way back. */
  const orgs = (live && Array.isArray(live.orgs)) ? live.orgs.length : 0;
  if (!orgs) return { ok: false, skipped: "live directory is empty — snapshot refused" };

  const channels = live.orgs.reduce((n, o) => n + ((o.socials || []).length), 0);
  const slot = SLOT_BASE + new Date().getUTCDay();
  const w = await fetch(`${SB_URL}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: "Bearer " + SB_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([{ id: slot, data: live, updated_at: new Date().toISOString() }]),
  });
  if (!w.ok) throw new Error("snapshot write failed (" + w.status + "): " + (await w.text()).slice(0, 200));
  return { ok: true, slot, orgs, channels };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  /* Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when that variable is set. The
     check is opt-in: without the variable the endpoint stays open, because a keep-alive that
     silently 401s the moment somebody forgets a setting is worse than no keep-alive at all.
     Nothing here is worth guarding hard anyway — it returns a timestamp and no data. */
  if (SECRET) {
    const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!safeEqual(got, SECRET)) {
      return res.status(401).json({ ok: false, error: "Bad or missing CRON_SECRET." });
    }
  }

  if (!SB_URL || !SB_KEY) {
    return res.status(503).json({
      ok: false, configured: false,
      error: "Cloud storage is not configured on this deployment, so there is nothing to keep alive.",
    });
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    /* The cheapest query that still reaches Postgres: one indexed row, one small column,
       and explicitly NOT the `data` column — that one holds the whole directory, and there
       is no reason to haul it across the wire every night just to prove the server is awake. */
    const r = await fetch(
      `${SB_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=updated_at`,
      {
        headers: {
          apikey: SB_KEY,
          Authorization: "Bearer " + SB_KEY,
          Accept: "application/json",
        },
        signal: ctl.signal,
      }
    );
    const ms = Date.now() - t0;
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      return res.status(502).json({ ok: false, ms, status: r.status, error: body });
    }
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;

    /* Same visit, second job: keep a week of daily snapshots.
       They live in the same table under ids 101-107, one per weekday, so today overwrites the
       copy from this day last week and the window rotates itself with no cleanup and no
       migration. /api/data only ever reads and writes id=1, so it never sees them.
       Failure here is not failure of the keep-alive — the ping has already done its job by the
       time we get to this line, and reporting it as down would send somebody hunting a database
       that is demonstrably awake. */
    let snapshot = null;
    if (row) {
      try { snapshot = await snap(); }
      catch (e) { snapshot = { ok: false, error: String((e && e.message) || e) }; }
    }

    return res.status(200).json({
      ok: true,
      ms,
      pingedAt: new Date().toISOString(),
      updatedAt: row ? row.updated_at : null,
      snapshot,
      note: row ? "database awake" : "database awake, row 1 not created yet",
    });
  } catch (err) {
    const ms = Date.now() - t0;
    const aborted = err && err.name === "AbortError";
    return res.status(504).json({
      ok: false, ms,
      error: aborted ? `No answer within ${TIMEOUT}ms` : String((err && err.message) || err),
    });
  } finally {
    clearTimeout(timer);
  }
};
