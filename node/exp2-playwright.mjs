/* EXPERIMENT 2 — raw Playwright, no Crawlee. Three flavours, to see what actually matters:
     plain   — Playwright's bundled headless Chromium, default settings
     stealth — the same, plus the usual tells removed: a normal Chrome user agent, the
               AutomationControlled blink feature off, navigator.webdriver hidden
     chrome  — the stealth settings in the REAL installed Google Chrome (channel "chrome")
   Same extraction as experiment 1 (extract.mjs): the page's own API answers, then the DOM.
   Optional logged-in mode: if sessions/<platform>.json exists (made by login.mjs), it is loaded.
   Run:  node exp2-playwright.mjs [plain|stealth|chrome|all] [channels]                       */
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { score, saveResult, table } from "./validate.mjs";
import { postsFromJson, parseBodies, bodiesFromHtml, xFromDom, ttFromDom } from "./extract.mjs";

const LAB = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
const TARGETS = [
  { channel: "ig-vn",   platform: "instagram", handle: "sportsfc.vn",   url: "https://www.instagram.com/sportsfc.vn/" },
  { channel: "ig-fans", platform: "instagram", handle: "sportsfc.fans", url: "https://www.instagram.com/sportsfc.fans/" },
  { channel: "fb-vn",   platform: "facebook",  handle: "sportsfc.vn",   url: "https://www.facebook.com/sportsfc.vn/reels/" },
  { channel: "fb-fans", platform: "facebook",  handle: "Sportsfc.fans", url: "https://www.facebook.com/Sportsfc.fans/reels/" },
  { channel: "x-vn",    platform: "x",         handle: "Sportsfcvn",    url: "https://x.com/Sportsfcvn" },
  { channel: "tt-vn",   platform: "tiktok",    handle: "sportsfc.vn",   url: "https://www.tiktok.com/@sportsfc.vn" },
];
const flavours = (process.argv[2] || "all") === "all" ? ["plain", "stealth", "chrome"] : [process.argv[2]];
const ONLY = (process.argv[3] || "").split(",").filter(Boolean);
const targets = ONLY.length ? TARGETS.filter(t => ONLY.includes(t.channel)) : TARGETS;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function readOne(ctx, t) {
  const page = await ctx.newPage();
  const bodies = [];
  page.on("response", async res => {
    const ct = String(res.headers()["content-type"] || "");
    if (!/json|javascript|text\/html/.test(ct) && !/graphql|api\//.test(res.url())) return;
    try { for (const b of parseBodies(await res.text())) bodies.push(b); } catch (e) {}
  });
  const note = { via: "network" };
  try {
    await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5000);
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(1500); }
    note.finalUrl = page.url();
    const html = await page.content();
    let posts = postsFromJson(t.platform, t.handle, [...bodies, ...bodiesFromHtml(html)]);
    if (!posts.length && t.platform === "x") { posts = await xFromDom(page, t.handle); note.via = "dom + snowflake"; }
    if (!posts.length && t.platform === "tiktok") { posts = await ttFromDom(page, t.handle); note.via = "dom + video-id time"; }
    if (!posts.length && t.platform === "instagram") {
      const hrefs = [...new Set(await page.$$eval('a[href*="/p/"], a[href*="/reel/"]', els => els.map(e => e.href.split("?")[0])))].slice(0, 6);
      note.via = `permalinks (${hrefs.length})`;
      for (const href of hrefs) {
        try {
          await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000);
          const ts = await page.$eval("time", el => el.getAttribute("datetime")).catch(() => null);
          const text = await page.$eval('meta[property="og:description"]', el => el.content).catch(() => "");
          posts.push({ id: (href.match(/\/(?:p|reel)\/([^/]+)/) || [])[1], ts, text, permalink: href });
        } catch (e) {}
      }
    }
    note.posts = posts.slice(0, 12);
    if (!posts.length) note.pageSaid = (await page.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 160).replace(/\s+/g, " ");
  } catch (e) { note.error = String(e.message || e).split("\n")[0].slice(0, 160); note.posts = []; }
  await page.close();
  return note;
}

const all = {};
for (const fl of flavours) {
  const opts = { headless: true };
  if (fl !== "plain") opts.args = ["--disable-blink-features=AutomationControlled"];
  if (fl === "chrome") opts.channel = "chrome";
  const browser = await chromium.launch(opts);
  const notes = {};
  for (const t of targets) {
    /* a saved logged-in session for this platform, if one was made with login.mjs */
    const sess = path.join(LAB, "sessions", t.platform + ".json");
    const ctx = await browser.newContext({
      locale: "en-US", viewport: { width: 1280, height: 1600 },
      ...(fl !== "plain" ? { userAgent: UA } : {}),
      ...(fs.existsSync(sess) ? { storageState: sess } : {}),
    });
    if (fl !== "plain") await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
    notes[t.channel] = await readOne(ctx, t);
    notes[t.channel].loggedIn = fs.existsSync(sess);
    await ctx.close();
  }
  await browser.close();
  console.log(`\n── 2 Playwright · ${fl}${fl === "chrome" ? " (real Google Chrome)" : ""} · this machine`);
  table(targets.map(t => score(t.channel, notes[t.channel].posts)));
  for (const t of targets) { const n = notes[t.channel];
    console.log(`     ${t.channel}: ${n.error || "via " + n.via}${n.loggedIn ? " [logged-in session]" : ""}${n.pageSaid ? ` — page said "${n.pageSaid}"` : ""}`); }
  all[fl] = notes;
}
console.log("\nsaved", saveResult("exp2-playwright-" + flavours.join("+"), all));
