/**
 * Which real account each FM Deliveries (channel, language) pair lands on.
 *
 * FM names a delivery by platform + language ("x" + "vietnamese"); the account it reaches is not in
 * the feed. This table is that link. The `read` entries are the same channels the daily check reads
 * (src/engine/engine.js → SPORTSFC; test/pipeline.test.js fails if the two drift apart).
 *
 *   mode "verify"       read the account and confirm the post appeared
 *   mode "assume"       Viber: no way to read it at all, so FM's own "sent" is taken as delivered
 *                        (the one agreed exception — 2026-10-04)
 *   soft: true          read it on every drop, but a read that fails is "can't be checked", never an
 *                        alert — for an account that can't be read at all for a while (sportsfc.fans was,
 *                        while the whole account was 18+, until ~9 Oct 2026). None is soft now.
 *   mode "skip"         the account does not exist yet: FM sends here and distribution drops it
 *                        (2026-10-05). Ignored everywhere — no ledger entry, no alert, not on the
 *                        Live page. When the account is created: add `read`, mode "verify".
 *   mode "unwatched"    an FM pair not in this table at all (a platform FM adds later)
 */

const FM_CHANNELS = {
  /* ── Vietnamese ── */
  "youtube/vietnamese":         { mode: "verify", read: { id: "yt-vn", platform: "youtube", url: "https://youtube.com/@SportsFC-vn", handle: "@SportsFC-vn", ytChannelId: "UCOn89EhBv7qavXWvXFKw1FA" } },
  "telegram/vietnamese":        { mode: "verify", read: { id: "tg-vn", platform: "telegram", url: "https://t.me/sportsfc_vn", handle: "sportsfc_vn" } },
  "telegram_direct/vietnamese": { mode: "verify", read: { id: "tg-bot-vn", platform: "tgbot", url: "https://t.me/SportsfcBot", handle: "SportsfcBot" } },
  "x/vietnamese":               { mode: "verify", read: { id: "x-vn", platform: "x", url: "https://x.com/Sportsfcvn", handle: "Sportsfcvn" } },
  "facebook/vietnamese":        { mode: "verify", read: { id: "fb-vn", platform: "facebook", url: "https://facebook.com/sportsfc.vn", handle: "sportsfc.vn" } },
  "instagram/vietnamese":       { mode: "verify", read: { id: "ig-vn", platform: "instagram", url: "https://instagram.com/sportsfc.vn", handle: "sportsfc.vn" } },
  "tiktok/vietnamese":          { mode: "verify", read: { id: "tt-vn", platform: "tiktok", url: "https://www.tiktok.com/@sportsfc.vn", handle: "sportsfc.vn" } },
  "viber/vietnamese":           { mode: "assume" },

  /* ── English ── */
  "youtube/english":            { mode: "verify", read: { id: "yt-fans", platform: "youtube", url: "https://youtube.com/@sportsfc_fans", handle: "@sportsfc_fans", ytChannelId: "UCbqnwmEMgqGH2WQ-UpbX2lA" } },
  "telegram/english":           { mode: "verify", read: { id: "tg-fans", platform: "telegram", url: "https://t.me/sportsfc_fans", handle: "sportsfc_fans" } },
  "facebook/english":           { mode: "verify", read: { id: "fb-fans", platform: "facebook", url: "https://facebook.com/Sportsfc.fans", handle: "Sportsfc.fans" } },
  "instagram/english":          { mode: "verify", read: { id: "ig-fans", platform: "instagram", url: "https://instagram.com/sportsfc.fans", handle: "sportsfc.fans" } },
  "viber/english":              { mode: "assume" },
  "x/english":                  { mode: "skip", why: "the account isn't created yet — FM sends, distribution drops it" },
  "tiktok/english":             { mode: "skip", why: "the account isn't created yet — FM sends, distribution drops it" },
  "telegram_direct/english":    { mode: "skip", why: "the account isn't created yet — FM sends, distribution drops it" },

  /* ── Portuguese (Brazil) ── */
  "youtube/portuguese":         { mode: "verify", read: { id: "yt-br", platform: "youtube", url: "https://www.youtube.com/@sfc-br", handle: "@sfc-br", ytChannelId: "UCR6OeH8jO7RMFDkx0Rfdv0w" } },
  "facebook/portuguese":        { mode: "verify", read: { id: "fb-br", platform: "facebook", url: "https://www.facebook.com/sportsfc.br", handle: "sportsfc.br" } },
  "instagram/portuguese":       { mode: "verify", read: { id: "ig-br", platform: "instagram", url: "https://www.instagram.com/sportsfc.br", handle: "sportsfc.br" } },
  "viber/portuguese":           { mode: "assume" },
  "x/portuguese":               { mode: "skip", why: "the account isn't created yet — FM sends, distribution drops it" },
  "tiktok/portuguese":          { mode: "skip", why: "the account isn't created yet — FM sends, distribution drops it" },
  "telegram/portuguese":        { mode: "skip", why: "the account isn't created yet — FM sends, distribution drops it" },
  "telegram_direct/portuguese": { mode: "skip", why: "the account isn't created yet — FM sends, distribution drops it" },

  /* ── Spanish (Mexico) — FM's key is "spanish-mx" (added 2026-11-12) ── */
  "youtube/spanish-mx":         { mode: "verify", read: { id: "yt-mx", platform: "youtube", url: "https://www.youtube.com/@Sfc-mx", handle: "@Sfc-mx", ytChannelId: "UCX1LbsSKkJdL7Y4NZfFkPWQ" } },
  "facebook/spanish-mx":        { mode: "verify", read: { id: "fb-mx", platform: "facebook", url: "https://www.facebook.com/sportsfc.mx", handle: "sportsfc.mx" } },
  "instagram/spanish-mx":       { mode: "verify", read: { id: "ig-mx", platform: "instagram", url: "https://www.instagram.com/sportsfc.mx", handle: "sportsfc.mx" } },
  "viber/spanish-mx":           { mode: "assume" },
  "x/spanish-mx":               { mode: "skip", why: "no Mexico account given to the dashboard yet — not checked" },
  "tiktok/spanish-mx":          { mode: "skip", why: "no Mexico account given to the dashboard yet — not checked" },
  "telegram/spanish-mx":        { mode: "skip", why: "no Mexico account given to the dashboard yet — not checked" },
  "telegram_direct/spanish-mx": { mode: "skip", why: "no Mexico account given to the dashboard yet — not checked" },
};

const PLATFORM_NAME = { youtube: "YouTube", telegram: "Telegram", telegram_direct: "Telegram bot", x: "X", facebook: "Facebook",
  instagram: "Instagram", tiktok: "TikTok", viber: "Viber", threads: "Threads", whatsapp: "WhatsApp" };
const LANG_SHORT = { vietnamese: "VN", english: "EN", portuguese: "PT", "spanish-mx": "MX", hindi: "HI", thai: "TH" };

/* an FM pair not in the table at all (a platform added in the CMS later) is "unwatched", not an error */
const routeOf = (channel, language) =>
  FM_CHANNELS[`${channel}/${language}`] || { mode: "unwatched", why: `${channel}/${language} is new in FM — not configured here yet` };
const labelOf = (channel, language) =>
  `${PLATFORM_NAME[channel] || channel} ${LANG_SHORT[language] || String(language || "").slice(0, 2).toUpperCase()}`;

module.exports = { FM_CHANNELS, routeOf, labelOf, PLATFORM_NAME };
