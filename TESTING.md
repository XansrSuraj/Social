# Testing — what runs, and how to check the site without touching production

## The suites

```bash
npm run test:unit    # every stubbed suite — no network, ~860 checks
npm run test:live    # api/collect against the real channels (needs the network)
npm test             # both
```

| Suite | What it proves |
|---|---|
| `test/pipeline.test.js` | the FM → channels pipeline end to end, replaying the real 4 Oct 2026 FM day (`test/fixtures/fm-2026-10-04.json`): verdicts, two-read "missing", Instagram "check by hand", drop reports sent once (a 3-day clean-up replay), superseded CMS failures, X counted as posted (`test/fixtures/x-vn-2026-10.json`, every X VN post of 4–9 Oct), the daily summary, Teams cards, health, "nothing old is ever notified" |
| `test/reconcile.test.js` | the daily check's engine (`src/engine/engine.js`, read straight from the file): drops, late folding, language detection, windows, alerts |
| `test/engine.test.js`, `test/report.test.js`, `test/mergeposts.test.js` | the engine's store, the shared report endpoint, post merging |
| `test/collect.test.js` (live) | `api/collect` against the real channels — fails when a platform changes what it serves; a platform refusing your network (TikTok on some Indian ISPs) is reported as refused, not failed |
| `test/free.test.js`, `test/fbdate.test.js`, `test/ig-*.test.js`, `test/tt-ext.test.js`, `test/x*.test.js`, `test/youtube.test.js` | each reader's parser, on saved pages |
| `test/apify*.test.js`, `test/retry.test.js`, `test/collectsplit.test.js` | the Apify fallback: cost caps, caching, retries |
| `test/ingest.test.js`, `test/thumb.test.js`, `test/health.test.js` | the small endpoints |

## Running the site locally

```bash
npm install
npm run dev          # the app with hot reload — http://localhost:5173 (Vite proxies /api to :3000)
npm run api          # the /api handlers on :3000
```

or `npm run build` and `node dev-server.js` — the built app and the handlers on one port.

With no `.env`, everything is local: the daily-check report lives in the browser, the pipeline's
ledger in `.pipeline.json` (gitignored), and nothing is sent anywhere. **Never put production alert
settings (`TEAMS_WEBHOOK_URL`, `NTFY_TOPIC`, `CALLMEBOT_*`) or `SUPABASE_*` in a local `.env`** unless
you mean to write to the real rows and post to the real channels.

## Checking the pipeline on real data, safely

A local tick reads the real FM feed and the real channels, and writes only local files:

- `.env` with no Supabase and no alert settings (as above). The FM feed's hosts are only on Vercel, so
  read FM through the site's own read-only proxy, e.g.
  `GET https://aiko-social-distribution-check.vercel.app/api/fm-deliveries?env=prod&since=…`.
- Call `tick()` from `pipeline/tick.js` with that as `fm`, `collectChannels` from `api/collect.js` as
  `collect`, and `pipeline/store.js` (local mode) as `store`. Its result and `.pipeline.json` show every
  verdict and every alert it *would* have sent (the outbox).

On production, read-only:

- `GET /api/pipeline` — the ledger as the Live and System health pages see it (`health` is the
  System health verdict).
- `#/health` — every part: clock, FM, all 14 readers, alert channels.
- Never call `?op=tick`, `?op=test-alert` or `?op=report` on production just to look — they run or send.

## Before a release

- [ ] `npm run test:unit` all green; `npm run build` builds
- [ ] `#/`, `#/report`, `#/live`, `#/health`, `#/fm`, `#/matchpulse` load with no console error, at
      phone width too, with no sideways scroll
- [ ] the System health page says everything is working, the clock shows ~60 checks in the last hour
- [ ] a change to alert wording: run `SHOW=1 node test/pipeline.test.js` and read the printed report
