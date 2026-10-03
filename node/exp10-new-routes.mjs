/* Round 5 — new free routes for what still leans on Apify (2026-10-04).
 *
 * Still on Apify: X (Sportsfcvn) always; Instagram sportsfc.fans (18+, which Apify cannot read either);
 * and Facebook / Instagram vn / TikTok whenever their one free route fails. This tries, keyless and
 * logged out, every route found in a fresh search:
 *
 *   X   · FxTwitter API v2 /2/profile/<handle>/statuses (FxEmbed, a public embed-fixing service)
 *       · X guest token + GraphQL UserTweets (what the web app calls before login)
 *       · Nitter / XCancel RSS (back after the August shutdown, per reports)
 *       · the syndication timeline widget (re-check; deprecated in round 2)
 *   IG  · sportsfc.fans (18+): the embed, the mobile-app API — expected to stay shut
 *       · sportsfc.vn second route: the mobile-app API (i.instagram.com) with the app's own headers
 *   FB  · the Page Plugin (plugins/page.php, timeline tab) and m.facebook.com — second routes
 *   TT  · tikwm user posts — a second route behind the embed
 *
 * Every route is scored the same way: did it answer, how many posts, does each carry a time, how
 * new is the newest. `node exp10-new-routes.mjs [rounds] [gapSeconds]` repeats to measure reliability.
 * Read-only, no credentials anywhere.
 */
import fs from "fs";

const ROUNDS = Number(process.argv[2] || 1), GAP = Number(process.argv[3] || 60) * 1000;
const PREFIX = process.env.LAB_PREFIX || "local-";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const NAV = { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en-US,en;q=0.9",
  "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "sec-fetch-user": "?1",
  "sec-ch-ua": '"Chromium";v="129", "Google Chrome";v="129", "Not=A?Brand";v="8"', "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, headers = {}, ms = 20000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(ms) });
    const body = await r.text();
    return { status: r.status, body, ms: Date.now() - t0, url: r.url };
  } catch (e) { return { status: 0, body: "", ms: Date.now() - t0, err: String(e.cause?.code || e.message) }; }
}
const ago = ts => ts ? Math.round((Date.now() - ts) / 3600e3 * 10) / 10 + " h" : "—";
/* a result: posts = [{ id, ts (ms), text }] */
const out = (status, posts, note = "") => {
  const withTs = posts.filter(p => p.ts && isFinite(p.ts));
  const newest = withTs.length ? Math.max(...withTs.map(p => p.ts)) : null;
  return { ok: posts.length > 0, status, n: posts.length, timed: withTs.length, newest: ago(newest), note,
           sample: posts.slice(0, 2).map(p => ({ t: p.ts ? new Date(p.ts).toISOString() : null, text: String(p.text || "").replace(/\s+/g, " ").slice(0, 70) })) };
};

/* ── X ──────────────────────────────────────────────────────────────────── */
async function xFx(handle) {
  const r = await get(`https://api.fxtwitter.com/2/profile/${handle}/statuses`, { "user-agent": UA });
  let j = null; try { j = JSON.parse(r.body); } catch (e) {}
  const res = (j && j.results) || [];
  return out(r.status, res.map(s => ({ id: s.id, ts: s.created_timestamp * 1000, text: s.text })),
    res[0] ? `views/likes/thumb: ${res[0].views}/${res[0].likes}/${!!(res[0].media?.all?.[0]?.thumbnail_url)}` : (r.err || r.body.slice(0, 120)));
}
async function xGuestGraphql(handle) {
  /* the public web-app bearer every logged-out x.com page ships with */
  const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const act = await fetch("https://api.x.com/1.1/guest/activate.json", { method: "POST", headers: { authorization: "Bearer " + decodeURIComponent(BEARER), "user-agent": UA }, signal: AbortSignal.timeout(15000) }).catch(e => ({ status: 0, json: async () => ({}) }));
  const tok = (await act.json().catch(() => ({}))).guest_token;
  if (!tok) return out(act.status || 0, [], "no guest token");
  const h = { authorization: "Bearer " + decodeURIComponent(BEARER), "x-guest-token": tok, "user-agent": UA, "content-type": "application/json" };
  const feats = encodeURIComponent(JSON.stringify({ hidden_profile_subscriptions_enabled: true, responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true }));
  const u = await get(`https://api.x.com/graphql/xmU6X_CKVnQ5lSrCbAmJsg/UserByScreenName?variables=${encodeURIComponent(JSON.stringify({ screen_name: handle }))}&features=${feats}`, h);
  let uid = null; try { uid = JSON.parse(u.body).data.user.result.rest_id; } catch (e) {}
  if (!uid) return out(u.status, [], "user lookup: " + u.body.slice(0, 100));
  const t = await get(`https://api.x.com/graphql/E3opETHurmVJflFsUBVuUQ/UserTweets?variables=${encodeURIComponent(JSON.stringify({ userId: uid, count: 20 }))}&features=${feats}`, h);
  const ids = [...t.body.matchAll(/"rest_id":"(\d{15,})"[^]*?"full_text":"((?:[^"\\]|\\.)*)"/g)].map(m => ({ id: m[1], ts: Number(BigInt(m[1]) >> 22n) + 1288834974657, text: m[2] }));
  return out(t.status, ids, `guest token ok, uid ${uid}; timeline ${t.status} ${t.body.length}B`);
}
async function xNitterRss(handle) {
  const tries = [["https://rss.xcancel.com/" + handle + "/rss", "FreshRSS/1.24.3 (Linux; https://freshrss.org)"],
                 ["https://xcancel.com/" + handle + "/rss", "Feedly/1.0 (+http://www.feedly.com/fetcher.html)"],
                 ["https://nitter.net/" + handle + "/rss", "Inoreader/1.0"],
                 ["https://nitter.poast.org/" + handle + "/rss", "FreshRSS/1.24.3 (Linux; https://freshrss.org)"],
                 ["https://nitter.privacyredirect.com/" + handle + "/rss", "FreshRSS/1.24.3 (Linux; https://freshrss.org)"]];
  const notes = [];
  for (const [url, ua] of tries) {
    const r = await get(url, { "user-agent": ua }, 15000);
    const items = [...r.body.matchAll(/<item>[^]*?<title>([^]*?)<\/title>[^]*?<pubDate>([^<]+)<\/pubDate>/g)]
      .map(m => ({ ts: Date.parse(m[2]), text: m[1] }));
    notes.push(new URL(url).host + ":" + (r.status || r.err));
    if (items.length) return out(r.status, items, url);
  }
  return out(0, [], notes.join(" "));
}
async function xSyndication(handle) {
  const r = await get(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}`, NAV);
  const m = r.body.match(/<script id="__NEXT_DATA__" type="application\/json">([^]*?)<\/script>/);
  let entries = []; try { entries = JSON.parse(m[1]).props.pageProps.timeline.entries || []; } catch (e) {}
  return out(r.status, entries.map(e => ({ ts: Date.parse(e.content?.tweet?.created_at), text: e.content?.tweet?.full_text })), m ? "" : "no __NEXT_DATA__");
}

/* ── Instagram ──────────────────────────────────────────────────────────── */
async function igEmbed(user) {
  const r = await get(`https://www.instagram.com/${user}/embed/`, NAV);
  const m = r.body.match(/"contextJSON":"((?:[^"\\]|\\.)*)"/);
  let posts = [];
  try { const ctx = JSON.parse(JSON.parse('"' + m[1] + '"'));
        posts = (ctx.context?.graphql_media || []).map(x => x.shortcode_media || x).map(s => ({ ts: (s.taken_at_timestamp || 0) * 1000, text: s.edge_media_to_caption?.edges?.[0]?.node?.text })); } catch (e) {}
  return out(r.status, posts, m ? "" : /age|restricted|log in/i.test(r.body) ? "age/login wall" : "no contextJSON");
}
async function igMobileApi(user) {
  const r = await get(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${user}`,
    { "user-agent": "Instagram 300.0.0.0.0 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 517986707)", "x-ig-app-id": "936619743392459", accept: "*/*" });
  let edges = []; try { edges = JSON.parse(r.body).data.user.edge_owner_to_timeline_media.edges; } catch (e) {}
  return out(r.status, edges.map(e => ({ ts: e.node.taken_at_timestamp * 1000, text: e.node.edge_media_to_caption?.edges?.[0]?.node?.text })), edges.length ? "" : r.body.slice(0, 90).replace(/\s+/g, " "));
}

/* ── Facebook (second routes behind /reels/) ───────────────────────────── */
async function fbPlugin(page) {
  const r = await get(`https://www.facebook.com/plugins/page.php?href=${encodeURIComponent("https://www.facebook.com/" + page)}&tabs=timeline&width=500&height=2000&small_header=true&hide_cover=true`, NAV);
  const times = [...r.body.matchAll(/data-utime="(\d{9,})"/g)].map(m => ({ ts: Number(m[1]) * 1000, text: "" }));
  const texts = [...r.body.matchAll(/<div class="[^"]*userContent[^"]*"[^>]*>([^]*?)<\/div>/g)].length;
  return out(r.status, times, `${r.body.length}B, ${texts} text blocks${/login|log in/i.test(r.body.slice(0, 3000)) ? ", login prompt" : ""}`);
}
async function fbMobile(page) {
  const r = await get(`https://m.facebook.com/${page}/`, { ...NAV, "user-agent": "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36" });
  const times = [...r.body.matchAll(/"publish_time":(\d{9,})/g)].map(m => ({ ts: Number(m[1]) * 1000, text: "" }));
  return out(r.status, times, `${r.body.length}B${/login/i.test(r.url || "") ? ", redirected to login" : ""}`);
}

/* ── TikTok (second route behind the embed) ────────────────────────────── */
async function ttTikwm(user) {
  const r = await get(`https://www.tikwm.com/api/user/posts?unique_id=${user}&count=10`, { "user-agent": UA, accept: "application/json" });
  let v = []; try { v = JSON.parse(r.body).data.videos || []; } catch (e) {}
  return out(r.status, v.map(x => ({ ts: x.create_time * 1000, text: x.title })), v.length ? "" : r.body.slice(0, 90).replace(/\s+/g, " "));
}

const ROUTES = [
  ["X · FxTwitter v2 statuses · Sportsfcvn", () => xFx("Sportsfcvn")],
  ["X · guest token + GraphQL UserTweets", () => xGuestGraphql("Sportsfcvn")],
  ["X · Nitter / XCancel RSS", () => xNitterRss("Sportsfcvn")],
  ["X · syndication timeline widget", () => xSyndication("Sportsfcvn")],
  ["IG 18+ · sportsfc.fans embed", () => igEmbed("sportsfc.fans")],
  ["IG 18+ · sportsfc.fans mobile API", () => igMobileApi("sportsfc.fans")],
  ["IG vn · mobile API (2nd route)", () => igMobileApi("sportsfc.vn")],
  ["FB vn · Page Plugin (2nd route)", () => fbPlugin("sportsfc.vn")],
  ["FB vn · m.facebook.com (2nd route)", () => fbMobile("sportsfc.vn")],
  ["TT vn · tikwm (2nd route)", () => ttTikwm("sportsfc.vn")],
];

const all = [];
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`\n══ round ${round}/${ROUNDS}  ${new Date().toISOString()}`);
  for (const [name, fn] of ROUTES) {
    let r; try { r = await fn(); } catch (e) { r = out(0, [], "threw: " + e.message); }
    all.push({ round, name, ...r });
    console.log(`${r.ok ? "✅" : "❌"} ${name.padEnd(40)} HTTP ${String(r.status).padEnd(3)} posts ${String(r.n).padStart(2)} timed ${String(r.timed).padStart(2)} newest ${String(r.newest).padStart(7)}  ${r.note}`);
    if (r.ok && round === 1) for (const s of r.sample) console.log(`      ${s.t}  ${s.text}`);
  }
  if (round < ROUNDS) await sleep(GAP);
}

console.log("\n══ reliability");
for (const [name] of ROUTES) {
  const rs = all.filter(x => x.name === name);
  console.log(`${String(rs.filter(x => x.ok).length + "/" + rs.length).padStart(5)}  ${name}`);
}
fs.mkdirSync("../results", { recursive: true });
fs.writeFileSync(`../results/${PREFIX}exp10.json`, JSON.stringify({ at: new Date().toISOString(), rounds: ROUNDS, results: all }, null, 1));
