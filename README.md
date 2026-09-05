# Aiko

Internal directory of every **official website** and **social media channel**, in one place.

Anyone on the team can open the URL and see everything. Only the admin — with the password stored
on the server — can add, edit or delete. Data lives in a shared database, so a phone, a laptop and
a teammate's browser all show the same thing.

---

## Features

- **Unlimited per organization** — any number of websites and social channels, including several
  pages on the same platform
- **Region and language, kept apart** — every channel carries a country *and* a language, because
  they are two different facts: Singapore runs four languages, Spanish runs across twenty
  countries. Channels cluster by **Region › Language** by default, and one click regroups them by
  platform or by language instead
- **Countries and languages come from a dataset, not a list you maintain** — 250 countries, the
  languages each one speaks, and its continent are fetched once and cached for a month. Choose
  Vietnam and the language fills itself in as Vietnamese; choose Thailand and it becomes Thai
- **Three-tier filtering** — area (continent) → region → language, each tier counting only what
  the tier above it left, so every number on a chip is what clicking it actually gives you
- **Shared cloud storage** — one Supabase row holds the whole directory; every device sees the same data
- **Server-verified admin password** — the password is a Vercel environment variable, never in the
  browser and never in the repo. Writes are rejected without it
- **Link health checker** — server-side HEAD/GET probe of every URL, with green / amber / red status
  dots, response time and reason. Auto-runs on stale results (1 h cache)
- **Logo auto-fetch** — the organization's logo is pulled from its website's domain automatically;
  override with a manual URL any time
- **QR code per organization** — scan to open that org's page, download as PNG for print
- **Embed widget** — one `<script>` tag renders a live, read-only list of an org's channels on any
  other website. Updates itself whenever the directory changes
- **Deep links** — `#/<org-id>` opens a specific organization
- **Customizable** — site name, 7 accent themes + custom colour, light/dark, and your own social
  platforms with your own brand colours
- **Survives an outage** — the last directory the cloud handed over is kept per browser, so if
  the database is unreachable the page still shows it, clearly labelled and read-only, instead of
  an empty screen that reads like everything was deleted. It retries by itself and recovers
  without a refresh
- **Daily snapshots** — a copy of the whole directory for each of the last seven days, written by
  the same nightly job, restorable from Settings
- **JSON export / import** for backups

## Stack

Static HTML + CSS + vanilla JS, plus five tiny Vercel serverless functions.
**No npm dependencies** — the API talks to Supabase over plain REST.

| | |
|---|---|
| `index.html` | the whole app |
| `api/data.js` | `GET` read state · `PUT` write state (needs `x-admin-key`) |
| `api/auth.js` | `POST` verify the admin password (constant-time compare) |
| `api/check.js` | `POST` link health probe |
| `api/keepalive.js` | `GET` nightly read that stops Supabase pausing the project, and writes that day's snapshot |
| `api/snapshots.js` | `GET` list the daily snapshots, or read one back |
| `embed.js` | the embeddable widget |

Front-end libraries load from a CDN and are all **optional** — if they're blocked the app still
works with text fallbacks: [Lucide](https://lucide.dev) (icons),
[Simple Icons](https://simpleicons.org) (brand logos), [GSAP](https://gsap.com) (animation),
[qrcodejs](https://github.com/davidshimjs/qrcodejs) (QR). `prefers-reduced-motion` is respected.

### The country / language catalog

Countries, their languages and their continents come from
[`countries-list`](https://www.npmjs.com/package/countries-list) on jsDelivr — three JSON files,
about 45 KB, fetched once and cached in `localStorage` for 30 days. No API key, nothing to
maintain, and three fallbacks behind it so the directory is never uneditable:

1. the cached copy, however old it is
2. `Intl.DisplayNames` — every modern browser can already name all ~250 regions and every
   language with no network at all; only the country⇒language mapping is missing, and a small
   built-in alias table covers the common markets
3. a short built-in language list

Flags are images from [flagcdn.com](https://flagcdn.com) with the ISO code underneath as the
fallback — **not** emoji, because Windows ships no country-flag glyphs and would render 🇻🇳 as
a bare "VN".

---

## Deploy

### 1 · Push to GitHub

```bash
git remote add origin https://github.com/<USERNAME>/org-hub.git
git push -u origin main
```

### 2 · Import into Vercel

[vercel.com](https://vercel.com) → **Add New → Project** → import the repo →
Framework preset **Other**, build command and output directory **empty** → **Deploy**.

It is live at this point and already usable — but data is still per-browser until step 3.

### 3 · Turn on shared storage (Supabase, free)

1. [supabase.com](https://supabase.com) → **New project**
2. **SQL Editor** → run:

   ```sql
   create table if not exists orghub_state (
     id int primary key,
     data jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );

   insert into orghub_state (id, data)
     values (1, '{"orgs":[]}'::jsonb)
     on conflict (id) do nothing;

   -- lock the table down: no policies means no public/anon access at all.
   -- only the server-side service_role key (which bypasses RLS) can read or write.
   alter table orghub_state enable row level security;
   ```

3. **Project Settings → API** → copy the **Project URL** and the **`service_role`** key
4. Vercel → **Project → Settings → Environment Variables** → add three:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | `https://xxxx.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | the `service_role` key |
   | `ADMIN_PASSWORD` | the password only you know |

5. **Deployments → ⋯ → Redeploy**

The header badge flips from **Local only** to **Cloud**. The in-app **Settings → Storage → Set up**
panel shows these same steps with a copy button for the SQL.

> Already added data before connecting the database? Settings shows **Upload to cloud** to move
> this browser's data up.

### Custom domain

Vercel → Settings → Domains → add your domain → copy the two DNS records into your registrar.
HTTPS is automatic.

## Embedding on another site

```html
<script src="https://YOUR-SITE.vercel.app/embed.js" data-org="ORG_ID"></script>
```

| Attribute | Effect |
|---|---|
| `data-theme="dark"` | dark colours |
| `data-show="social"` | only social channels (`"web"` = only websites) |
| `data-group="platform"` | one block per platform (`"region"` is the default, `"language"` also works) |
| `data-title="false"` | hide the organization name |

The widget mirrors the directory: a block per region with its languages banded inside. It needs
no catalog of its own — region names come from the browser's `Intl.DisplayNames`. An organization
with no regions filled in falls back to platform blocks by itself.

Grab the ready-made snippet from the **Embed** button on any organization.

## Security notes

- The Supabase `service_role` key and `ADMIN_PASSWORD` are **server-side only** — never sent to
  the browser, never committed. Keep them in Vercel env vars.
- Writes require the password on every request and are compared in constant time.
- Reads are public to anyone with the URL — that is intentional for an internal directory.
  If you need reads restricted too, put Vercel Password Protection or Vercel Authentication on
  the project (Settings → Deployment Protection).
- `noindex, nofollow` is set, so search engines skip it.
- Concurrent edits: the server rejects a save whose base version is stale (HTTP 409) and the app
  offers to reload, so two devices can't silently overwrite each other.
- If a save fails, the app says **Not saved** in the header and toasts the error — the change is
  still on screen but not stored. Retry once you're back online.

## Keeping the database awake

Supabase pauses a free project after ~7 days without activity. A paused project takes the whole
directory offline: `/api/data` cannot reach Postgres, the app falls back to browser storage, and
the header reads **Local only** over an empty page — which looks exactly like the data has been
deleted. It has not; restoring the project in the Supabase dashboard brings it all back.

Opening the site is not activity on its own. The page is static and only `/api/data` talks to
Postgres, so a week in which nobody happens to open the directory is a week of silence.

`api/keepalive.js` removes that dependency on somebody visiting. A Vercel cron calls it once a
day (`vercel.json`) and it makes the cheapest real query there is — one indexed row, one small
column, never the `data` column that holds the whole directory. Seven pings per pause window is
a wide margin.

It is a **read**, deliberately. A write would move `updated_at`, and the optimistic-concurrency
guard in `/api/data` compares against exactly that — a nightly write would hand a spurious
"changed on another device" conflict to anyone who happened to be mid-edit.

| | |
|---|---|
| Schedule | `0 6 * * *` — 06:00 UTC daily. Vercel's Hobby plan runs cron jobs once a day, which is all this needs |
| `CRON_SECRET` | optional. Set it and the endpoint requires `Authorization: Bearer <secret>`, which Vercel Cron sends automatically. Leave it unset and the endpoint stays open — it returns a timestamp and no data |
| Check it | `curl https://YOUR-SITE.vercel.app/api/keepalive` → `{"ok":true,"ms":…,"updatedAt":…}`. Vercel → Project → **Cron Jobs** shows the run history |

If you would rather not depend on this at all, [Upstash Redis](https://upstash.com) has no pause
and the same REST-only integration style.

## When the database is unreachable

An outage and "no database configured yet" used to look identical: **Local only** in the header
over an empty page, with a banner inviting you to connect a database. That is alarming and wrong —
the directory is in Postgres the whole time.

They are now separate states:

| | Badge | What the page shows |
|---|---|---|
| Configured, reachable | **Cloud** | the live directory |
| Configured, **unreachable** | **Database offline** (red) | the last copy this browser received, read-only, with a **Try again** button |
| Genuinely not configured | **Local only** | the setup banner, as before |

While offline the app **refuses to write anything** — admin cannot be unlocked and `persist()`
returns early. That is not caution for its own sake. Browser-storage edits made during an outage
would accumulate into a shadow directory, and Settings would later offer to **Upload to cloud** —
replacing the live directory with whatever was typed while the database was away. That upload is
now also refused outright whenever the browser holds fewer channels than the cloud.

Recovery needs no refresh: three retries with backoff on load, then a check every minute, on tab
focus, and on the `online` event.

## Restoring a snapshot

Settings → **Daily snapshots** lists what is available with each day's organization and channel
counts and how they differ from what is live. Restoring goes through the same authenticated `PUT`
as any other save, and the confirmation shows both sides before it overwrites anything.

The snapshots live in the same table as the live directory, under ids 101–107, one per weekday —
so today's copy overwrites this day last week and the window rotates itself with no cleanup and no
migration. `/api/data` only ever touches id 1, so it never sees them.

Two things worth knowing:

- The job **refuses to snapshot an empty directory**. A wipe is exactly what these exist to undo,
  and copying it over them nightly would destroy the only way back.
- It is a **seven-day rolling window**. A bad change that goes unnoticed for a week will have
  reached every slot. For anything you cannot afford to lose, take a JSON export as well.

## Local development

Open `index.html` directly — it falls back to browser storage, and features that need the server
(link check, cloud sync) say so. For the real thing: `npx vercel dev`.
