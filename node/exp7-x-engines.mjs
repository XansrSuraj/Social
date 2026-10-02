/* EXPERIMENT 7 — X with other browser engines. From a datacenter IP, X answers Chromium (bundled
   or real Chrome) with "Performing security verification". Does Firefox or WebKit (Safari's
   engine) get the profile instead? Same DOM + snowflake reading as before.
   Run:  node exp7-x-engines.mjs [firefox,webkit]                                               */
import { firefox, webkit } from "playwright";
import { score, saveResult, table } from "./validate.mjs";
import { xFromDom } from "./extract.mjs";

const ENGINES = { firefox, webkit };
const which = (process.argv[2] || "firefox,webkit").split(",");
const out = {};
for (const name of which) {
  const note = {};
  let browser;
  try {
    browser = await ENGINES[name].launch({ headless: true });
    const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 1600 } });
    const page = await ctx.newPage();
    await page.goto("https://x.com/Sportsfcvn", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(9000);
    note.posts = await xFromDom(page, "Sportsfcvn");
    note.text = (await page.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 160).replace(/\s+/g, " ");
  } catch (e) { note.error = String(e.message || e).split("\n")[0].slice(0, 160); note.posts = []; }
  if (browser) await browser.close();
  out[name] = note;
}
console.log("\n── 7 X with other engines · " + (process.env.LAB_PREFIX ? "GitHub Actions" : "this machine"));
for (const [k, n] of Object.entries(out)) {
  const s = score("x-vn", n.posts);
  console.log(`  ${k.padEnd(8)} recall ${s.recall} (${s.recallPct}%) times ${s.exactTimes} captions ${s.captions} | ${n.error || `page said "${n.text}"`}`);
}
console.log("\nsaved", saveResult("exp7-x-engines", out));
