/* EXPERIMENT 1 — Crawlee (Apify's own open-source scraping library, free to run anywhere).
     1A  CheerioCrawler   — plain HTTP + HTML parsing, no browser (what Scrapy also does)
     1B  PlaywrightCrawler — a real headless Chromium with Crawlee's browser fingerprints; every
                             JSON answer the page fetches is captured and walked for posts
                             (extract.mjs); Instagram/Facebook fall back to opening each post.
   Logged out. Run:  node exp1-crawlee.mjs [cheerio|browser|both]   (from free-scraper-lab/node) */
import { CheerioCrawler, PlaywrightCrawler, Configuration, log } from "crawlee";
import { score, saveResult, table } from "./validate.mjs";
import { postsFromJson, parseBodies, bodiesFromHtml, xFromDom, ttFromDom } from "./extract.mjs";

log.setLevel(log.LEVELS.WARNING);
Configuration.getGlobalConfig().set("persistStorage", false);

const TARGETS = [
  { channel: "ig-vn",   platform: "instagram", handle: "sportsfc.vn",   url: "https://www.instagram.com/sportsfc.vn/" },
  { channel: "ig-fans", platform: "instagram", handle: "sportsfc.fans", url: "https://www.instagram.com/sportsfc.fans/" },
  { channel: "fb-vn",   platform: "facebook",  handle: "sportsfc.vn",   url: "https://www.facebook.com/sportsfc.vn/reels/" },
  { channel: "fb-fans", platform: "facebook",  handle: "Sportsfc.fans", url: "https://www.facebook.com/Sportsfc.fans/reels/" },
  { channel: "x-vn",    platform: "x",         handle: "Sportsfcvn",    url: "https://x.com/Sportsfcvn" },
  { channel: "tt-vn",   platform: "tiktok",    handle: "sportsfc.vn",   url: "https://www.tiktok.com/@sportsfc.vn" },
];
const mode = process.argv[2] || "both";
/* optional: only these channels, e.g.  node exp1-crawlee.mjs browser x-vn,ig-vn */
const ONLY = (process.argv[3] || "").split(",").filter(Boolean);
if (ONLY.length) TARGETS.splice(0, TARGETS.length, ...TARGETS.filter(t => ONLY.includes(t.channel)));
const out = {};

/* ── 1A: HTTP only ── */
if (mode === "cheerio" || mode === "both") {
  const notes = {};
  const crawler = new CheerioCrawler({
    maxRequestRetries: 1, requestHandlerTimeoutSecs: 30, navigationTimeoutSecs: 25,
    additionalMimeTypes: ["application/json"],
    async requestHandler({ request, body, response }) {
      const t = request.userData;
      const html = String(body);
      const posts = postsFromJson(t.platform, t.handle, bodiesFromHtml(html));
      notes[t.channel] = { status: response.statusCode, bytes: html.length, posts,
        loginWall: /login|log in|đăng nhập/i.test(html.slice(0, 50000)) && !posts.length };
    },
    failedRequestHandler({ request }, err) {
      notes[request.userData.channel] = { error: String(err.message || err).slice(0, 160), posts: [] };
    },
  });
  await crawler.run(TARGETS.map(t => ({ url: t.url, userData: t, uniqueKey: "c:" + t.channel })));
  console.log("\n── 1A  Crawlee CheerioCrawler (HTTP only, logged out, this machine)");
  table(TARGETS.map(t => ({ ...score(t.channel, (notes[t.channel] || {}).posts), note: notes[t.channel] })));
  for (const t of TARGETS) { const n = notes[t.channel] || {}; console.log(`     ${t.channel}: ${n.error || `HTTP ${n.status}, ${n.bytes} bytes${n.loginWall ? ", login wall text" : ""}`}`); }
  out.cheerio = notes;
}

/* ── 1B: real browser, network capture ── */
if (mode === "browser" || mode === "both") {
  const notes = {};
  const crawler = new PlaywrightCrawler({
    maxConcurrency: 2, maxRequestRetries: 0, requestHandlerTimeoutSecs: 150, navigationTimeoutSecs: 45,
    launchContext: { launchOptions: { headless: true } },
    browserPoolOptions: { useFingerprints: true },
    preNavigationHooks: [async ({ page, request }) => {
      request.userData.bodies = [];
      page.on("response", async res => {
        const ct = String(res.headers()["content-type"] || "");
        if (!/json|javascript|text\/html/.test(ct) && !/graphql|api\//.test(res.url())) return;
        try { const txt = await res.text(); for (const b of parseBodies(txt)) request.userData.bodies.push(b); } catch (e) {}
      });
    }],
    async requestHandler({ page, request }) {
      const t = request.userData;
      const note = { finalUrl: "", via: "network", posts: [] };
      await page.waitForTimeout(5000);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(1500); }
      note.finalUrl = page.url();
      const html = await page.content();
      note.loginWall = /\/login|checkpoint|accounts\/login/.test(note.finalUrl);
      note.bodyText = (await page.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
      let posts = postsFromJson(t.platform, t.handle, [...t.bodies, ...bodiesFromHtml(html)]);

      /* X: the logged-out profile renders posts with no API call behind them — read the DOM */
      if (!posts.length && t.platform === "x") { posts = await xFromDom(page, t.handle); note.via = "dom + snowflake"; }
      if (!posts.length && t.platform === "tiktok") { posts = await ttFromDom(page, t.handle); note.via = "dom + video-id time"; }

      /* DOM fallback: open each post's own page (Instagram / Facebook render the time there) */
      if (!posts.length && (t.platform === "instagram" || t.platform === "facebook")) {
        const sel = t.platform === "instagram" ? 'a[href*="/p/"], a[href*="/reel/"]' : 'a[href*="/reel/"]';
        const hrefs = [...new Set(await page.$$eval(sel, els => els.map(e => e.href.split("?")[0])))].slice(0, 6);
        note.gridLinks = hrefs.length;
        note.via = "permalinks";
        for (const href of hrefs) {
          try {
            await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30000 });
            await page.waitForTimeout(2500);
            const h = await page.content();
            let ts = null, text = "";
            if (t.platform === "instagram") {
              ts = await page.$eval("time", el => el.getAttribute("datetime")).catch(() => null);
              text = await page.$eval('meta[property="og:description"]', el => el.content).catch(() => "");
            } else {
              const ct = (h.match(/"creation_time":(\d{10})/) || h.match(/"publish_time":(\d{10})/) || [])[1];
              ts = ct ? new Date(Number(ct) * 1000).toISOString() : null;
              text = await page.$eval('meta[property="og:description"], meta[property="og:title"]', el => el.content).catch(() => "");
            }
            const id = (href.match(/\/(?:p|reel)\/([^/]+)/) || [])[1];
            if (id) posts.push({ id, ts, text, permalink: href });
          } catch (e) { note.permalinkError = String(e.message || e).slice(0, 120); }
        }
      }
      note.posts = posts.slice(0, 12);
      note.jsonBodies = t.bodies.length;
      notes[t.channel] = note;
    },
    failedRequestHandler({ request }, err) {
      notes[request.userData.channel] = { error: String(err.message || err).slice(0, 200), posts: [] };
    },
  });
  await crawler.run(TARGETS.map(t => ({ url: t.url, userData: { ...t }, uniqueKey: "b:" + t.channel })));
  console.log("\n── 1B  Crawlee PlaywrightCrawler (real browser + fingerprints, logged out, this machine)");
  table(TARGETS.map(t => score(t.channel, (notes[t.channel] || {}).posts)));
  for (const t of TARGETS) { const n = notes[t.channel] || {};
    console.log(`     ${t.channel}: ${n.error || `via ${n.via}, ${n.jsonBodies} JSON answers${n.gridLinks != null ? ", " + n.gridLinks + " grid links" : ""}, ended at ${n.finalUrl}${n.loginWall ? " (LOGIN WALL)" : ""}`}`);
    if (!n.error && !(n.posts || []).length) console.log(`        page said: "${n.bodyText}"`); }
  out.browser = notes;
}
console.log("\nsaved", saveResult("exp1-crawlee-" + mode, out));
