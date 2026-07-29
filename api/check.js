/**
 * POST /api/check  { urls: [ "https://…", … ] }
 *   -> [ { url, ok, status, ms, note } ]
 *
 * Runs server-side because the browser cannot check other domains (CORS).
 * HEAD first (cheap); some servers reject HEAD, so fall back to GET.
 */
const LIMIT = 40;
const TIMEOUT = 9000;
const UA = "Mozilla/5.0 (compatible; OrgHubLinkChecker/1.0; +https://github.com/)";

async function probe(url, method) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method,
      redirect: "follow",
      signal: ctl.signal,
      headers: { "User-Agent": UA, Accept: "*/*" },
    });
    return { status: r.status, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

async function check(url) {
  const t0 = Date.now();
  try {
    let r = await probe(url, "HEAD");
    // plenty of servers answer HEAD with 403/404/405 even when the page is fine
    if (r.status === 403 || r.status === 404 || r.status === 405 || r.status === 501) {
      try { r = await probe(url, "GET"); } catch (e) { /* keep the HEAD result */ }
    }
    const ok = r.status >= 200 && r.status < 400;
    return {
      url, ok, status: r.status, ms: r.ms,
      note: ok ? "" : (r.status === 403 ? "Blocked by the site (may still be live)" : "HTTP " + r.status),
    };
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || String(err).includes("aborted"));
    return {
      url, ok: false, status: 0, ms: Date.now() - t0,
      note: aborted ? "Timed out after 9s" : "Could not connect",
    };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }

  const urls = (body && Array.isArray(body.urls) ? body.urls : [])
    .map(u => String(u || "").trim())
    .filter(u => /^https?:\/\//i.test(u))
    .slice(0, LIMIT);

  if (!urls.length) return res.status(400).json({ ok: false, error: "Send { urls: [...] } with http(s) URLs." });

  const results = await Promise.all(urls.map(check));
  return res.status(200).json({ ok: true, checkedAt: new Date().toISOString(), results });
};
