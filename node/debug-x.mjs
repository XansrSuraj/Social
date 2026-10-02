/* What does x.com hand a logged-out browser on this network? Lists the JSON/GraphQL calls the page
   makes and what the rendered tweets carry, so the extractor can be pointed at the right thing. */
import { chromium } from "playwright";
import { parseBodies, walk } from "./extract.mjs";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 1600 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });
const page = await ctx.newPage();
const calls = [];
page.on("response", async res => {
  const u = res.url();
  if (!/x\.com|twitter\.com|twimg/.test(u)) return;
  const ct = String(res.headers()["content-type"] || "");
  if (!/json/.test(ct)) return;
  let keys = "", tweets = 0;
  try {
    const bodies = parseBodies(await res.text());
    keys = bodies.map(b => Object.keys(b).slice(0, 4).join(",")).join(" | ");
    for (const b of bodies) walk(b, o => { if (o.legacy && o.legacy.created_at && o.rest_id) tweets++; });
  } catch (e) {}
  calls.push({ status: res.status(), url: u.replace(/\?.*/, "").slice(0, 110), tweets, keys: keys.slice(0, 80) });
});
await page.goto("https://x.com/Sportsfcvn", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(8000);
for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 2000); await page.waitForTimeout(1500); }
console.log("page text:", (await page.evaluate(() => document.body.innerText)).slice(0, 160).replace(/s+/g, " "));
console.log("JSON calls:");
for (const c of calls) console.log(" ", c.status, c.tweets ? `[${c.tweets} tweets]` : "", c.url, "|", c.keys);
const arts = await page.$$eval("article", els => els.slice(0, 8).map(a => ({
  time: (a.querySelector("time") || {}).getAttribute ? a.querySelector("time").getAttribute("datetime") : null,
  link: (a.querySelector('a[href*="/status/"]') || {}).href || null,
  text: ((a.querySelector('[data-testid="tweetText"]') || {}).innerText || "").slice(0, 60),
  social: ((a.querySelector('[data-testid="socialContext"]') || {}).innerText || ""),
})));
console.log("\narticles in the DOM:", arts.length);
for (const a of arts) console.log(" ", a.time, a.link, JSON.stringify(a.text), a.social ? "(" + a.social + ")" : "");
await browser.close();
