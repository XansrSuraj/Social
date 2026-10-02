/* Make a logged-in browser session for the session experiments — run by a PERSON, once.
   Opens a visible Chrome window on the platform's login page. You log in yourself (the password
   never passes through this script); when you close the window, the session (cookies + local
   storage) is saved to sessions/<platform>.json. That folder is gitignored — it is effectively a
   password, never committed, never pasted anywhere.

     node login.mjs instagram     (needed for the 18+ account sportsfc.fans — use an ADULT account,
                                   ideally a secondary one, never the brand account itself)
     node login.mjs x             (only if X is to be read from a datacenter, e.g. GitHub Actions)

   Then exp2-playwright.mjs loads the session automatically for that platform.            */
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const LAB = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
const PAGES = { instagram: "https://www.instagram.com/accounts/login/", x: "https://x.com/i/flow/login",
                facebook: "https://www.facebook.com/login/", tiktok: "https://www.tiktok.com/login" };
const platform = process.argv[2];
if (!PAGES[platform]) { console.log("usage: node login.mjs instagram|x|facebook|tiktok"); process.exit(1); }

const out = path.join(LAB, "sessions", platform + ".json");
fs.mkdirSync(path.dirname(out), { recursive: true });
const browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();
await page.goto(PAGES[platform]);
console.log(`Log in to ${platform} in the window that opened, then CLOSE THE WINDOW to save the session.`);
/* save every few seconds, so closing the window at any point keeps the latest cookies */
const timer = setInterval(() => ctx.storageState({ path: out }).catch(() => {}), 3000);
await new Promise(r => browser.on("disconnected", r));
clearInterval(timer);
console.log(fs.existsSync(out) ? `saved ${out} — keep it private` : "nothing saved");
