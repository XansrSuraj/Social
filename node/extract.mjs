/* Shared extraction for every browser-based experiment (Crawlee, raw Playwright, …).
   The jugaad: a profile page fetches its own posts from the platform's internal API while it loads
   (GraphQL, item_list, web_profile_info). Those JSON answers carry exact times, ids and captions —
   so instead of scraping the rendered page, every JSON response is kept and walked for objects that
   look like this platform's posts. The DOM is only a fallback. */

const isObj = v => v && typeof v === "object";

export function walk(v, visit, depth = 0) {
  if (!isObj(v) || depth > 60) return;
  visit(v);
  if (Array.isArray(v)) { for (const x of v) walk(x, visit, depth + 1); return; }
  for (const k in v) walk(v[k], visit, depth + 1);
}

const iso = s => { const t = typeof s === "number" ? (s < 1e12 ? s * 1000 : s) : new Date(s).getTime(); return isFinite(t) && t > 0 ? new Date(t).toISOString() : null; };

/* one finder per platform: does this object look like one of OUR posts? */
export const FIND = {
  instagram: (o, handle) => {
    const code = o.code || o.shortcode;
    const t = o.taken_at || o.taken_at_timestamp;
    if (!code || !t || typeof code !== "string") return null;
    const owner = (o.user && o.user.username) || (o.owner && o.owner.username) || "";
    if (owner && owner.toLowerCase() !== handle.toLowerCase()) return null;
    const cap = (o.caption && (o.caption.text || o.caption)) ||
                (((o.edge_media_to_caption || {}).edges || [])[0] || {}).node?.text || "";
    return { id: code, ts: iso(t), text: typeof cap === "string" ? cap : "",
             permalink: `https://www.instagram.com/p/${code}/` };
  },
  facebook: (o) => {
    const t = o.creation_time || o.publish_time;
    if (typeof t !== "number") return null;
    const id = o.post_id || o.id || (o.video && o.video.id);
    if (!id) return null;
    const text = (o.message && o.message.text) || (o.comet_sections && o.comet_sections.message &&
                  o.comet_sections.message.story && o.comet_sections.message.story.message &&
                  o.comet_sections.message.story.message.text) || "";
    return { id: String(id), ts: iso(t), text, permalink: o.url || o.permalink_url || "" };
  },
  x: (o, handle) => {
    const lg = o.legacy;
    if (!o.rest_id || !lg || !lg.created_at || lg.full_text === undefined) return null;
    if (lg.retweeted_status_result || lg.in_reply_to_status_id_str) return null;
    const u = o.core && o.core.user_results && o.core.user_results.result;
    const sn = (u && ((u.legacy && u.legacy.screen_name) || (u.core && u.core.screen_name))) || "";
    if (sn && sn.toLowerCase() !== handle.toLowerCase()) return null;
    return { id: o.rest_id, ts: iso(lg.created_at), text: lg.full_text,
             permalink: `https://x.com/${handle}/status/${o.rest_id}` };
  },
  tiktok: (o, handle) => {
    if (!o.id || !o.createTime || o.desc === undefined) return null;
    const a = o.author && (o.author.uniqueId || o.author);
    if (typeof a === "string" && a.toLowerCase() !== handle.toLowerCase()) return null;
    return { id: String(o.id), ts: iso(Number(o.createTime)), text: o.desc,
             permalink: `https://www.tiktok.com/@${handle}/video/${o.id}` };
  },
};

/* collect posts out of every JSON body seen, de-duplicated by id, newest first */
export function postsFromJson(platform, handle, bodies) {
  const byId = new Map();
  for (const b of bodies) walk(b, o => {
    const p = FIND[platform](o, handle);
    if (p && p.ts && !byId.has(p.id)) byId.set(p.id, p);
    else if (p && p.ts && !byId.get(p.id).text && p.text) byId.set(p.id, p);
  });
  return [...byId.values()].sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

/* JSON can arrive as plain JSON, as several JSON objects one per line (Facebook), or with a
   "for (;;);" guard in front — try all three */
export function parseBodies(text) {
  const out = [];
  const t = String(text || "").replace(/^for \(;;\);/, "").trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return out;
  try { out.push(JSON.parse(t)); return out; } catch (e) { /* maybe NDJSON */ }
  for (const line of t.split(/\r?\n/)) { const l = line.trim(); if (l[0] === "{") try { out.push(JSON.parse(l)); } catch (e) {} }
  return out;
}

/* embedded JSON in the HTML itself: <script type="application/json">, Next/TikTok rehydration */
export function bodiesFromHtml(html) {
  const out = [];
  const re = /<script[^>]*type="application\/(?:json|ld\+json)"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) { try { out.push(JSON.parse(m[1])); } catch (e) {} }
  return out;
}

/* An X post id is a "snowflake": its top bits are milliseconds since X's epoch (2010-11-04), so
   the id alone gives the exact creation time — no <time> element or API answer needed. */
export const snowflakeTime = id => {
  try { return new Date(Number(BigInt(id) >> 22n) + 1288834974657).toISOString(); } catch (e) { return null; }
};

/* X's logged-out profile renders each post as an <article> with a /handle/status/<id> link and
   the text, but no <time> and no API call carrying it — read those, date them by the id. */
export async function xFromDom(page, handle) {
  const rows = await page.$$eval("article", (els, h) => els.map(a => {
    const re = new RegExp("^/" + h + "/status/(\\d{10,25})$", "i");
    const link = [...a.querySelectorAll("a")].map(x => x.getAttribute("href") || "").find(x => re.test(x));
    return link ? { id: link.match(re)[1], text: a.innerText } : null;
  }).filter(Boolean), handle);
  const seen = new Set();
  return rows.filter(r => !seen.has(r.id) && seen.add(r.id)).map(r => ({
    id: r.id, ts: snowflakeTime(r.id),
    /* drop the "Name / @handle / · / 4h or Oct 1" header lines the card starts with */
    text: (() => {
      const lines = r.text.split("\n").map(s => s.trim()).filter(Boolean);
      const i = lines.slice(0, 6).findIndex(s => /^(\d+[smhd]|[A-Z][a-z]{2} \d{1,2}(, \d{4})?)$/.test(s));
      return (i >= 0 ? lines.slice(i + 1) : lines).join("\n");
    })(),
    permalink: `https://x.com/${handle}/status/${r.id}`,
  })).sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

/* A TikTok video id carries its own creation time too: the top 32 bits are unix seconds. */
export const tiktokIdTime = id => {
  try { return new Date(Number(BigInt(id) >> 32n) * 1000).toISOString(); } catch (e) { return null; }
};

/* TikTok's profile grid: /@handle/video/<id> links with the caption in the link's alt/title text */
export async function ttFromDom(page, handle) {
  const rows = await page.$$eval('a[href*="/video/"]', (els, h) => els.map(a => {
    const m = (a.getAttribute("href") || "").match(new RegExp("/@" + h.replace(/\./g, "\\.") + "/video/(\\d{15,25})", "i"));
    const img = a.querySelector("img");
    return m ? { id: m[1], text: (img && img.getAttribute("alt")) || a.getAttribute("title") || "" } : null;
  }).filter(Boolean), handle);
  const seen = new Set();
  return rows.filter(r => !seen.has(r.id) && seen.add(r.id)).map(r => ({
    id: r.id, ts: tiktokIdTime(r.id), text: r.text, permalink: `https://www.tiktok.com/@${handle}/video/${r.id}`,
  })).sort((a, b) => new Date(b.ts) - new Date(a.ts));
}
