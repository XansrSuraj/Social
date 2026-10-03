/* X read free through FxTwitter's public API, mapped to EXACTLY the post shape production's
 * xParseApify() returns (api/collect.js), so it could replace the Apify read as a drop-in — free
 * first, Apify only as the fallback, the same pattern Facebook/Instagram/TikTok already use.
 *
 *   node x-fx-reader.mjs [handle] [hours]      e.g. node x-fx-reader.mjs Sportsfcvn 48
 *
 * One GET to https://api.fxtwitter.com/2/profile/<handle>/statuses returns the newest 20 posts:
 * exact time (created_timestamp), full text with t.co links already expanded, views/likes/replies/
 * reposts/quotes/bookmarks, video length and thumbnail. `cursor.bottom` pages further back.
 * Retweets, replies and other authors' posts are dropped, as the production parser does.
 */
const handle = process.argv[2] || "Sportsfcvn";
const hours = Number(process.argv[3] || 72);

export async function xFxRead(handle, { hours = 72, maxPages = 3 } = {}) {
  const me = handle.toLowerCase(), cutoff = Date.now() - hours * 3600e3;
  const posts = [];
  let cursor = "", pages = 0;
  while (pages++ < maxPages) {
    const url = `https://api.fxtwitter.com/2/profile/${encodeURIComponent(handle)}/statuses` + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
    const r = await fetch(url, { headers: { "user-agent": "sportsfc-daily-check (+https://aiko-social-distribution-check.vercel.app)" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`FxTwitter HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== 200 || !Array.isArray(j.results)) throw new Error("FxTwitter: " + (j.message || "no results"));
    let older = false;
    for (const s of j.results) {
      const ms = (s.created_timestamp || 0) * 1000;
      if (!s.id || !isFinite(ms) || !ms) continue;
      if (ms < cutoff) { older = true; continue; }
      if (s.reposted_by || s.replying_to) continue;                       // a retweet / a reply
      if (String(s.author?.screen_name || me).toLowerCase() !== me) continue;
      const m0 = (s.media?.all || [])[0] || {};
      const facets = s.raw_text?.facets || [];
      posts.push({
        externalId: String(s.id), ts: new Date(ms).toISOString(),
        kind: /video|gif/.test(m0.type || "") ? "video" : m0.type ? "photo" : "text",
        text: String(s.text || ""),                                        // links already expanded
        views: s.views ?? null, likes: s.likes ?? null, comments: s.replies ?? null, reposts: s.reposts ?? null,
        quotes: s.quotes ?? null, saves: s.bookmarks ?? null,
        duration: m0.duration ? Math.round(m0.duration) : null,
        thumb: m0.thumbnail_url || (m0.type === "photo" ? m0.url : "") || "",
        link: (facets.find(f => f.type === "url") || {}).replacement || "",
        hashtags: facets.filter(f => f.type === "hashtag").map(f => f.original),
        author: s.author?.name || "", platformLang: s.lang || "",
        permalink: s.url || `https://x.com/${handle}/status/${s.id}`,
      });
    }
    cursor = j.cursor?.bottom;
    if (older || !cursor) break;
  }
  return posts.sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("x-fx-reader.mjs")) {
  const t0 = Date.now();
  const posts = await xFxRead(handle, { hours });
  const ist = iso => new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
  console.log(`@${handle}: ${posts.length} post(s) in the last ${hours} h — ${Date.now() - t0} ms, $0\n`);
  for (const p of posts)
    console.log(`${ist(p.ts)} IST  ${p.kind.padEnd(5)} ${String(p.duration ?? "—").padStart(3)}s  views ${String(p.views).padStart(4)}  ${p.link.padEnd(26)} ${p.text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 50)}`);
  const missing = ["externalId", "ts", "kind", "text", "views", "thumb", "permalink"].filter(k => posts.some(p => p[k] === undefined));
  console.log(`\nfields production needs, all present: ${missing.length ? "NO — " + missing : "yes"}`);
}
