/* What went out TODAY on Facebook, Instagram and TikTok — read with the free readers only
   (plain fetch, no browser, no login, no Apify). "Today" is the Vietnam calendar day (UTC+7).
   Run:  node today.mjs [fb,ig,tt]                                                              */
import fs from "fs";
import path from "path";
import { postsFromJson, bodiesFromHtml, walk, tiktokIdTime } from "./extract.mjs";
import { postsFromEmbed } from "./exp5-ig-embed.mjs";

const LAB = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
const which = (process.argv[2] || "fb,ig,tt").split(",");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DOC = {
  "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1", "Upgrade-Insecure-Requests": "1",
  "sec-ch-ua": '"Chromium";v="140", "Google Chrome";v="140", "Not;A=Brand";v="99"',
  "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
};
const get = async u => { try { const r = await fetch(u, { headers: DOC }); return { status: r.status, html: await r.text() }; }
                         catch (e) { return { status: 0, html: "", error: String((e.cause && e.cause.code) || e.message) }; } };

const CHANNELS = [
  { id: "fb-vn",   p: "fb", name: "Facebook · sportsfc.vn",   lang: "VN", read: async () => postsFromJson("facebook", "sportsfc.vn", bodiesFromHtml((await get("https://www.facebook.com/sportsfc.vn/reels/")).html)) },
  { id: "fb-fans", p: "fb", name: "Facebook · Sportsfc.fans", lang: "EN", read: async () => postsFromJson("facebook", "Sportsfc.fans", bodiesFromHtml((await get("https://www.facebook.com/Sportsfc.fans/reels/")).html)) },
  { id: "ig-vn",   p: "ig", name: "Instagram · sportsfc.vn",  lang: "VN", read: async () => postsFromEmbed((await get("https://www.instagram.com/sportsfc.vn/embed/")).html, "sportsfc.vn") },
  { id: "ig-fans", p: "ig", name: "Instagram · sportsfc.fans",lang: "EN", read: async () => postsFromEmbed((await get("https://www.instagram.com/sportsfc.fans/embed/")).html, "sportsfc.fans") },
  { id: "tt-vn",   p: "tt", name: "TikTok · @sportsfc.vn",    lang: "VN", read: async () => {
      const r = await get("https://www.tiktok.com/embed/@sportsfc.vn");
      if (r.error) throw new Error(r.error);
      const descs = new Map();
      for (const b of bodiesFromHtml(r.html)) walk(b, o => { if (o.id && typeof o.desc === "string") descs.set(String(o.id), o.desc); });
      const ids = [...new Set([...r.html.matchAll(/\/@sportsfc\.vn\/video\/(\d{15,25})/gi)].map(m => m[1]))];
      return ids.map(id => ({ id, ts: tiktokIdTime(id), text: descs.get(id) || "", permalink: `https://www.tiktok.com/@sportsfc.vn/video/${id}` }));
  } },
];

/* the calendar day and clock to report in: TZ_HOURS=5.5 for India, default 7 (Vietnam) */
const TZH = Number(process.env.TZ_HOURS || 7);
const ICT = TZH * 3600e3;
const ZONE = TZH === 5.5 ? "IST" : TZH === 7 ? "ICT" : "UTC" + (TZH >= 0 ? "+" : "") + TZH;
const dayOf = ts => new Date(new Date(ts).getTime() + ICT).toISOString().slice(0, 10);
const today = dayOf(Date.now());
const out = { today, readAt: new Date().toISOString(), channels: {} };
for (const c of CHANNELS.filter(c => which.includes(c.p))) {
  let posts = [], error = null;
  try { posts = await c.read(); } catch (e) { error = String(e.message || e); }
  const todays = posts.filter(p => p.ts && dayOf(p.ts) === today).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  out.channels[c.id] = { name: c.name, lang: c.lang, error, readOk: !error && posts.length > 0, today: todays };
  console.log(`\n${c.name} (${c.lang}) — ${error ? "ERROR " + error : posts.length ? todays.length + " post(s) today" : "nothing read (blocked / restricted)"}`);
  for (const p of todays) {
    const t = new Date(new Date(p.ts).getTime() + ICT).toISOString().slice(11, 16);
    console.log(`  ${t} ${ZONE}  ${String(p.text || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 110)}`);
  }
}
fs.writeFileSync(path.join(LAB, "results", `${process.env.LAB_PREFIX || ""}today-${today}-${ZONE}.json`), JSON.stringify(out, null, 1));
