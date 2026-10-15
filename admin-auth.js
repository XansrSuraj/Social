/**
 * Admin sessions — who may see and do the admin things (pipeline internals, FM Deliveries, Apify spend,
 * running a check, writing the shared report, test alerts, health and probes).
 *
 * One secret, set on Vercel only: ADMIN_PASSWORD (never in the code, never in chat). Signing in with it
 * (POST /api/auth) gives a session token — "admin.<expiry>.<HMAC>" signed with a key derived from the
 * password — valid 12 hours. Nothing is stored server-side; changing the password ends every session.
 * With no ADMIN_PASSWORD (or one under 10 characters) nobody is admin: every admin endpoint refuses
 * (fails closed) and the public site keeps working.
 *
 * The browser sends the token as  Authorization: Bearer <token>.
 */
const crypto = require("crypto");

const PASS = () => String(process.env.ADMIN_PASSWORD || "");
const ready = () => PASS().length >= 10;
const TTL_MS = 12 * 3600e3;
/* The signing key is stretched from the password with scrypt (a deliberately slow hash), once per instance:
   with a plain hash, anyone holding one old token could guess the password offline at GPU speed and skip the
   sign-in's rate limit (15 Oct 2026 review). Changing the password still ends every session. */
let keyMemo = { pass: null, key: null };
const signKey = () => {
  const p = PASS();
  if (keyMemo.pass !== p) keyMemo = { pass: p, key: crypto.scryptSync(p, "orghub-admin-session:v2", 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) };
  return keyMemo.key;
};
const sign = payload => crypto.createHmac("sha256", signKey()).update(payload).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

function issue(now = Date.now()) {
  const exp = now + TTL_MS;
  const payload = `admin.${exp}`;
  return { token: `${payload}.${sign(payload)}`, expiresAt: exp };
}

function verify(token, now = Date.now()) {
  if (!ready() || !token) return false;
  const m = String(token).match(/^admin\.(\d{13})\.([A-Za-z0-9_-]{20,})$/);
  if (!m) return false;
  if (Number(m[1]) < now) return false;
  return safeEqual(m[2], sign(`admin.${m[1]}`));
}

const tokenOf = req => {
  const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || "");
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : "";
};
const isAdmin = req => verify(tokenOf(req));
const checkPassword = pw => ready() && safeEqual(String(pw || ""), PASS());

/* the answer every admin endpoint gives a caller who isn't signed in */
function deny(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(ready() ? 401 : 503).json({ ok: false, admin: false,
    error: ready() ? "Admin sign-in required." : "Admin is not set up on this deployment (ADMIN_PASSWORD)." });
}

module.exports = { ready, issue, verify, isAdmin, checkPassword, deny, safeEqual, TTL_MS };
