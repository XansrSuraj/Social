# Findings — free alternatives to Apify

Scored against `ground-truth.json` (Apify's reads of 2026-10-02). "Recall" = how many of the true
posts from the last 24 h were found; every success below also had **exact timestamps and captions
on 100 % of posts**.

## Round 1 — this machine (home broadband in India), logged out

| Channel | Crawlee HTTP | Crawlee browser | Playwright plain | Playwright stealth | Playwright + real Chrome | Selenium | Scrapy |
|---|---|---|---|---|---|---|---|
| Facebook `sportsfc.vn` | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 * |
| Facebook `Sportsfc.fans` | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 * |
| Instagram `sportsfc.vn` | ❌ | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 | ✅ 6/6 | ❌ |
| Instagram `sportsfc.fans` | ❌ age wall | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| X `Sportsfcvn` | ❌ | ✅ 5/5 | ❌ blank page | ❌ blank page | ✅ 5/5 | ✅ 5/5 | ❌ |
| TikTok `@sportsfc.vn` | — blocked by the ISP | — | — | — | — | — | — |

\* Scrapy needed browser-style request headers (below).

### What was learned

1. **The tool barely matters; what the platform sees does.** All four tools got the same answers
   once they presented the same thing (a real browser, or the right headers).
2. **Facebook needs no browser at all.** `facebook.com/<page>/reels/` serves its 10 newest posts —
   exact `creation_time`, full caption with the `sfc.my` link, post id — embedded as JSON in the
   HTML. A plain request gets **HTTP 400**; the same request with a browser's `Sec-Fetch-*` and
   `sec-ch-ua` headers gets the full page. This is *better* than Apify's Reels scraper, which
   returns no caption at all.
3. **Instagram needs a real browser** (the profile page fetches its posts with JavaScript). Then
   it works logged out: 6/6 with exact time and caption, read from each post's own page.
4. **X needs a real browser that does not look automated.** Playwright's bundled Chromium gets a
   blank page even with the usual stealth tweaks; the real installed Google Chrome (Playwright
   `channel:"chrome"`, Selenium) or Crawlee's fingerprints get the profile. The logged-out profile
   shows the 5 newest posts with no `<time>` on them — but an X post id is a *snowflake*: its top
   bits are the creation time in ms. Decoded, it matches Apify to the second.
5. **TikTok video ids carry their time too** (top 32 bits = unix seconds; 16 s from Apify's
   figure) — useful if the grid renders but its API answer is not visible.
6. **Instagram `sportsfc.fans` is behind Instagram's 18+ wall.** No logged-out reader — free or
   Apify — can see it. Only a logged-in session (an adult account) can.
7. **TikTok cannot be tested from this network** (Indian ISPs block it at the TCP level).

## Round 2 — GitHub Actions (datacenter IP, TikTok reachable)

_Running — results land in `results/gha-*.json` / `.log`._
