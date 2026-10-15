/**
 * POST /api/auth  { password }  → { ok, token, expiresAt }   sign in as admin (see admin-auth.js)
 * GET  /api/auth                → { ok, ready, admin }       is admin set up, and is this caller signed in
 *
 * Guessing is slowed down: every wrong password waits ~0.7 s, and an address that gets it wrong 8 times in
 * 15 minutes is refused until the window passes (per instance — with a long password that is plenty).
 * Same-origin only: no CORS headers, so no other site can call it from a browser.
 */
const auth = require("../admin-auth.js");

const WINDOW_MS = 15 * 60e3, MAX_FAILS = 8;
const fails = new Map();                  // ip → [failure times]
/* Vercel sets x-real-ip (and x-forwarded-for) to the caller's address itself — a client can't choose it */
const ipOf = req => String((req.headers && (req.headers["x-real-ip"] || req.headers["x-forwarded-for"])) || (req.socket && req.socket.remoteAddress) || "?").split(",")[0].trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "GET") return res.status(200).json({ ok: true, ready: auth.ready(), admin: auth.isAdmin(req) });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });
  /* JSON only: a plain-text or form POST is one any other website can make its visitors' browsers send
     (no preflight), which would let it guess passwords from their addresses */
  if (!/^application\/json\b/i.test(String((req.headers && req.headers["content-type"]) || ""))) return res.status(415).json({ ok: false, error: "Send JSON." });
  if (!auth.ready()) return res.status(503).json({ ok: false, error: "Admin is not set up on this deployment — set ADMIN_PASSWORD (10+ characters) on Vercel and redeploy." });

  const ip = ipOf(req), now = Date.now();
  const recent = (fails.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_FAILS) return res.status(429).json({ ok: false, error: "Too many wrong attempts — try again in 15 minutes." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const password = body && typeof body.password === "string" ? body.password : "";
  if (!auth.checkPassword(password)) {
    recent.push(now); fails.set(ip, recent);
    if (fails.size > 5000) for (const [k, v] of fails) if (!v.some(t => now - t < WINDOW_MS)) fails.delete(k);   // never grows without end
    await sleep(700);
    return res.status(401).json({ ok: false, error: "Wrong password." });
  }
  fails.delete(ip);
  const { token, expiresAt } = auth.issue(now);
  return res.status(200).json({ ok: true, token, expiresAt });
};
