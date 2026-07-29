# Aiko

Internal directory of every **official website** and **social media channel**, in one place.

Anyone on the team can open the URL and see everything. Only the admin — with the password stored
on the server — can add, edit or delete. Data lives in a shared database, so a phone, a laptop and
a teammate's browser all show the same thing.

---

## Features

- **Unlimited per organization** — any number of websites and social channels, including several
  pages on the same platform
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
- **JSON export / import** for backups

## Stack

Static HTML + CSS + vanilla JS, plus three tiny Vercel serverless functions.
**No npm dependencies** — the API talks to Supabase over plain REST.

| | |
|---|---|
| `index.html` | the whole app |
| `api/data.js` | `GET` read state · `PUT` write state (needs `x-admin-key`) |
| `api/auth.js` | `POST` verify the admin password (constant-time compare) |
| `api/check.js` | `POST` link health probe |
| `embed.js` | the embeddable widget |

Front-end libraries load from a CDN and are all **optional** — if they're blocked the app still
works with text fallbacks: [Lucide](https://lucide.dev) (icons),
[Simple Icons](https://simpleicons.org) (brand logos), [GSAP](https://gsap.com) (animation),
[qrcodejs](https://github.com/davidshimjs/qrcodejs) (QR). `prefers-reduced-motion` is respected.

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
| `data-title="false"` | hide the organization name |

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

## Free-tier caveat

Supabase pauses a free project after ~7 days with no activity; open the Supabase dashboard to
resume it. A directory in daily use never hits this. If it becomes annoying,
[Upstash Redis](https://upstash.com) has no pause and the same REST-only integration style.

## Local development

Open `index.html` directly — it falls back to browser storage, and features that need the server
(link check, cloud sync) say so. For the real thing: `npx vercel dev`.
