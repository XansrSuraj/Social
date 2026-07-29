# Org Hub

One clean home for every organization's **websites** and **social media channels**.

Add an organization → attach unlimited websites and unlimited social channels to it → search
everything instantly. Editing is protected by a password, so visitors get a strictly read-only page.

**Live demo:** _(add your Vercel URL here after deploying)_

---

## Features

- **Unlimited per org** — any number of websites and any number of social channels per organization,
  including several pages on the same platform
- **Password-protected admin** — locked by default; without the password nothing can be added,
  edited or deleted. The password is stored only as a SHA-256 hash, never in plain text
- **Fully customizable** — site name, colour theme, light/dark mode, and your own social platforms
  with your own brand colours
- **Private by design** — all data lives in the visitor's own browser (`localStorage`). No account,
  no server, no tracking
- **JSON backup** — export and import everything with one click
- **Instant search** across org names, tags, notes, website labels, URLs, platforms and handles
- **Zero build step** — one `index.html` file. Open it locally or drop it on any static host

## Tech

Plain HTML, CSS and JavaScript — no framework, no bundler.

| Library | Use | Loaded from |
|---|---|---|
| [Lucide](https://lucide.dev) | UI icons | jsDelivr CDN |
| [Simple Icons](https://simpleicons.org) | brand logos (Facebook, Instagram, X…) | jsDelivr CDN |
| [GSAP](https://gsap.com) | entrance & micro animations | jsDelivr CDN |

Every library is optional — if a CDN is blocked the app still works, with text fallbacks
and no animations. `prefers-reduced-motion` is respected.

## Run locally

Just open `index.html` in a browser. No install, no server.

## Deploy

Any static host works. For Vercel:

1. Push this folder to a GitHub repository
2. On [vercel.com](https://vercel.com) → **Add New → Project** → import the repo
3. Framework preset: **Other**. Leave build command and output directory empty
4. **Deploy**

## Data & privacy

Data is stored in the visitor's browser under the `orghub.v1` key. It is per-browser and
per-device — it does not sync between devices, and it is never sent anywhere. Use
**Settings → Export** to back it up or move it to another machine.

> The admin password prevents casual editing in the browser. It is client-side only, so it is not
> protection against someone determined with developer tools. For multi-user accounts and real
> server-side security, the app needs a backend (see the roadmap below).

## Roadmap

- [ ] Cloud accounts + sync across devices (Supabase auth + Postgres)
- [ ] Public shareable org profile page (`/acme`)
- [ ] Team members with view / edit roles
- [ ] Link health checker (flag dead URLs)
- [ ] CSV / bulk import
- [ ] Logo upload per organization

## License

MIT
