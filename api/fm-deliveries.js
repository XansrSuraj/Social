/**
 * GET /api/fm-deliveries?env=dev|test|prod&<filters>
 *
 * Read-only proxy in front of the real FM Deliveries feed (docs: "FM Deliveries API — consumer
 * guide"). Exists so the dashboard's own x-api-key per environment stays server-side
 * (FM_DELIVERIES_API_KEY_DEV/TEST/PROD in fm-deliveries-client.js) instead of shipping to the
 * browser. Every filter the upstream accepts is passed through — nothing here defaults or validates
 * a value, so a 400 for a bad filter is the CMS's own message, not a guess of ours.
 *
 * One rename: `language` matches FM's fmLanguageKey, and FM files Portuguese as "portuguese-br" —
 * so `language=portuguese` (what every card's own `language` field says) found nothing at all
 * (9 Oct 2026). The everyday names are mapped to FM's keys; the key used is echoed in the
 * X-FM-Language header.
 *
 * GET only. There is no other method handler because this dashboard never writes anything.
 */
const { upstreamGet } = require("../fm-deliveries-client.js");
const auth = require("../admin-auth.js");

const PASSTHROUGH = [
  "since", "until", "timeField", "channel", "language", "state", "outcome",
  "cardId", "setId", "matchId", "attempts", "limit", "page",
];
const LANGUAGE_KEY = { portuguese: "portuguese-br", pt: "portuguese-br", "pt-br": "portuguese-br", brazilian: "portuguese-br",
                       en: "english", vi: "vietnamese", vn: "vietnamese" };
const fmLanguage = v => String(v).split(",").map(x => x.trim()).filter(Boolean)
  .map(x => LANGUAGE_KEY[x.toLowerCase()] || x).join(",");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET — this dashboard is read-only." });
  /* admin only (admin-auth.js) — same-origin, no CORS */
  if (!auth.isAdmin(req)) return auth.deny(res);


  const query = {};
  for (const k of PASSTHROUGH) {
    const v = req.query ? req.query[k] : undefined;
    if (v === undefined) continue;
    query[k] = Array.isArray(v) ? v.join(",") : v;
  }
  if (query.language) { query.language = fmLanguage(query.language); res.setHeader("X-FM-Language", query.language); }

  const { status, body } = await upstreamGet(req.query && req.query.env, "/api/fm-deliveries-feed", query);
  return res.status(status).json(body);
};
