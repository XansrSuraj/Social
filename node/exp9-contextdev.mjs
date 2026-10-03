/* EXPERIMENT 9 — context.dev (a scraping API: real browser + "stealth proxies", returns the page's
   HTML). Can it read the two channels that still need Apify — X, and the 18+ Instagram account —
   for free (1,000 credits a month on a work-email account, 1 credit per page)?

   Needs CONTEXT_DEV_API_KEY in free-scraper-lab/.env (gitignored — never paste it in chat).
   Optional IG_COOKIE in the same .env: a logged-in ADULT Instagram session's Cookie header, to test
   whether the 18+ wall opens with it. Leave it out to test logged-out only.

   Every page costs 1 credit; this script reads 8 pages at most (≈8 credits).
   Run:  node exp9-contextdev.mjs            (from free-scraper-lab/node)                        */
import fs from "fs";
import path from "path";
import { saveResult } from "./validate.mjs";
import { postsFromJson, bodiesFromHtml, walk, snowflakeTime, tiktokIdTime } from "./extract.mjs";
import { postsFromEmbed } from "./exp5-ig-embed.mjs";

const LAB = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
/* a minimal .env reader — KEY=value lines, nothing else */
const envFile = path.join(LAB, ".env");
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const KEY = process.env.CONTEXT_DEV_API_KEY;
if (!KEY) { console.log("CONTEXT_DEV_API_KEY is not set — add it to free-scraper-lab/.env (see the header)."); process.exit(1); }

async function scrape(url, extra) {
  const t0 = Date.now();
  const body = { url, formats: { html: true }, maxAgeMs: 0,
    sharedParams: { waitFor: 6000, ...(extra || {}) }, timeoutOpts: { milliseconds: 90000, behavior: "return-partial" } };
  const r = await fetch("https://api.context.dev/v1/web/scrape", { method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, ms: Date.now() - t0, html: (j.html && j.html.data) || "", ok: j.html && j.html.success,
           err: j.message || (j.html && j.html.message) || "", finalUrl: j.url || (j.metadata && j.metadata.finalUrl) || "",
           credits: j.key_metadata || null, title: (j.metadata && j.metadata.title) || "" };
}

const xFromHtml = (html, handle) => {
  const ids = [...new Set([...html.matchAll(new RegExp("/" + handle + "/status/(\\d{15,25})", "gi"))].map(m => m[1]))];
  return ids.map(id => ({ id, ts: snowflakeTime(id), text: "" })).sort((a, b) => new Date(b.ts) - new Date(a.ts));
};
const igFromHtml = (html, user) => {
  const fromEmbed = postsFromEmbed(html, user);
  if (fromEmbed.length) return fromEmbed;
  return postsFromJson("instagram", user, bodiesFromHtml(html));
};
const ist = ts => ts ? new Date(new Date(ts).getTime() + 5.5 * 3600e3).toISOString().slice(5, 16).replace("T", " ") + " IST" : "—";

const cookie = process.env.IG_COOKIE ? { headers: { Cookie: process.env.IG_COOKIE } } : null;
const TESTS = [
  { name: "X · Sportsfcvn (profile)",                url: "https://x.com/Sportsfcvn", parse: h => xFromHtml(h, "Sportsfcvn") },
  { name: "Instagram · sportsfc.fans (profile, logged out)", url: "https://www.instagram.com/sportsfc.fans/", parse: h => igFromHtml(h, "sportsfc.fans") },
  { name: "Instagram · sportsfc.fans (embed, logged out)",   url: "https://www.instagram.com/sportsfc.fans/embed/", parse: h => igFromHtml(h, "sportsfc.fans") },
  ...(cookie ? [
    { name: "Instagram · sportsfc.fans (profile, WITH session cookie)", url: "https://www.instagram.com/sportsfc.fans/", extra: cookie, parse: h => igFromHtml(h, "sportsfc.fans") },
    { name: "Instagram · sportsfc.fans (embed, WITH session cookie)",   url: "https://www.instagram.com/sportsfc.fans/embed/", extra: cookie, parse: h => igFromHtml(h, "sportsfc.fans") },
  ] : []),
  /* controls: accounts the free readers already handle — proves the method itself works */
  { name: "control · Instagram sportsfc.vn (profile)", url: "https://www.instagram.com/sportsfc.vn/", parse: h => igFromHtml(h, "sportsfc.vn") },
  { name: "control · TikTok @sportsfc.vn (profile)",   url: "https://www.tiktok.com/@sportsfc.vn", parse: h => {
      const ids = [...new Set([...h.matchAll(/\/@sportsfc\.vn\/video\/(\d{15,25})/gi)].map(m => m[1]))];
      return ids.map(id => ({ id, ts: tiktokIdTime(id), text: "" })).sort((a, b) => new Date(b.ts) - new Date(a.ts)); } },
];

const out = [];
for (const t of TESTS) {
  const r = await scrape(t.url, t.extra);
  const posts = r.html ? t.parse(r.html) : [];
  const restricted = /restricted profile|must be 18|18 years old/i.test(r.html);
  const loginWall = /accounts\/login|log in to continue|sign in to x|Log in to Instagram/i.test(r.html) && !posts.length;
  out.push({ name: t.name, http: r.http, ms: r.ms, bytes: r.html.length, posts, restricted, loginWall, err: r.err,
             finalUrl: r.finalUrl, title: r.title, credits: r.credits });
  console.log(`\n${t.name}\n  HTTP ${r.http} · ${r.ms} ms · ${r.html.length} bytes · ${posts.length} post(s)` +
    `${restricted ? " · 18+ WALL" : ""}${loginWall ? " · LOGIN WALL" : ""}${r.err ? " · " + r.err.slice(0, 120) : ""}` +
    `${r.credits ? ` · credits used ${r.credits.credits_consumed}, left ${r.credits.credits_remaining}` : ""}`);
  for (const p of posts.slice(0, 6)) console.log(`    ${ist(p.ts)}  ${p.id}  ${JSON.stringify(String(p.text || "").replace(/\s+/g, " ").slice(0, 50))}`);
}
console.log("\nsaved", saveResult("exp9-contextdev", { tests: out.map(o => ({ ...o, cookieUsed: /WITH session/.test(o.name) })) }));
