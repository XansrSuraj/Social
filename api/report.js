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
   an unknown name can never pick an arbitrary row of the shared table. */
const BRAND_ROWS = { sportsfc: 3, matchpulse: 4 };

module.exports = async (req, res) => {
  const ROW_ID = BRAND_ROWS[(req.query && req.query.brand) || "sportsfc"];
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
      /* ?since=<updatedAt the browser holds>: if the row is still that version, say so without sending the
         ~0.5 MB report again (Supabase's free plan counts every byte it sends — an open tab checks every minute) */
      const since = req.query && req.query.since;
      if (since) {
        const c = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=updated_at`, { headers: sbHeaders() });
        if (c.ok) {
          const rows = await c.json();
          const cur = Array.isArray(rows) && rows[0] ? rows[0].updated_at : null;
          const a = new Date(cur).getTime(), b = new Date(since).getTime();
          if (cur && Number.isFinite(a) && a === b) return res.status(200).json({ ok: true, mode: "cloud", configured: true, unchanged: true, updatedAt: cur });
        }
      }
      const r = await fetch(
        `${SB_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data,updated_at`,
        { headers: sbHeaders() }
      );
      if (!r.ok) throw new Error(`Supabase read failed (${r.status}): ${await r.text()}`);
      const rows = await r.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      return res.status(200).json({
        ok: true, mode: "cloud", configured: true,
        data: row ? row.data : null,
        updatedAt: row ? row.updated_at : null,
      });
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
      const serialized = JSON.stringify(body.data);
      if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
        return res.status(413).json({ ok: false, error: "Report is too large to store." });
      }

      /* optimistic concurrency, byte-for-byte the same instant comparison api/data.js uses:
         Postgres returns "…+00:00", Date#toISOString returns "…Z" — compare moments, not text. */
      if (body.baseUpdatedAt !== undefined && body.baseUpdatedAt) {
        const cur = await fetch(
          `${SB_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=updated_at`,
          { headers: sbHeaders() }
        );
        if (cur.ok) {
          const rows = await cur.json();
          const server = rows && rows[0] ? rows[0].updated_at : null;
          if (server) {
            const a = new Date(server).getTime(), b = new Date(body.baseUpdatedAt).getTime();
            if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
              return res.status(409).json({
                ok: false, conflict: true, updatedAt: server,
                error: "The report was updated on another device. Reload to get the latest.",
              });
            }
          }
        }
      }

      const now = new Date().toISOString();
      /* select=updated_at: the answer is the stored time only, not the whole report sent back */
      const w = await fetch(`${SB_URL}/rest/v1/${TABLE}?select=updated_at`, {
        method: "POST",
        headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=representation" }),
        body: JSON.stringify([{ id: ROW_ID, data: body.data, updated_at: now }]),
      });
      if (!w.ok) throw new Error(`Supabase write failed (${w.status}): ${await w.text()}`);

      let stored = now;
      try { const back = await w.json(); if (Array.isArray(back) && back[0] && back[0].updated_at) stored = back[0].updated_at; }
      catch (e) {}
      return res.status(200).json({ ok: true, mode: "cloud", saved: true, updatedAt: stored });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed." });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
