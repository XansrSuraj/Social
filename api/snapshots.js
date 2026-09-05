/**
 * GET /api/snapshots        -> [ { slot, day, updatedAt, orgs, channels } ]
 * GET /api/snapshots?slot=N -> { slot, updatedAt, data }   the full directory from that day
 *
 * The daily copies written by /api/keepalive. They live in the same table as the live
 * directory under ids 101-107, one per weekday, so the window rotates itself.
 *
 * Read-only, and public in the same way /api/data is: this is an internal directory whose
 * contents are already readable by anyone with the URL, so a copy of it from Tuesday is not a
 * new disclosure. Restoring one is a different matter and goes through PUT /api/data, which
 * still demands the admin password — nothing here can change anything.
 */
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const TABLE  = "orghub_state";
const SLOT_LO = 101, SLOT_HI = 107;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIMEOUT = 12000;

const headers = () => ({
  apikey: SB_KEY,
  Authorization: "Bearer " + SB_KEY,
  Accept: "application/json",
});

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed." });

  if (!SB_URL || !SB_KEY) {
    return res.status(200).json({ ok: true, configured: false, snapshots: [] });
  }

  const url = new URL(req.url, "http://x");
  const want = parseInt(url.searchParams.get("slot") || "", 10);
  const one = Number.isFinite(want);
  if (one && (want < SLOT_LO || want > SLOT_HI)) {
    return res.status(400).json({ ok: false, error: "No such snapshot slot." });
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    /* Listing asks for `data` too, because the only interesting thing about a snapshot is how
       much is in it — a row count alone cannot tell you whether Tuesday is the copy you want.
       Seven small directories is a cheap read, and the counting happens here rather than in the
       browser so the listing itself stays small. */
    const q = one
      ? `id=eq.${want}&select=id,data,updated_at`
      : `id=gte.${SLOT_LO}&id=lte.${SLOT_HI}&select=id,data,updated_at&order=id.asc`;

    const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?${q}`, { headers: headers(), signal: ctl.signal });
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Supabase read failed (${r.status})` });
    }
    const rows = await r.json();

    if (one) {
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return res.status(404).json({ ok: false, error: "That snapshot does not exist yet." });
      return res.status(200).json({
        ok: true, slot: row.id, updatedAt: row.updated_at, data: row.data,
      });
    }

    const snapshots = (Array.isArray(rows) ? rows : [])
      .map(row => {
        const d = row.data || {};
        const orgs = Array.isArray(d.orgs) ? d.orgs : [];
        return {
          slot: row.id,
          day: DAYS[row.id - SLOT_LO] || "",
          updatedAt: row.updated_at,
          orgs: orgs.length,
          channels: orgs.reduce((n, o) => n + ((o.socials || []).length), 0),
        };
      })
      .filter(x => x.orgs > 0)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));   // newest first

    return res.status(200).json({ ok: true, configured: true, snapshots });
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return res.status(504).json({
      ok: false,
      error: aborted ? `No answer within ${TIMEOUT}ms` : String((err && err.message) || err),
    });
  } finally {
    clearTimeout(timer);
  }
};
