# FM → channels pipeline

Every card the content team sends from the CMS goes CMS → FM Deliveries → Football Module →
personalisation → distribution → Ayrshare → each channel. FM Deliveries knows **what should have gone
out, where and when**. This pipeline checks, automatically and for free, that each of those deliveries
**actually appeared on the channel**, and sends a WhatsApp message when something did not. Nobody has to
open the website and press Run; the website is where you look when an alert says something broke.

Live page: **`#/live`** on the site. Code: `pipeline/` + `api/pipeline.js`. Tests: `test/pipeline.test.js`
(replays the real 4 Oct 2026 FM day).

## How a tick works (every minute)

1. **FM** — reads FM Deliveries (prod) for the last 36 h, by queued and by sent time. Scheduled cards,
   cards sent "now", weekend batches, retries — they all simply appear in the feed and are handled the
   same way.
2. **Caption check** — the moment a card is seen: X over 280 by X's count **of the caption as posted**
   — distribution puts the short link and a blank line in front, and X counts every `sportsfc.fans` as a
   link (23). That count equals X's own for every X VN post of 4–9 Oct; every one over 280 went missing,
   the longest that posted was 277. FM's text alone came out 25–44 short (8 Oct 16:35: 251 → 285).
   270+ is flagged as "at the limit". Telegram over 1024 on a video, Instagram over 2200 characters
   or 30 hashtags, TikTok over 2200.
3. **Look for the post** — from 2 minutes after FM sent it, only the channels that are due are read
   (free readers only — no Apify — and always a read of *now*: never a cached read, a "last good read"
   or posts pushed in earlier), and the post is matched on **time and caption words** (FM gives the
   exact caption; every real match on 4 Oct scored 100%). Every reader is also read at least **every
   30 minutes whether a card is due or not** (3 per tick, stalest first), so its health is always live.
   A post is called **missing only when it is absent from two reads a minute apart**, each complete
   (not partial — e.g. YouTube's Shorts tab refusing), with posts in it, and reaching back past the
   post's time. A read that proves nothing is "couldn't check", never "missing".
4. **Verdict** per delivery:

   | Status | Meaning | Alert |
   |---|---|---|
   | ✓ verified | on the channel within 20 min | — (in the drop summary) |
   | ✓ late | turned up after 20 min | 🕒 if it had been reported missing |
   | ✗ missing | FM sent it, not on the channel after 20 min | ❌ immediately |
   | ! reader failed | the channel could not be read for 10 min past the window — **our** problem, not the content team's | in the drop report only |
   | ≈ assumed | Viber — nothing can read it, FM's "sent" is taken as delivered (agreed exception) | — |
   | – not watched | a platform FM added later that isn't configured here | — |
   | ? can't verify | Instagram `sportsfc.fans` while it is 18+ | — |
   | FM failed / stuck / can't confirm | FM itself failed, or a card still queued 15 min after its time | 🛑 held 5 min (see below) · ⏳ ❔ immediately |
   | ↻ superseded | a failed/skipped attempt the content team **sent again** (same card, same language, ≥ 20 s later) | — (a note in that send's drop report) |
   | · not checked | sent before the pipeline was watching | — |

5. **Report** — everything read is merged into the daily-check report (conditionally — a browser's own
   save is never overwritten), so `#/report` stays current with nobody pressing Run.
6. **Alerts** (Teams, phone, WhatsApp) — problems as soon as they are known; one full report per drop
   once all its channels are settled; a digest after 23:00 IST. Every alert is sent once.

### Two rules that keep alerts true (since 10 Oct 2026)

- **A drop's report goes out once, ever.** A drop (one card on every channel and language within 20 min)
  is fixed the moment it forms (`led.drops`) and cleaned up only as a whole, 3 days later. Until 9 Oct
  drops were re-derived each tick from what was left; when the clean-up removed a drop's first posts the
  rest looked new, and 6 Oct's reports went out again on 9 Oct with removed channels shown as "not sent
  by content team". `test/pipeline.test.js` replays three days of clean-up and checks nothing returns.
- **Old news is never news.** Nothing whose time is not today (IST) or within the last 6 hours is
  notified or logged, whatever the ledger says.

### An FM failure that was already fixed

On 9 Oct 18:22 the CMS skipped a card (no channel images; FM leaves template and caption empty) and the
content team sent it again 58 s later. Then: five "FM skipped" alerts and a report "Card: card · 0/0".
Now an FM failure is **held 5 minutes**; a later send of the same card supersedes it (no alert, no drop
of its own, a note in the new send's report). With no second send it is alerted after 5 minutes, named
after its card (or its collection), and its report says plainly that nothing went out.

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

## Microsoft Teams (the team's channel)

Every alert also goes into a Teams channel as one Adaptive Card per check — a red section for a problem,
a green one for a drop that was fully delivered, every channel's ✓/✗ per language, and a link to the
Live page. Teams' own "Incoming Webhook" connector was retired in May 2026; this uses its official
replacement, the **Workflows** app.

1. In Teams, open the channel → **⋯** → **Workflows** → template **"Send webhook alerts to a channel"**
   → choose the team and channel → **Save** → copy the **webhook URL** it shows. (The URL lets anyone
   post into the channel — keep it out of chat and out of the code.)
2. Vercel → Environment Variables: `TEAMS_WEBHOOK_URL` = that URL. Redeploy.
3. Live page → **Test alert** — a green "Teams alerts are working" card appears in the channel.

The card shows as posted by the Workflows (flow) bot; the workflow belongs to whoever created it, so add
a co-owner in Workflows so it keeps working if that person leaves.

## The pipeline's own health — the System health page (`#/health`)

One page shows whether every part works right now: the clock (checks in the last hour), the last
check's run, the report sync, the FM feed (answer time, newest delivery), **every channel reader** —
its method, last read, posts seen, newest post, and its last 30 reads as bars — and every alert
channel. It refreshes every 15 s; the Live page carries a one-line summary of it.

- **A check crashes** → 🚨 "Pipeline check failed" on every channel at once (at most every 30 min while
  it keeps retrying each minute).
- **The clock stops** (cron-job.org down, GitHub late) → the first check after it says "🕒 Pipeline was
  paused for N min" and catches up on everything sent in that time.
- **FM unreachable 15+ min** → 📡.
- **A scraper failing** (reader down / back, a post that couldn't be checked) is **not a notification**
  (since 8 Oct): the free readers hiccup for a minute or two and recover on their own — FxTwitter
  answered 404 for X twice that day. It is shown on the **Live page → System status** instead: what is
  down, since when and why, plus the recent incidents. A channel that can't be read at the 20-min mark
  is retried every minute for 10 more minutes before its drop is reported, so a short hiccup changes
  nothing; FxTwitter's 404 is also retried at once.
- **The site itself down** → cron-job.org emails its owner after failed calls.

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

- **X** is read through FxTwitter (free, community-run). It sometimes answers 404 for a minute or two;
  that is retried, and if it lasts, the last-chance paid read covers it. Its state is on the Live page.
- **CallMeBot** is a free personal service with no published limits; failed messages are retried for
  six ticks.
- **Telegram bot** reads need the user session (`TG_SESSION`); if Telegram logs it out, the bot channel
  shows as not readable on the Live page (System status) — re-run `tg-login.js`.
