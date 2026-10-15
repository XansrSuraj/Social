/**
 * GET  /api/report  -> read the shared daily-check report (public, read-only)
 * PUT  /api/report  -> replace it        (body: { data: {...}, baseUpdatedAt?: "…" })
 *
 * Why this exists
 * ---------------
 * The daily check used to live only in the browser that ran it (localStorage). That means a check
 * run on the office laptop was invisible on a phone, and two people could not see the same "today"
 * picture. This endpoint gives the report ONE home in Supabase, so every device that opens the
 * dashboard reads the same last run, the same counts, and the same manual ✓ confirmations.
 *
 * Storage: one row in the same orghub_state table api/data.js uses, id = 3 (id 1 is the directory,
 * id 2 is the ingest store). Plain REST, no npm packages. If Supabase is not configured the endpoint
 * reports mode:"local" and the browser keeps using localStorage — the check still works, it just is
 * not shared. That is the first fallback; the browser keeping its own copy either way is the second.
 *
 * Security posture (deliberate, documented)
 * -----------------------------------------
 * The report is non-sensitive operational data — post counts, timestamps, and which channel a drop
 * landed on. Only the signed-in admin writes it ("Authorization: Bearer <session>", admin-auth.js —
 * the session comes from /api/auth; nothing secret ships in the page). Besides:
 *   · the payload is shape-checked and size-capped here, so a malformed or oversized body cannot
 *     poison the row or blow past Postgres limits;
 *   · a stale write is refused with 409 (optimistic concurrency), same as api/data.js;
 *   · without ADMIN_PASSWORD set, nobody can write (fails closed, 503).
 * Reading stays open: the content team sees the day's report without signing in.
 */
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const auth = require("../admin-auth.js");
const TABLE  = "orghub_state";

/* a report is small — counts, a few captions, some confirms. Cap the stored blob well under any
   Postgres/PostgREST limit so a runaway client (or a bad actor) cannot bloat the row. */
const MAX_BYTES = 2 * 1024 * 1024;

const configured = () => !!(SB_URL && SB_KEY);

function sbHeaders(extra) {
  return Object.assign({
    apikey: SB_KEY,
    Authorization: "Bearer " + SB_KEY,
    "Content-Type": "application/json",
  }, extra || {});
}

/* one row per brand: SportsFC keeps row 3, MatchPulse has row 4. Only known brands are accepted —
   an unknown name can never pick an arbitrary row of the shared table (own keys only: "__proto__" is not a brand). */
const BRAND_ROWS = { sportsfc: 3, matchpulse: 4 };
const rowOf = b => (Object.prototype.hasOwnProperty.call(BRAND_ROWS, b) ? BRAND_ROWS[b] : null);

/* Supabase's free plan counts every byte it sends (5 GB a month) and the report is ~0.7 MB, so it is never
   read in full when it hasn't changed: every read first asks for the row's updated_at (a few bytes); this
   instance keeps the last full copy and serves it while that stamp still matches, and requests arriving
   together share one full read. A reader can't make Supabase send the report more often than it changes. */
const copy = {};                                   // row → { data, updatedAt }
const reading = {};                                // row → the full read in flight
const sameInstant = (x, y) => { const a = new Date(x).getTime(), b = new Date(y).getTime(); return Number.isFinite(a) && a === b; };
async function stampOf(row) {
  const c = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${row}&select=updated_at`, { headers: sbHeaders() });
  if (!c.ok) throw new Error(`Supabase read failed (${c.status})`);
  const rows = await c.json();
  return Array.isArray(rows) && rows[0] ? rows[0].updated_at : null;
}
function fullRead(row) {
  if (!reading[row]) reading[row] = (async () => {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${row}&select=data,updated_at`, { headers: sbHeaders() });
    if (!r.ok) throw new Error(`Supabase read failed (${r.status})`);
    const rows = await r.json();
    const got = Array.isArray(rows) && rows[0] ? { data: rows[0].data, updatedAt: rows[0].updated_at } : { data: null, updatedAt: null };
    if (got.updatedAt) copy[row] = got;
    return got;
  })().finally(() => { delete reading[row]; });
  return reading[row];
}
/* every string well-formed before it is sent — half an emoji makes Supabase refuse the whole row (14 Oct 2026) */
const wellFormed = v => JSON.stringify(v, (k, x) => (typeof x === "string" && x.toWellFormed ? x.toWellFormed() : x));

module.exports = async (req, res) => {
  const ROW_ID = rowOf((req.query && req.query.brand) || "sportsfc");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (!ROW_ID) return res.status(400).json({ ok: false, error: "Unknown brand." });

  /* ---------------- not configured: local mode ---------------- */
  if (!configured()) {
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, mode: "local", configured: false, data: null });
    }
    /* a PUT in local mode is not an error — the browser simply keeps its own copy */
    return res.status(200).json({ ok: true, mode: "local", configured: false, saved: false });
  }

  try {
    /* ---------------- read ---------------- */
    if (req.method === "GET") {
      const cur = await stampOf(ROW_ID);
      /* ?since=<updatedAt the browser holds>: still that version → say so, send nothing more */
      const since = req.query && req.query.since;
      if (since && cur && sameInstant(cur, since)) return res.status(200).json({ ok: true, mode: "cloud", configured: true, unchanged: true, updatedAt: cur });
      const hit = copy[ROW_ID] && cur && sameInstant(copy[ROW_ID].updatedAt, cur) ? copy[ROW_ID] : null;
      const got = hit || (cur ? await fullRead(ROW_ID) : { data: null, updatedAt: null });
      return res.status(200).json({ ok: true, mode: "cloud", configured: true, data: got.data, updatedAt: got.updatedAt });
    }

    /* ---------------- write ---------------- */
    if (req.method === "PUT") {
      /* the admin only (a signed-in session) — and nobody at all until ADMIN_PASSWORD is set: an open write
         let anyone replace or empty the shared report (found in the 14 Oct 2026 review) */
      if (!auth.isAdmin(req)) return auth.deny(res);

      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body.data !== "object" || body.data === null || Array.isArray(body.data)) {
        return res.status(400).json({ ok: false, error: "Expected a JSON body of the form { data: {...} }." });
      }
      const serialized = wellFormed(body.data);
      if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
        return res.status(413).json({ ok: false, error: "Report is too large to store." });
      }

      /* Optimistic concurrency in ONE conditional write: the row is replaced only if it is still the
         version the browser read (updated_at = base), so the pipeline's merge or the content team's Run
         landing in between is never lost — the browser is told 409, merges the newer row in and sends
         again. A write with no base (the browser never managed to read the row) may only create the row,
         never replace one (15 Oct 2026 review: a failed read at page load let a stale local copy
         overwrite the shared report). */
      const conflict = () => res.status(409).json({ ok: false, conflict: true,
        error: "The report was updated meanwhile — merging the newer one in." });
      const now = new Date().toISOString();
      const row = `{"data":${serialized},"updated_at":${JSON.stringify(now)}}`;
      const base = body.baseUpdatedAt || null;
      let stored = now;
      if (base) {
        const w = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&updated_at=eq.${encodeURIComponent(base)}&select=updated_at`, {
          method: "PATCH", headers: sbHeaders({ Prefer: "return=representation" }), body: row });
        if (!w.ok) throw new Error(`Supabase write failed (${w.status}): ${(await w.text()).slice(0, 200)}`);
        const back = await w.json().catch(() => null);
        if (!Array.isArray(back) || !back.length) return conflict();
        if (back[0].updated_at) stored = back[0].updated_at;
      } else {
        if (await stampOf(ROW_ID)) return conflict();
        const w = await fetch(`${SB_URL}/rest/v1/${TABLE}?select=updated_at`, {
          method: "POST", headers: sbHeaders({ Prefer: "return=representation" }), body: `[{"id":${ROW_ID},${row.slice(1)}]` });
        if (w.status === 409) return conflict();
        if (!w.ok) throw new Error(`Supabase write failed (${w.status}): ${(await w.text()).slice(0, 200)}`);
        const back = await w.json().catch(() => null);
        if (Array.isArray(back) && back[0] && back[0].updated_at) stored = back[0].updated_at;
      }
      copy[ROW_ID] = { data: body.data, updatedAt: stored };
      return res.status(200).json({ ok: true, mode: "cloud", saved: true, updatedAt: stored });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed." });
  } catch (err) {
    /* the store's own error text stays in the function log, not in an answer anyone can read */
    console.error("api/report:", (err && err.message) || err);
    return res.status(500).json({ ok: false, error: "The report store isn't answering — try again in a minute." });
  }
};
