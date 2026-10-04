/**
 * The pipeline's judgement, as pure functions — no I/O, so every rule is unit-tested
 * (test/pipeline.test.js).
 */

/* ── caption limits, checked the moment FM shows a card ─────────────────────
   X counts the way twitter-text v3 does: code points in these ranges weigh 1, everything else 2
   (an emoji, and many accented Vietnamese letters — ạ ố ộ ữ live outside the basic range), and every
   URL weighs 23 whatever its length. Measured on 2026-10-04: the Vietnamese "Triple Match Roundup"
   came to exactly 280 and never appeared on X; the Portuguese one was 305. */
const X_LIGHT = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
function xLength(text) {
  const s = String(text || "").replace(/https?:\/\/\S+/g, "\u0001".repeat(23));
  const graphemes = seg ? [...seg.segment(s)].map(x => x.segment) : [...s];
  let n = 0;
  for (const g of graphemes) {
    if (/\p{Extended_Pictographic}|⃣/u.test(g)) { n += 2; continue; }
    for (const ch of g) {
      const c = ch.codePointAt(0);
      n += c === 1 || X_LIGHT.some(([a, b]) => c >= a && c <= b) ? 1 : 2;
    }
  }
  return n;
}
const hashtags = text => (String(text || "").match(/#[\p{L}\p{N}_]+/gu) || []).length;

/* What each platform refuses. X's limit is the hard one; the others are the documented caps a
   caption must stay under (Telegram's applies to a media caption — every FM card carries a video). */
const CAPTION_RULES = {
  /* 270+ is flagged too: on 2026-10-04 a caption this counter put at exactly 280 never reached X */
  x:               t => { const n = xLength(t); return n > 280 ? `caption is ${n} characters by X's count — X allows 280`
                                                     : n >= 270 ? `caption is ${n} characters by X's count — right at X's 280 limit, may be rejected` : ""; },
  telegram:        t => { const n = [...String(t || "")].length; return n > 1024 ? `caption is ${n} characters — Telegram allows 1024 on a video` : ""; },
  telegram_direct: t => { const n = [...String(t || "")].length; return n > 1024 ? `caption is ${n} characters — Telegram allows 1024 on a video` : ""; },
  instagram:       t => { const n = [...String(t || "")].length, h = hashtags(t);
                          return n > 2200 ? `caption is ${n} characters — Instagram allows 2200` : h > 30 ? `${h} hashtags — Instagram allows 30` : ""; },
  tiktok:          t => { const n = [...String(t || "")].length; return n > 2200 ? `caption is ${n} characters — TikTok allows 2200` : ""; },
};
const captionProblem = (channel, caption) => (CAPTION_RULES[channel] ? CAPTION_RULES[channel](caption) : "");

/* ── matching a delivery to a post ──────────────────────────────────────────
   FM hands over the exact caption, so a post is matched on time AND words. Word containment
   (shared words / the shorter caption's words) tolerates a platform clipping a long caption or
   appending "see more"; on 2026-10-04 every real match scored 100% and different cards ~10–30%. */
const words = s => new Set(String(s || "").toLowerCase()
  .replace(/(…|\.\.\.)?\s*(see more|xem thêm|ver mais|more)\s*$/i, " ")     // a platform's own clip marker
  .replace(/https?:\/\/\S+/g, " ").replace(/[#@][\p{L}\p{N}_.]+/gu, " ")
  .replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter(w => w.length > 2));
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (A.size < 3 || B.size < 3) return null;                 // too little text to say anything
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
const MATCH_MIN = 0.5;
const EARLY_MIN = 5;          // a post up to 5 min before FM's send time still counts (clocks differ)

/* The best post for one delivery among `posts`, skipping ids already given to another delivery.
   A post with words must agree with the caption; a post with none (a reel some readers return bare)
   is matched on time alone, and only inside the normal window. */
function bestMatch(delivery, posts, used, windowMin, lateMin) {
  const sent = Date.parse(delivery.sentAt);
  let best = null;
  for (const p of posts) {
    if (used.has(p.externalId)) continue;
    const lag = (Date.parse(p.ts) - sent) / 60e3;
    if (!(lag >= -EARLY_MIN && lag <= lateMin)) continue;
    const sim = similarity(delivery.caption, p.text);
    if (sim !== null && sim < MATCH_MIN) continue;
    if (sim === null && lag > windowMin) continue;
    const score = (sim === null ? 0.6 : sim) - Math.abs(lag) / 1000;
    if (!best || score > best.score) best = { post: p, lag, sim, score };
  }
  return best;
}

module.exports = { xLength, captionProblem, similarity, bestMatch, MATCH_MIN };
