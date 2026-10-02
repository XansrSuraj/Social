/* EXPERIMENT 8 — the candidate FREE server-side readers, as they would run in production: plain
   fetch(), no browser, no login, no paid service. Run several times in a row to measure how
   RELIABLE they are, not just whether they worked once.
     facebook  — facebook.com/<page>/reels/ with a browser's Sec-Fetch / client-hint headers;
                 the posts are JSON embedded in the HTML (creation_time, message.text, post_id)
     instagram — instagram.com/<user>/embed/ (the feed widget other sites embed); contextJSON
     tiktok    — tiktok.com/embed/@<user> (TikTok's creator widget); the /video/<id> links, each
                 id dated by its top 32 bits; any embedded JSON is searched for captions too
   Run:  node exp8-free-stack.mjs [rounds=5] [gapSeconds=150]                                    */
import fs from "fs";
import path from "path";
import { score, saveResult } from "./validate.mjs";
import { postsFromJson, bodiesFromHtml, walk, tiktokIdTime } from "./extract.mjs";
import { postsFromEmbed } from "./exp5-ig-embed.mjs";

const LAB = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
const ROUNDS = Number(process.argv[2]) || 5;
const GAP = (Number(process.argv[3]) || 150) * 1000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DOC = {
  "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1", "Upgrade-Insecure-Requests": "1",
  "sec-ch-ua": '"Chromium";v="140", "Google Chrome";v="140", "Not;A=Brand";v="99"',
  "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
};

async function get(url) {
  const t0 = Date.now();
  try { const r = await fetch(url, { headers: DOC, redirect: "follow" });
        return { status: r.status, html: await r.text(), ms: Date.now() - t0, finalUrl: r.url }; }
  catch (e) { return { status: 0, html: "", ms: Date.now() - t0, error: String((e.cause && e.cause.code) || e.message || e) }; }
}

const READERS = {
  "fb-vn":   async () => { const r = await get("https://www.facebook.com/sportsfc.vn/reels/"); return { r, posts: postsFromJson("facebook", "sportsfc.vn", bodiesFromHtml(r.html)) }; },
  "fb-fans": async () => { const r = await get("https://www.facebook.com/Sportsfc.fans/reels/"); return { r, posts: postsFromJson("facebook", "Sportsfc.fans", bodiesFromHtml(r.html)) }; },
  "ig-vn":   async () => { const r = await get("https://www.instagram.com/sportsfc.vn/embed/"); return { r, posts: postsFromEmbed(r.html, "sportsfc.vn") }; },
  "ig-fans": async () => { const r = await get("https://www.instagram.com/sportsfc.fans/embed/"); return { r, posts: postsFromEmbed(r.html, "sportsfc.fans") }; },
  "tt-vn":   async () => {
    const r = await get("https://www.tiktok.com/embed/@sportsfc.vn");
    /* captions, if the widget's own state carries them: any object with an id and a desc */
    const descs = new Map();
    for (const b of bodiesFromHtml(r.html)) walk(b, o => { if (o.id && typeof o.desc === "string") descs.set(String(o.id), o.desc); });
    const ids = [...new Set([...r.html.matchAll(/\/@sportsfc\.vn\/video\/(\d{15,25})/gi)].map(m => m[1]))];
    if (process.env.LAB_PREFIX && !fs.existsSync(path.join(LAB, "results", "gha-tiktok-embed.txt")))
      fs.writeFileSync(path.join(LAB, "results", "gha-tiktok-embed.txt"), r.html);          // kept once, to study
    return { r, posts: ids.map(id => ({ id, ts: tiktokIdTime(id), text: descs.get(id) || "" })).sort((a, b) => new Date(b.ts) - new Date(a.ts)), descs: descs.size };
  },
};

const rounds = [];
for (let i = 0; i < ROUNDS; i++) {
  if (i) await new Promise(r => setTimeout(r, GAP));
  const row = { at: new Date().toISOString(), channels: {} };
  for (const [ch, read] of Object.entries(READERS)) {
    const { r, posts, descs } = await read();
    const s = score(ch, posts);
    row.channels[ch] = { status: r.status, ms: r.ms, bytes: r.html.length, error: r.error, recall: s.recall,
                         pct: s.recallPct, times: s.exactTimes, captions: s.captions, returned: posts.length,
                         newest: posts[0] && posts[0].ts, ...(descs != null ? { captionObjects: descs } : {}),
                         ...(r.finalUrl && !r.finalUrl.includes(ch.split("-")[0] === "tt" ? "tiktok" : "") ? {} : {}) };
  }
  rounds.push(row);
  console.log(`\nround ${i + 1}/${ROUNDS} at ${row.at}`);
  for (const [ch, c] of Object.entries(row.channels))
    console.log(`  ${ch.padEnd(8)} HTTP ${String(c.status).padEnd(3)} ${String(c.ms).padStart(5)}ms  recall ${c.recall.padEnd(5)} (${String(c.pct).padStart(3)}%)  times ${c.times}  captions ${c.captions}${c.error ? "  ERROR " + c.error : ""}`);
}
console.log("\n── reliability over " + ROUNDS + " rounds · " + (process.env.LAB_PREFIX ? "GitHub Actions" : "this machine"));
for (const ch of Object.keys(READERS)) {
  const ok = rounds.filter(r => r.channels[ch].pct === 100).length;
  console.log(`  ${ch.padEnd(8)} full recall in ${ok}/${ROUNDS} rounds`);
}
console.log("\nsaved", saveResult("exp8-free-stack", { rounds }));
