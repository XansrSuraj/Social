/* X through Crawlee (fingerprinted browser): what the rendered tweets carry — links, text,
   attributes — so X can be read from the DOM when no API call carries the tweets. */
import { PlaywrightCrawler, Configuration, log } from "crawlee";
log.setLevel(log.LEVELS.WARNING);
Configuration.getGlobalConfig().set("persistStorage", false);

const crawler = new PlaywrightCrawler({
  maxRequestRetries: 0, requestHandlerTimeoutSecs: 120,
  launchContext: { launchOptions: { headless: true } },
  browserPoolOptions: { useFingerprints: true },
  async requestHandler({ page }) {
    await page.waitForTimeout(8000);
    const dump = await page.$$eval("article", els => els.slice(0, 3).map(a => ({
      attrs: [...a.attributes].map(x => x.name + "=" + String(x.value).slice(0, 40)).join(" "),
      hrefs: [...a.querySelectorAll("a")].map(x => x.getAttribute("href")).slice(0, 12),
      times: [...a.querySelectorAll("time,[datetime]")].map(t => t.getAttribute("datetime")),
      text: a.innerText.slice(0, 180).replace(/\s+/g, " "),
    })));
    console.log(JSON.stringify(dump, null, 1));
    const html = await page.content();
    console.log("status ids in page:", [...new Set((html.match(/\/status\/(\d{15,20})/g) || []))].slice(0, 10));
  },
});
await crawler.run(["https://x.com/Sportsfcvn"]);
