/* EXPERIMENT 6 — TikTok, every free route, each scored on its own:
     A  profile page, plain HTTP — its embedded rehydration JSON (account stats, itemList)
     B  profile page in real Chrome — every JSON answer listed (item_list?), then the grid's
        /video/<id> links dated by the id; a screenshot is kept
     C  TikTok's creator EMBED page (the widget other sites use), plain HTTP and in Chrome
     D  tikwm.com, a free public mirror of TikTok's post list, opened in real Chrome so its
        Cloudflare check can run (plain HTTP gets "Just a moment…")
   Run:  node exp6-tiktok.mjs [A,B,C,D]                                                        */
import path from "path";
import { chromium } from "playwright";
import { score, saveResult, table } from "./validate.mjs";
import { postsFromJson, parseBodies, walk, ttFromDom, tiktokIdTime } from "./extract.mjs";

const LAB = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
const H = "sportsfc.vn";
const parts = (process.argv[2] || "A,B,C,D").split(",");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DOC = { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9",
              "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" };
const out = {};
const idsIn = html => [...new Set([...String(html).matchAll(/\/@sportsfc\.vn\/video\/(\d{15,25})/gi)].map(m => m[1]))]
  .map(id => ({ id, ts: tiktokIdTime(id), text: "", permalink: `https://www.tiktok.com/@${H}/video/${id}` }));
const rehydration = html => { const m = String(html).match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  try { return m ? JSON.parse(m[1]) : null; } catch (e) { return null; } };

async function plain(url) {
  try { const r = await fetch(url, { headers: DOC }); return { status: r.status, html: await r.text() }; }
  catch (e) { return { status: 0, html: "", error: String(e.cause && e.cause.code || e.message || e) }; }
}

if (parts.includes("A")) {
  const r = await plain(`https://www.tiktok.com/@${H}`);
  const data = rehydration(r.html);
  const det = data && data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__["webapp.user-detail"];
  const posts = postsFromJson("tiktok", H, data ? [data] : []);
  out.A = { status: r.status, error: r.error, statusCode: det && det.statusCode,
            videoCount: det && det.userInfo && det.userInfo.stats && det.userInfo.stats.videoCount,
            itemList: det && Array.isArray(det.itemList) ? det.itemList.length : null, posts };
}

let browser;
if (parts.some(p => ["B", "C", "D"].includes(p))) {
  browser = await chromium.launch({ headless: true, channel: process.env.LAB_BROWSER || "chrome",
                                    args: ["--disable-blink-features=AutomationControlled"] });
}
async function inChrome(url, label, waitMs = 8000) {
  const ctx = await browser.newContext({ userAgent: UA, locale: "en-US", viewport: { width: 1280, height: 1600 } });
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const page = await ctx.newPage();
  const json = [], calls = [];
  page.on("response", async res => {
    const ct = String(res.headers()["content-type"] || "");
    if (!/json/.test(ct)) return;
    let n = 0, keys = "";
    try { const bodies = parseBodies(await res.text()); json.push(...bodies);
          for (const b of bodies) { keys = Object.keys(b).slice(0, 5).join(","); walk(b, o => { if (o.createTime && o.id) n++; }); } } catch (e) {}
    if (/tiktok|tikwm/.test(res.url())) calls.push({ s: res.status(), u: res.url().replace(/\?.*/, "").slice(0, 90), items: n, keys });
  });
  const note = {};
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(waitMs);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 2000); await page.waitForTimeout(1500); }
    const html = await page.content();
    note.finalUrl = page.url();
    note.text = (await page.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 220).replace(/\s+/g, " ");
    note.calls = calls.filter(c => c.items || /item_list|post|user/.test(c.u)).slice(0, 15);
    let posts = postsFromJson("tiktok", H, json);
    if (!posts.length) posts = await ttFromDom(page, H);
    if (!posts.length) posts = idsIn(html);
    note.posts = posts;
    await page.screenshot({ path: path.join(LAB, "results", `${process.env.LAB_PREFIX || ""}exp6-${label}.png`) }).catch(() => {});
    note.raw = (await page.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 600);
  } catch (e) { note.error = String(e.message || e).split("\n")[0].slice(0, 160); note.posts = []; }
  await ctx.close();
  return note;
}

if (parts.includes("B")) out.B = await inChrome(`https://www.tiktok.com/@${H}`, "profile", 9000);
if (parts.includes("C")) {
  const r = await plain(`https://www.tiktok.com/embed/@${H}`);
  out.C_plain = { status: r.status, error: r.error, bytes: r.html.length, posts: idsIn(r.html) };
  out.C_chrome = await inChrome(`https://www.tiktok.com/embed/@${H}`, "embed", 6000);
}
if (parts.includes("D")) {
  const d = await inChrome(`https://www.tikwm.com/api/user/posts?unique_id=${H}&count=12&cursor=0`, "tikwm", 12000);
  /* tikwm answers JSON: { code:0, data:{ videos:[ { video_id, title, create_time, play_count } ] } } */
  try {
    const j = JSON.parse(d.raw || "{}");
    d.tikwmCode = j.code; d.tikwmMsg = j.msg;
    d.posts = ((j.data && j.data.videos) || []).map(v => ({ id: String(v.video_id || v.aweme_id),
      ts: new Date(v.create_time * 1000).toISOString(), text: v.title || "", views: v.play_count }));
  } catch (e) { d.tikwmParse = "not JSON: " + String(d.raw || "").slice(0, 80); }
  out.D = d;
}
if (browser) await browser.close();

console.log("\n── 6 TikTok routes · " + (process.env.LAB_PREFIX ? "GitHub Actions" : "this machine"));
for (const [k, n] of Object.entries(out)) {
  const s = score("tt-vn", n.posts);
  console.log(`  ${k.padEnd(9)} recall ${s.recall} (${s.recallPct}%) times ${s.exactTimes} captions ${s.captions} | ` +
    (n.error ? "ERROR " + n.error : k === "A" ? `HTTP ${n.status} statusCode=${n.statusCode} videoCount=${n.videoCount} itemList=${n.itemList}`
      : k === "C_plain" ? `HTTP ${n.status} ${n.bytes}B` : k === "D" ? `tikwm code=${n.tikwmCode} ${n.tikwmMsg || n.tikwmParse || ""}` : `ended ${n.finalUrl}`));
  if (n.calls && n.calls.length) for (const c of n.calls) console.log(`              ${c.s} ${c.items ? "[" + c.items + " items] " : ""}${c.u} ${c.keys}`);
  if (n.text && !(n.posts || []).length) console.log(`              page said: "${n.text}"`);
}
console.log("\nsaved", saveResult("exp6-tiktok", out));
