# FM → channels pipeline

Every card the content team sends from the CMS goes CMS → FM Deliveries → Football Module →
personalisation → distribution → Ayrshare → each channel. FM Deliveries knows **what should have gone
out, where and when**. This pipeline checks, automatically and for free, that each of those deliveries
**actually appeared on the channel**, and sends a WhatsApp message when something did not. Nobody has to
open the website and press Run; the website is where you look when an alert says something broke.

Live page: **`#/live`** on the site. Code: `pipeline/` + `api/pipeline.js`. Tests: `test/pipeline.test.js`
(replays the real 4 Oct 2026 FM day).

## How a tick works (every 5 minutes)

1. **FM** — reads FM Deliveries (prod) for the last 36 h, by queued and by sent time. Scheduled cards,
   cards sent "now", weekend batches, retries — they all simply appear in the feed and are handled the
   same way.
2. **Caption check** — the moment a card is seen: X over 280 by X's own count (270+ is flagged as "at
   the limit" — a 280 one never reached X on 4 Oct), Telegram over 1024 on a video, Instagram over
   2200 characters or 30 hashtags, TikTok over 2200.
3. **Look for the post** — from 2 minutes after FM sent it, only the channels that are due are read
   (free readers only — no Apify), and the post is matched on **time and caption words** (FM gives the
   exact caption; every real match on 4 Oct scored 100%).
4. **Verdict** per delivery:

   | Status | Meaning | Alert |
   |---|---|---|
   | ✓ verified | on the channel within 20 min | — (in the drop summary) |
   | ✓ late | turned up after 20 min | 🕒 if it had been reported missing |
   | ✗ missing | FM sent it, not on the channel after 20 min | ❌ immediately |
   | ! reader failed | the channel could not be read — **our** problem, not the content team's | 🔧 |
   | ≈ assumed | Viber — nothing can read it, FM's "sent" is taken as delivered (agreed exception) | — |
   | – not watched | a platform FM added later that isn't configured here | — |
   | ? can't verify | Instagram `sportsfc.fans` while it is 18+ | — |
   | FM failed / stuck / can't confirm | FM itself failed, or a card still queued 15 min after its time | 🛑 ⏳ ❔ immediately |
   | · not checked | sent before the pipeline was watching | — |

5. **Report** — everything read is merged into the daily-check report (conditionally — a browser's own
   save is never overwritten), so `#/report` stays current with nobody pressing Run.
6. **WhatsApp** — problems as soon as they are known; one summary per drop once all its channels are
   settled ("✅ 18:30 Attack vs Defense — 13/13 checked channels received it · Viber 3 assumed · …");
   a digest after 23:00 IST. Every alert is sent once, batched into as few messages as possible.

A delivery whose channel failed to read for free gets **one** paid (Apify) attempt at its last chance —
never on every tick — so the pipeline costs nothing on a normal day.

## The clock

- **GitHub Actions** (`.github/workflows/pipeline.yml`) calls `/api/pipeline?op=tick` every 5 minutes —
  free on this public repo. GitHub can start a scheduled run late; nothing is lost, every tick catches
  up on all that is due. GitHub disables scheduled workflows after 60 days with no commit — Actions →
  *pipeline-tick* → Enable turns it back on.
- **Vercel's cron** (`vercel.json`) runs a tick once a day at 23:40 IST as a second clock (the Hobby
  plan allows only daily crons).
- **Faster:** a free [cron-job.org](https://cron-job.org) job calling
  `https://aiko-social-distribution-check.vercel.app/api/pipeline?op=tick&fast=1` every minute makes alerts
  near-instant. `fast=1` answers at once and finishes in the background — cron-job.org cuts a request at
  30 s and switches a job off after 25 failures in a row. Ticks closer than 40 s apart, or overlapping, do nothing — so several clocks are safe.

## WhatsApp setup (once, by the phone's owner — never paste the key in chat)

1. In WhatsApp, send **`I allow callmebot to send me messages`** to **+34 644 05 92 17** (CallMeBot,
   free for personal notifications). The reply contains your **apikey**.
2. Vercel → project → Settings → Environment Variables (Production):
   `WHATSAPP_PHONE` = your number with country code, e.g. `+9198…` · `CALLMEBOT_APIKEY` = the apikey.
3. Redeploy, then on the Live page press **Test alert**.

Until then alerts are kept in the ledger and shown on the Live page; they are not lost.

CallMeBot says: if the key does not arrive within 2 minutes, try again after 24 hours (it often does not answer when busy).

## Phone push (ntfy) — instant, free, no signup

Every alert also goes out as a phone notification through [ntfy](https://ntfy.sh), independent of
WhatsApp, so alerts arrive even while CallMeBot is slow or down.

1. Install **ntfy** (Play Store / App Store) → **+** → subscribe to your topic (a long random name —
   anyone who knows it can read the alerts, so do not use a guessable one).
2. Vercel → Environment Variables: `NTFY_TOPIC` = that same name. Redeploy.
3. Live page → **Test alert**. Problems arrive as high-priority notifications; tapping one opens the Live page.

## Channels FM sends to that are not checked

| FM channel | Why | What happens |
|---|---|---|
| Viber (all 3 languages) | nothing can read Viber | FM's "sent" is taken as delivered (agreed exception) |
| Instagram EN `sportsfc.fans` | 18+ — nothing logged-out can see it | read on every drop anyway; "can't be checked" while restricted, **verified automatically the day the restriction is lifted** — no change needed |
| X EN, X PT, TikTok EN, TikTok PT, Telegram PT, Telegram bot EN, Telegram bot PT | **the accounts don't exist yet** — FM sends, distribution drops it (2026-10-05) | ignored everywhere: no ledger entry, no alert, not on the Live page |

When one of those accounts is created: put it in `pipeline/channels.js` (mode `"verify"` with a `read`
entry) **and** in `SPORTSFC` in `src/engine/engine.js` — `test/pipeline.test.js` fails if they differ.

MatchPulse has no FM feed yet; when it does, it gets its own entry here.

## Matching rules

A post counts as the delivery's post when it is on the channel from 5 min before to 20 min after FM
sent it and shares **≥ 75%** of the caption's words; after 20 min (a late arrival) it must share
**≥ 90%** — one template used for two matches can share ~80% of its words (3 Oct: "The Full Verdict"
for Spain–Czechia and for Croatia–England). All of a channel's due deliveries are matched against all
of its posts at once, best pairs first.

## Endpoints

- `GET /api/pipeline` — status (public, read-only; no keys, numbers or emails in it)
- `GET /api/pipeline?op=tick` — run a tick now
- `GET /api/pipeline?op=test-alert` — one test alert on every configured channel (at most one per 10 min)
- Optional `PIPELINE_KEY` env var: when set, `op=tick` / `op=test-alert` need `?key=…` (add the same
  value as the GitHub secret `PIPELINE_KEY` so the clock keeps working).

## Honest limits

- **X** is read through FxTwitter (free, community-run). If it breaks, X shows "reader failed" and the
  last-chance paid read covers it.
- **CallMeBot** is a free personal service with no published limits; failed messages are retried for
  six ticks.
- **Telegram bot** reads need the user session (`TG_SESSION`); if Telegram logs it out, the bot channel
  shows "reader down" — re-run `tg-login.js`.
