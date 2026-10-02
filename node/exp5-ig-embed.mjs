/* EXPERIMENT 5 (jugaad) — Instagram's profile EMBED page, plain HTTP, no browser, no login.
   instagram.com/<user>/embed/ is the widget other websites use to show a feed, so it is served to
   anyone. It carries the recent posts as a JSON string (contextJSON) with shortcode,
   taken_at_timestamp and caption. Run:  node exp5-ig-embed.mjs [user,user]                 */
import { score, saveResult, table } from "./validate.mjs";
import { walk } from "./extract.mjs";

const USERS = (process.argv[2] || "sportsfc.vn,sportsfc.fans").split(",");
const CH = { "sportsfc.vn": "ig-vn", "sportsfc.fans": "ig-fans" };
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none",
};

export function postsFromEmbed(html, user) {
  const posts = [], seen = new Set();
  const visit = o => {
    if (!o.shortcode || !o.taken_at_timestamp || seen.has(o.shortcode)) return;
    const owner = (o.owner && o.owner.username) || "";
    if (owner && owner.toLowerCase() !== user.toLowerCase()) return;
    seen.add(o.shortcode);
    const cap = (((o.edge_media_to_caption || {}).edges || [])[0] || {}).node;
    posts.push({ id: o.shortcode, ts: new Date(o.taken_at_timestamp * 1000).toISOString(),
                 text: (cap && cap.text) || "", kind: o.__typename, views: o.video_view_count ?? null,
                 thumb: o.display_url || o.thumbnail_src || "", permalink: `https://www.instagram.com/p/${o.shortcode}/` });
  };
  /* the data sits in a JSON string inside the page: "contextJSON":"{\"context\":…}" */
  const m = html.match(/"contextJSON":"((?:[^"\\]|\\.)*)"/);
  if (m) { try { walk(JSON.parse(JSON.parse('"' + m[1] + '"')), visit); } catch (e) {} }
  /* any other inline JSON blobs, in case the field moves */
  for (const s of html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { walk(JSON.parse(s[1]), visit); } catch (e) {}
  }
  return posts.sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("exp5-ig-embed.mjs")) {
  const notes = {};
  for (const u of USERS) {
    try {
      const r = await fetch(`https://www.instagram.com/${u}/embed/`, { headers: HEADERS });
      const html = await r.text();
      notes[CH[u] || u] = { status: r.status, bytes: html.length, posts: postsFromEmbed(html, u),
        restricted: /restricted|must be 18/i.test(html) };
    } catch (e) { notes[CH[u] || u] = { error: String(e.message || e), posts: [] }; }
  }
  console.log("\n── 5 Instagram profile embed · plain HTTP · " + (process.env.LAB_PREFIX ? "GitHub Actions" : "this machine"));
  table(Object.keys(notes).map(c => score(c, notes[c].posts)));
  for (const [c, n] of Object.entries(notes)) {
    console.log(`     ${c}: ${n.error || `HTTP ${n.status}, ${n.bytes} bytes${n.restricted ? ", RESTRICTED notice" : ""}`}`);
    for (const p of (n.posts || []).slice(0, 7)) console.log(`        ${p.ts} ${p.id} ${p.kind} views=${p.views} ${JSON.stringify(p.text.replace(/\s+/g, " ").slice(0, 50))}`);
  }
  console.log("\nsaved", saveResult("exp5-ig-embed", { embed: notes }));
}
