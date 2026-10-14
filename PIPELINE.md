# FM → channels pipeline

Every card the content team sends from the CMS goes CMS → FM Deliveries → Football Module →
personalisation → distribution → Ayrshare → each channel. FM Deliveries knows **what should have gone
out, where and when**. This pipeline checks, automatically and for free, that each of those deliveries
**actually appeared on the channel**, and tells the team in Microsoft Teams and on the phone (ntfy) when
something did not — WhatsApp too, if it is set up. Nobody has to open the website and press Run; the
website is where you look when an alert says something broke.

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
   | ⚠ not visible | **Instagram only**: not on the public profile after 20 min. Instagram puts an 18+ wall on single posts by itself (9 Oct 22:30, a betting-style reel on Instagram PT) and nothing logged-out — Apify included — can see such a post, so it may be restricted *or* not posted | ⚠️ "Check by hand" — short, amber |
   | ! reader failed | the channel could not be read for 10 min past the window — **our** problem, not the content team's | in the drop report only |
   | ≈ assumed | Viber — nothing can read it, FM's "sent" is taken as delivered (agreed exception) | — |
   | – not watched | a platform FM added later that isn't configured here | — |
   | FM failed / stuck / can't confirm | FM itself failed, or a card still queued 15 min after its time (an hour after it, the drop is reported with it as "stuck in FM" rather than held back) | 🛑 held 5 min (see below) · ⏳ ❔ immediately |
   | ↻ superseded | a failed/skipped attempt the content team **sent again** (same card, same language, ≥ 20 s later) | — (a note in that send's drop report) |
   | · not checked | sent before the pipeline was watching | — |

5. **Report** — a read that brings a post the daily-check report hasn't had is merged into it
   (conditionally — a browser's own save is never overwritten), so `#/report` stays current with nobody
   pressing Run. A read with nothing new leaves the shared row alone.
6. **Alerts — only problems** (since 15 Oct 2026). Who hears what (`pipeline/tick.js`, step 9):

   | | Teams (the content team's channel) | Phone push (ntfy) — the admin | The website |
   |---|---|---|---|
   | a post missing, not sent by FM/CMS, stuck, late, caption problem — as soon as it is known | ✓ | ✓ | ✓ |
   | the drop's full report, **when it has a problem** | ✓ | ✓ | ✓ |
   | a drop that went out fine everywhere | — | — | ✓ (Live, Report) |
   | the **daily summary**, once, after 23:00 IST — posts that reached their channels per language, and what needs attention with its time and why | ✓ | ✓ | ✓ |
   | the pipeline's own trouble — a crash, the clock paused, FM's feed down | — | ✓ | ✓ (Admin) |
   | a reader (scraper) failing and recovering | — | — | ✓ (Admin) |

   Every delivery is counted in exactly one summary: one still being checked at 23:00 (or sent after it)
   is in the next night's, with a note. Every alert is sent once. `PIPELINE_NOTIFY=all` (env var) brings
   back the old behaviour — every drop report, good or bad, everywhere. `TEAMS_OFF` in
   `pipeline/teams.js` is a kill switch for Teams alone (off since 15 Oct: Teams is on).

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

- **cron-job.org — the main clock.** A free [cron-job.org](https://cron-job.org) job calls
  `https://aiko-social-distribution-check.vercel.app/api/pipeline?op=tick&fast=1` **every minute**.
  `fast=1` answers at once and finishes in the background — cron-job.org cuts a request at 30 s and
  switches a job off after 25 failures in a row.
- **GitHub Actions — a backup** (`.github/workflows/pipeline.yml`), every 30 minutes. The repo is private,
  where Actions minutes are counted (2,000 a month free): 48 short runs a day stay far inside that.
  GitHub disables scheduled workflows after 60 days with no commit — Actions → *pipeline-tick* → Enable.
- **Vercel's cron** (`vercel.json`) — one tick a day at 23:40 IST, a third clock (the Hobby plan allows
  only daily crons).

Ticks closer than 40 s apart, or overlapping, do nothing — so several clocks are safe; and a late tick
catches up on everything that is due.

## Staying on Supabase's free plan

Supabase's free plan counts every byte it **sends back** (egress, 5 GB a month). Reading the whole ledger
(~0.4 MB) every minute, and getting it back again on every write, used ~300 MB a day — the quota was
exceeded in September 2026 (grace period to 21 Oct). Since 10 Oct:

- a tick takes the lock by a conditional write onto the copy its instance already holds — no read at all
  unless something else wrote the row (`pipeline/store.js`); every write gets back only the row's id;
- the Live and Health pages are answered from that copy when it is under a minute old;
- the shared daily-check report is merged into at most every 15 min, and only when a read found a new post;
- the website's every-minute sync asks "changed since my copy?" (a few bytes) before reading the report;
- the pipeline's reads never open the ingest row.

`test/store.test.js` checks it: ten ticks read the ledger once. Supabase → Usage shows the real figure
(it refreshes hourly).

## WhatsApp setup (once, by the phone's owner — never paste the key in chat)

1. In WhatsApp, send **`I allow callmebot to send me messages`** to **+34 644 05 92 17** (CallMeBot,
   free for personal notifications). The reply contains your **apikey**.
2. Vercel → project → Settings → Environment Variables (Production):
   `WHATSAPP_PHONE` = your number with country code, e.g. `+9198…` · `CALLMEBOT_APIKEY` = the apikey.
3. Redeploy, then on the Live page press **Test alert**.

Until then alerts are kept in the ledger and shown on the Live page; they are not lost.

CallMeBot says: if the key does not arrive within 2 minutes, try again after 24 hours (it often does not answer when busy).

## Microsoft Teams (the team's channel)

Problems go into a Teams channel as one Adaptive Card per check — a red section for a problem, the
drop's every channel ✓/✗ per language, and a link to the Live page — and the day's summary at 23:00.
A drop that went out fine is not posted (it is on the site), and nor is the pipeline's own trouble
(that goes to the admin's phone and the Admin page). Teams' own "Incoming Webhook" connector was retired in May 2026; this uses its official
replacement, the **Workflows** app.

1. In Teams, open the channel → **⋯** → **Workflows** → template **"Send webhook alerts to a channel"**
   → choose the team and channel → **Save** → copy the **webhook URL** it shows. (The URL lets anyone
   post into the channel — keep it out of chat and out of the code.)
2. Vercel → Environment Variables: `TEAMS_WEBHOOK_URL` = that URL. Redeploy.
3. Admin page → **Test alert** — a green "Teams alerts are working" card appears in the channel.

The card shows as posted by the Workflows (flow) bot; the workflow belongs to whoever created it, so add
a co-owner in Workflows so it keeps working if that person leaves.

## The pipeline's own health — the Admin dashboard (`#/admin`, signed in)

One page shows whether every part works right now, and where it broke if not:

- **the pipeline, end to end** — Clock → FM feed → Check → Readers → Report sync → Alerts, each green,
  amber or red; the first red step is where it broke, and a click jumps to its detail;
- **Errors** — every error a check met (100 newest: which reader, Teams, WhatsApp, a crash with its
  first stack line), and the last crash;
- **What was sent** — every message to Teams, the phone and WhatsApp: when, what, delivered or the
  reason it failed; and how many are waiting to go out;
- **the last 60 checks** as bars — slow ones taller, ones with errors red, ones that came 3+ min late amber;
- the clock, the last check's run, the report sync, the FM feed (answer time, newest delivery), **every
  channel reader** — its method, last read, posts seen, newest post, its last 30 reads — and every
  alert channel; **who hears what**; the recent incidents.

It refreshes every minute, like the pipeline; the Live page carries a one-line summary of it for the admin.
The content team's Live page shows each post's result and, for a problem, why in plain words — "couldn't
be checked automatically — on our side" for a reader failure, never the reader's own error.

- **A check crashes** → 🚨 "Pipeline check failed" to the admin's phone (at most every 30 min while it
  keeps retrying each minute), and on the Admin page. Never to Teams.
- **The clock stops** (cron-job.org down, GitHub late) → the first check after it says "🕒 Pipeline was
  paused for N min" (phone and Admin page) and catches up on everything sent in that time — the posts
  it finds missing go to Teams as usual.
- **FM unreachable 15+ min** → 📡 (phone and Admin page).
- **A scraper failing** (reader down / back, a post that couldn't be checked) is **not a notification**
  (since 8 Oct): the free readers hiccup for a minute or two and recover on their own — FxTwitter
  answered 404 for X twice that day. It is shown on the **Admin page** (`#/admin`) instead: what is
  down, since when and why, plus the recent incidents. A channel that can't be read at the 20-min mark
  is retried every minute for 10 more minutes before its drop is reported, so a short hiccup changes
  nothing; FxTwitter's 404 is also retried at once.
- **The site itself down** → cron-job.org emails its owner after failed calls.

## Phone push (ntfy) — instant, free, no signup

Every alert Teams gets — plus the pipeline's own trouble — also goes out as a phone notification
through [ntfy](https://ntfy.sh), independent of WhatsApp, so alerts arrive even while CallMeBot is
slow or down.

1. Install **ntfy** (Play Store / App Store) → **+** → subscribe to your topic (a long random name —
   anyone who knows it can read the alerts, so do not use a guessable one).
2. Vercel → Environment Variables: `NTFY_TOPIC` = that same name. Redeploy.
3. Admin page → **Test alert**. Problems arrive as high-priority notifications; tapping one opens the Live page.

## Channels FM sends to that are not checked

(Instagram EN `sportsfc.fans` was here while the whole account was 18+; it is public again since ~9 Oct
2026 and checked like every other channel.)

| FM channel | Why | What happens |
|---|---|---|
| Viber (all 3 languages) | nothing can read Viber | FM's "sent" is taken as delivered (agreed exception) |
| X EN, X PT, TikTok EN, TikTok PT, Telegram PT, Telegram bot EN, Telegram bot PT | **the accounts don't exist yet** — FM sends, distribution drops it (2026-10-05) | ignored everywhere: no ledger entry, no alert, not on the Live page |

When one of those accounts is created: put it in `pipeline/channels.js` (mode `"verify"` with a `read`
entry) **and** in `SPORTSFC` in `src/engine/engine.js` — `test/pipeline.test.js` fails if they differ.

MatchPulse has no FM feed yet; when it does, it gets its own entry here.

## Matching rules

A post counts as the delivery's post when it is on the channel from 5 min before to 20 min after FM
sent it and shares **≥ 75%** of the caption's words; after 20 min (a late arrival) it must share
**≥ 90%** — one template used for two matches can share ~80% of its words (3 Oct: "The Full Verdict"
for Spain–Czechia and for Croatia–England). All of a channel's open deliveries (sent, not yet matched)
are matched against all of its posts at once, best pairs first — so a post goes to the card that made
it, even a caption-less one matched on time alone.

## Endpoints

- `GET /api/pipeline` — status. Everyone gets the public view (per delivery: channel, time, result,
  lag, post link, and `why` in plain words for a problem — no reader notes, logs or keys); the
  signed-in admin (`Authorization: Bearer …`, see README → Security) gets everything: health,
  readers, alerts, the error and check logs, what was sent.
- `GET /api/pipeline?op=tick` — run a tick now (`&fast=1`: answer at once, finish in the background)
- `GET /api/pipeline?op=test-alert` — admin only: one test alert on every configured channel (at most one per 10 min)
- `GET /api/pipeline?op=report&at=16:30[&day=2026-10-09]` — admin only: send that drop's full report
  again (at most once a minute)
- Optional `PIPELINE_KEY` env var: when set, `op=tick` needs `?key=…` (or the admin's session, or
  Vercel's cron) — add it to the cron-job.org URL and as the GitHub secret `PIPELINE_KEY`, or the clocks stop.

## Honest limits

- **X** is read through FxTwitter (free, community-run). It sometimes answers 404 for a minute or two;
  that is retried, and if it lasts, the last-chance paid read covers it. Its state is on the System
  health page.
- **CallMeBot** is a free personal service with no published limits; failed messages are retried for
  six ticks.
- **Telegram bot** reads need the user session (`TG_SESSION`); if Telegram logs it out, the bot channel
  shows as not readable on the Live page (System status) — re-run `tg-login.js`.
