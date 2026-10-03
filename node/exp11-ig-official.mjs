/* Round 5b — Instagram's OFFICIAL API for the 18+ account (and any account the team owns).
 *
 * sportsfc.fans is age-restricted, so nothing logged out can see it — not the embed, not Apify. But
 * the account's OWNER can read its own posts through Meta's "Instagram API with Instagram Login":
 * one login by the account owner gives a token (exchange it for the 60-day long-lived one, which can
 * be refreshed before it expires), and graph.instagram.com/me/media returns the account's posts with
 * exact timestamps, captions, permalinks and thumbnails. Free, official, no scraping, no Facebook
 * Page needed; the account must be a professional (Business or Creator) account.
 *
 * Put the token in this folder's .env (gitignored) — never in a commit, never in chat:
 *   IG_TOKEN_FANS=IGAA…
 * then:  node exp11-ig-official.mjs
 *
 * Read-only. Prints what the account's own API returns.
 */
import fs from "fs";
for (const line of (fs.existsSync("../.env") ? fs.readFileSync("../.env", "utf8") : "").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const tokens = Object.entries(process.env).filter(([k]) => /^IG_TOKEN_/.test(k));
if (!tokens.length) { console.log("No IG_TOKEN_* in ../.env — nothing to test yet (see the header for how to get one)."); process.exit(0); }

for (const [name, tok] of tokens) {
  console.log(`\n══ ${name}`);
  const me = await (await fetch(`https://graph.instagram.com/me?fields=user_id,username,account_type,media_count&access_token=${tok}`)).json();
  if (me.error) { console.log("  token refused:", me.error.message); continue; }
  console.log(`  @${me.username} · ${me.account_type} · ${me.media_count} posts`);
  const media = await (await fetch(`https://graph.instagram.com/me/media?fields=id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count&limit=12&access_token=${tok}`)).json();
  if (media.error) { console.log("  media refused:", media.error.message); continue; }
  for (const p of media.data || [])
    console.log(`  ${p.timestamp}  ${(p.media_product_type || p.media_type).padEnd(6)} likes ${String(p.like_count ?? "—").padStart(3)}  ${String(p.caption || "").replace(/\s+/g, " ").slice(0, 70)}`);
  /* refreshing the 60-day token (GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token)
     is deliberately NOT done here — this script only reads */
}
