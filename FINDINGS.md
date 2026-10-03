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

## Round 2 — GitHub Actions (Microsoft datacenter, US — the same kind of IP as Vercel)

| Channel | Browser tools (Crawlee / Playwright / Selenium) | Free side door, plain HTTP |
|---|---|---|
| Facebook ×2 | ✅ 6/6 | ✅ 6/6 — `/reels/` page + browser headers |
| Instagram `sportsfc.vn` | ❌ redirected to login | ✅ 6/6 — `instagram.com/<user>/embed/` (feed widget) |
| Instagram `sportsfc.fans` | ❌ | ❌ 18+ wall (needs a logged-in adult session, or remove the restriction) |
| TikTok `@sportsfc.vn` | ❌ profile served with empty post lists | ✅ 6/6 — `tiktok.com/embed/@<user>` (creator widget), captions included |
| X `Sportsfcvn` | ❌ "Performing security verification" (Chrome, Firefox, WebKit alike) | ❌ none found |

## Round 3 — reliability (5 rounds, 2.5 min apart, GitHub Actions, plain fetch only)

| Channel | Full recall | Time per read |
|---|---|---|
| Facebook `sportsfc.vn` | 5/5 | ~1.3 s |
| Facebook `Sportsfc.fans` | 5/5 | ~1.1 s |
| Instagram `sportsfc.vn` | 5/5 | ~0.8 s |
| TikTok `@sportsfc.vn` | 5/5 | ~0.6 s |

Every read: exact timestamps and captions on 100 % of posts. No browser, no login, no paid service.

## Conclusion

- **Free, server-side, no browser:** Facebook ×2, Instagram `sportsfc.vn`, TikTok — plain `fetch()`
  that fits in the existing Vercel function. This is ~88 % of the Apify bill.
- **Instagram `sportsfc.fans`:** free the moment its 18+ restriction is removed (the embed then works
  like `sportsfc.vn`); otherwise only a logged-in adult session can read it (`node/login.mjs`).
- **X:** free only from a home connection (real Chrome); from any datacenter it is bot-walled.
  Apify reads it for ~$0.001 per check (~$0.03 a month) — not worth fighting.
- **Tools:** Crawlee / Playwright / Selenium / Scrapy all got identical answers once they presented
  the same request; the winners need none of them — the side doors are plain HTTP.
- **Dead ends:** tikwm and other mirrors (Cloudflare), TikTok profile page from a datacenter
  (empty lists), X from a datacenter with any engine.
- **Caveat:** side doors are undocumented; any platform can change them. Keep Apify as the fallback
  when a free read fails, so a change costs a few cents instead of a blank report.

## Round 4 — context.dev (prepared, waiting for an API key)

context.dev is a scraping API (YC S26): `POST api.context.dev/v1/web/scrape` returns a page's HTML
rendered in a real browser behind "stealth proxies". Free plan: 1,000 credits a month on a
work-email account (250 once on a personal email); 1 credit per page; custom request headers allowed.
Its docs say nothing about Instagram, X or logged-in content.

`node/exp9-contextdev.mjs` reads, through it: X `Sportsfcvn`; Instagram `sportsfc.fans` (profile and
embed, logged out — and with a session cookie only if `IG_COOKIE` is set in `.env`); controls
Instagram `sportsfc.vn` and TikTok. About 7 credits per run.

Expectations before running: X has a fair chance (a real browser on a non-datacenter IP is exactly
what got X to render from a home connection); the 18+ Instagram account almost certainly stays
closed logged out — the wall is a property of the account, which no proxy changes.
