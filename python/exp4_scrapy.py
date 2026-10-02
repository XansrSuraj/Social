"""EXPERIMENT 4 — Scrapy (Python): plain HTTP + HTML parsing, no browser, no JavaScript.
Each profile page is fetched once with a normal browser user agent and every JSON blob embedded
in the HTML is walked for posts (common.posts_from_json). TikTok's own rehydration script is
checked too. Run:  .venv/Scripts/python exp4_scrapy.py"""
import json, re
import scrapy
from scrapy.crawler import CrawlerProcess
from common import TARGETS, UA, posts_from_json, bodies_from_html, score, table, save

notes = {}


class Profiles(scrapy.Spider):
    name = "profiles"
    custom_settings = {
        "USER_AGENT": UA, "ROBOTSTXT_OBEY": False, "LOG_LEVEL": "ERROR", "DOWNLOAD_TIMEOUT": 25,
        "RETRY_TIMES": 1,
        # Facebook answers 400 to a request without a browser's Sec-Fetch / client-hint headers,
        # and the full page with them — measured with curl, 2026-10-02
        "DEFAULT_REQUEST_HEADERS": {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
            "sec-ch-ua": '"Chromium";v="140", "Google Chrome";v="140", "Not;A=Brand";v="99"',
            "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"'},
    }

    async def start(self):          # Scrapy 2.13+ starts a spider here, not in start_requests()
        for r in self.start_requests():
            yield r

    def start_requests(self):
        for t in TARGETS:
            yield scrapy.Request(t["url"], callback=self.parse, errback=self.failed, cb_kwargs={"t": t}, dont_filter=True)

    def parse(self, response, t):
        html = response.text
        bodies = bodies_from_html(html)
        m = re.search(r'<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', html, re.S)
        if m:
            try:
                bodies.append(json.loads(m.group(1)))
            except Exception:
                pass
        notes[t["channel"]] = {"status": response.status, "bytes": len(html),
                               "posts": posts_from_json(t["platform"], t["handle"], bodies)[:12]}

    def failed(self, failure):
        t = failure.request.cb_kwargs["t"]
        notes[t["channel"]] = {"error": repr(failure.value)[:160], "posts": []}


process = CrawlerProcess()
process.crawl(Profiles)
process.start()
print("\n── 4 Scrapy · plain HTTP · this machine")
table([score(t["channel"], notes.get(t["channel"], {}).get("posts")) for t in TARGETS])
for t in TARGETS:
    n = notes.get(t["channel"], {})
    print(f"     {t['channel']}: {n.get('error') or 'HTTP %s, %s bytes' % (n.get('status'), n.get('bytes'))}")
print("\nsaved", save("exp4-scrapy", {"scrapy": notes}))
