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
/* What X really gets is not FM's caption: distribution puts the card's short link and a blank line in
   front ("https://sfc.my/r/…\n\n") and X turns every "sportsfc.fans" into a link (23 each, not 13).
   Measured on 2026-10-09 against every X VN post of 4–9 Oct: this count equals X's own count of the
   post exactly (18 of 18), every caption over 280 by it never appeared (5 of 5), the longest that did
   was 277. Counting FM's caption alone came out 25–44 short — which is why 8 Oct 16:35 (285 as posted,
   251 by FM's text) and 9 Oct 14:30 (293 vs 249) went missing without a caption warning. */
const xPostedLength = caption =>
  xLength("https://sfc.my/r/XXXXXXXX\n\n" + String(caption || "").replace(/(?<![\w@\/.])sportsfc\.fans\b(\/\S*)?/gi, "https://sportsfc.fans"));
const hashtags = text => (String(text || "").match(/#[\p{L}\p{N}_]+/gu) || []).length;

/* What each platform refuses. X's limit is the hard one; the others are the documented caps a
   caption must stay under (Telegram's applies to a media caption — every FM card carries a video). */
const CAPTION_RULES = {
  /* counted as posted (above); 270+ is flagged as at the limit */
  x:               t => { const n = xPostedLength(t); return n > 280 ? `caption is ${n} characters by X's count as posted (with the link distribution adds) — X allows 280`
                                                     : n >= 270 ? `caption is ${n} characters by X's count as posted — right at X's 280 limit, may be rejected` : ""; },
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
  .replace(/(…|\.\.\.)?\s*(see more|xem thêm|ver mais|ver más|more)\s*$/i, " ")     // a platform's own clip marker
  .replace(/https?:\/\/\S+/g, " ").replace(/[#@][\p{L}\p{N}_.]+/gu, " ")
  /* a bare domain too: FM writes "SPORTSFC.FANS", the post shows "https://SPORTSFC.FANS" (dropped above)
     — counted on one side only it costs a short caption its match */
  .replace(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}-]+\.)+(?:fans|com|net|org|io|my|co|tv|app|me|gg|br|vn)\b\S*/giu, " ")
  .replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter(w => w.length > 2));
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (A.size < 3 || B.size < 3) return null;                 // too little text to say anything
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
/* Measured on 4 Oct 2026: two DIFFERENT cards of the same template family score up to 0.52 (they
   share "who wins", "prediction", the team names…); the same card scores 1.00, and 0.9+ when a
   platform clips it. 0.75 sits in the middle of that gap. */
const MATCH_MIN = 0.75;
/* A post more than the window after FM sent it must be the SAME card, near word for word: one template
   used for two matches ("The Full Verdict" at 16:30 for Spain–Czechia and at 18:25 for Croatia–England,
   3 Oct) shares 78% of its words — a later card must never pass for an earlier missing one. */
const MATCH_LATE_MIN = 0.9;
const EARLY_MIN = 5;          // a post up to 5 min before FM's send time still counts (clocks differ)

/* How well one post fits one delivery, or null if it cannot be that delivery's post. A post with
   words must agree with the caption; a post with none (a reel some readers return bare) is matched
   on time alone, and only inside the normal window. */
function pairScore(delivery, p, windowMin, lateMin) {
  const lag = (Date.parse(p.ts) - Date.parse(delivery.sentAt)) / 60e3;
  if (!(lag >= -EARLY_MIN && lag <= lateMin)) return null;
  const sim = similarity(delivery.caption, p.text);
  if (sim !== null && sim < (lag > windowMin ? MATCH_LATE_MIN : MATCH_MIN)) return null;
  if (sim === null && lag > windowMin) return null;
  return { post: p, lag, sim, score: (sim === null ? 0.6 : sim) - Math.abs(lag) / 1000 };
}

/* The best post for one delivery among `posts`, skipping ids already given to another delivery. */
function bestMatch(delivery, posts, used, windowMin, lateMin) {
  let best = null;
  for (const p of posts) {
    if (used.has(p.externalId)) continue;
    const m = pairScore(delivery, p, windowMin, lateMin);
    if (m && (!best || m.score > best.score)) best = m;
  }
  return best;
}

/* All of one channel's deliveries against all of its posts at once, best pairs first — so a post goes
   to the delivery it fits best, never to whichever delivery happened to be looked at first. */
function assign(deliveries, posts, used, windowMin, lateMin) {
  const pairs = [];
  for (const d of deliveries) for (const p of posts) {
    if (used.has(p.externalId)) continue;
    const m = pairScore(d, p, windowMin, lateMin);
    if (m) pairs.push({ d, ...m });
  }
  pairs.sort((a, b) => b.score - a.score);
  const out = new Map(), taken = new Set();
  for (const x of pairs) {
    if (out.has(x.d) || taken.has(x.post.externalId)) continue;
    out.set(x.d, x); taken.add(x.post.externalId);
  }
  return out;
}

module.exports = { xLength, xPostedLength, captionProblem, similarity, bestMatch, assign, MATCH_MIN, MATCH_LATE_MIN };
