/**
 * The channels each brand's daily check reads, and the shared report row it is kept in — the server's
 * own copy of SPORTSFC / MATCHPULSE in src/engine/engine.js (test/directory.test.js fails the moment
 * the two differ, so add a channel in both).
 *
 * Why the server keeps its own copy: "Run everything" is open to the content team without signing in
 * (api/collect.js, teamRun). Such a run reads exactly these channels and nothing a caller sends — so
 * the button can never be pointed at another account, or at the Apify credit — and the server writes
 * the result into the brand's report itself, so the browser never writes the shared row.
 */
module.exports = {
  sportsfc: {
    name: "SportsFC", row: 3,
    channels: [
      { id: "yt-vn",     platform: "youtube",   url: "https://youtube.com/@SportsFC-vn",           handle: "@SportsFC-vn",   ytChannelId: "UCOn89EhBv7qavXWvXFKw1FA" },
      { id: "yt-fans",   platform: "youtube",   url: "https://youtube.com/@sportsfc_fans",         handle: "@sportsfc_fans", ytChannelId: "UCbqnwmEMgqGH2WQ-UpbX2lA" },
      { id: "tg-vn",     platform: "telegram",  url: "https://t.me/sportsfc_vn",                   handle: "sportsfc_vn" },
      { id: "tg-fans",   platform: "telegram",  url: "https://t.me/sportsfc_fans",                 handle: "sportsfc_fans" },
      { id: "x-vn",      platform: "x",         url: "https://x.com/Sportsfcvn",                   handle: "Sportsfcvn" },
      { id: "fb-vn",     platform: "facebook",  url: "https://facebook.com/sportsfc.vn",           handle: "sportsfc.vn" },
      { id: "fb-fans",   platform: "facebook",  url: "https://facebook.com/Sportsfc.fans",         handle: "Sportsfc.fans" },
      { id: "ig-vn",     platform: "instagram", url: "https://instagram.com/sportsfc.vn",          handle: "sportsfc.vn" },
      { id: "ig-fans",   platform: "instagram", url: "https://instagram.com/sportsfc.fans",        handle: "sportsfc.fans" },
      { id: "tt-vn",     platform: "tiktok",    url: "https://www.tiktok.com/@sportsfc.vn",        handle: "sportsfc.vn" },
      { id: "fb-br",     platform: "facebook",  url: "https://www.facebook.com/sportsfc.br",       handle: "sportsfc.br" },
      { id: "ig-br",     platform: "instagram", url: "https://www.instagram.com/sportsfc.br",      handle: "sportsfc.br" },
      { id: "yt-br",     platform: "youtube",   url: "https://www.youtube.com/@sfc-br",            handle: "@sfc-br",        ytChannelId: "UCR6OeH8jO7RMFDkx0Rfdv0w" },
      { id: "fb-mx",     platform: "facebook",  url: "https://www.facebook.com/sportsfc.mx",       handle: "sportsfc.mx" },
      { id: "ig-mx",     platform: "instagram", url: "https://www.instagram.com/sportsfc.mx",      handle: "sportsfc.mx" },
      { id: "yt-mx",     platform: "youtube",   url: "https://www.youtube.com/@Sfc-mx",            handle: "@Sfc-mx",        ytChannelId: "UCX1LbsSKkJdL7Y4NZfFkPWQ" },
      { id: "tg-bot-vn", platform: "tgbot",     url: "https://t.me/SportsfcBot",                   handle: "SportsfcBot" },
    ],
  },
  matchpulse: {
    name: "MatchPulse", row: 4,
    channels: [
      { id: "mp-fb-hi", platform: "facebook",  url: "https://www.facebook.com/MPXI.Hindi",          handle: "MPXI.Hindi" },
      { id: "mp-ig-hi", platform: "instagram", url: "https://www.instagram.com/matchpulse.hindi.ai", handle: "matchpulse.hindi.ai" },
      { id: "mp-tg-hi", platform: "telegram",  url: "https://t.me/matchpulseaihindi",               handle: "matchpulseaihindi" },
      { id: "mp-yt-hi", platform: "youtube",   url: "https://www.youtube.com/@MPHindi.Cricket",     handle: "@MPHindi.Cricket",    ytChannelId: "UCr0CGnO3uuE72mXXkZzmwRw" },
      { id: "mp-fb-en", platform: "facebook",  url: "https://www.facebook.com/ai.matchpulse",       handle: "ai.matchpulse" },
      { id: "mp-ig-en", platform: "instagram", url: "https://www.instagram.com/matchpulse.ai",      handle: "matchpulse.ai" },
      { id: "mp-tg-en", platform: "telegram",  url: "https://t.me/matchpulseai",                    handle: "matchpulseai" },
      { id: "mp-tt-en", platform: "tiktok",    url: "https://www.tiktok.com/@matchpulse.ai",        handle: "matchpulse.ai" },
      { id: "mp-yt-en", platform: "youtube",   url: "https://www.youtube.com/@matchpulse-ai",       handle: "@matchpulse-ai",      ytChannelId: "UCrrDEGwmgVH4qHbefFDmeSQ" },
    ],
  },
};
