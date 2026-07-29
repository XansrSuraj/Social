/**
 * POST /api/auth  { password }  ->  { ok:true } | 401
 *
 * The password never leaves the server as a value — only a yes/no comes back.
 * Compared in constant time so the response can't be used to guess it.
 */
const crypto = require("crypto");
const ADMIN = process.env.ADMIN_PASSWORD || "";

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });

  if (!ADMIN) {
    return res.status(503).json({
      ok: false, error: "ADMIN_PASSWORD is not set on this deployment yet.",
    });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const pw = body && body.password ? String(body.password) : "";

  if (!safeEqual(pw, ADMIN)) {
    return res.status(401).json({ ok: false, error: "Wrong password." });
  }
  return res.status(200).json({ ok: true });
};
