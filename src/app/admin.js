/* The admin session in this browser: the token /api/auth hands out (admin-auth.js), kept in localStorage
   until it expires (12 h). Every admin call sends it as "Authorization: Bearer …"; the server checks it —
   nothing here decides who is admin, it only remembers the token. */
const KEY = "orghub.admin";

export function adminToken() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && s.token && s.expiresAt > Date.now()) return s.token;
  } catch (e) { /* storage blocked — not signed in */ }
  return "";
}
/* when this browser's session ends (0 = none) */
export function adminExpiry() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); return s && s.token && s.expiresAt ? Number(s.expiresAt) : 0; }
  catch (e) { return 0; }
}
export const authHeaders = () => { const t = adminToken(); return t ? { Authorization: "Bearer " + t } : {}; };
export const authFetch = (url, opts = {}) => fetch(url, { cache: "no-store", ...opts, headers: { ...(opts.headers || {}), ...authHeaders() } });

export function forget() { try { localStorage.removeItem(KEY); } catch (e) {} }

export async function signIn(password) {
  const r = await fetch("api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(j.error || `HTTP ${r.status}`);
  try { localStorage.setItem(KEY, JSON.stringify({ token: j.token, expiresAt: j.expiresAt })); } catch (e) {}
  return true;
}

/* { ready: is admin set up on the server, admin: is this browser signed in } */
export async function authState() {
  try {
    const r = await authFetch("api/auth");
    const j = await r.json();
    if (adminToken() && !j.admin) forget();          // expired, or the password changed
    return { ready: !!j.ready, admin: !!j.admin };
  } catch (e) { return { ready: false, admin: !!adminToken() }; }
}
