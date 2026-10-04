/**
 * The FM → channels pipeline (pipeline/*, api/pipeline.js), replayed on a real day: FM Deliveries
 * prod for 2026-10-04 (62 deliveries, sanitised) and what each watched channel actually showed.
 * Everything outside — FM, the readers, the store, WhatsApp, the clock — is stubbed, so the whole
 * tick runs here with no network.
 *
 *   node test/pipeline.test.js
 */
const fs = require("fs");
const path = require("path");
const { xLength, captionProblem, similarity, bestMatch } = require("../pipeline/rules.js");
const { FM_CHANNELS, routeOf } = require("../pipeline/channels.js");
const { tick } = require("../pipeline/tick.js");
const { mergeInto, Conflict } = require("../pipeline/store.js");
const { chunks, flush } = require("../pipeline/whatsapp.js");
const { xParseFx } = require("../api/collect.js");

let pass = 0, fail = 0;
const ok = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra !== undefined ? "  — " + extra : ""}`); };
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "fm-2026-10-04.json"), "utf8"));
const D = FX.deliveries;
const find = (ch, lang, card) => D.find(d => d.channel === ch && d.language === lang && d.template.label === card);

(async () => {
  console.log("── caption rules");
  const xPt = find("x", "portuguese", "Triple Match Roundup"), xVn = find("x", "vietnamese", "Triple Match Roundup");
  ok(xLength(xPt.caption) === 305, "the Portuguese X caption is 305 by X's count", xLength(xPt.caption));
  ok(/X allows 280/.test(captionProblem("x", xPt.caption)), "…and is flagged as too long");
  ok(/right at X's 280 limit/.test(captionProblem("x", xVn.caption)), "the Vietnamese one (280, never reached X) is flagged as at the limit", captionProblem("x", xVn.caption));
  ok(captionProblem("x", find("x", "english", "Attack vs Defense").caption) === "", "a normal X caption is not flagged");
  ok(xLength("https://sfc.my/r/abcdefghijklmnopqrstuvwxyz1234567890 hi") === 26, "a link counts 23 whatever its length");
  ok(xLength("🔥🔥") === 4 && xLength("ạ") === 2 && xLength("a") === 1, "emoji and accented Vietnamese weigh 2, plain letters 1");
  ok(/Telegram allows 1024/.test(captionProblem("telegram", "x".repeat(1100))), "a Telegram video caption over 1024 is flagged");
  ok(/30/.test(captionProblem("instagram", Array.from({ length: 31 }, (_, i) => "#t" + i).join(" "))), "31 Instagram hashtags are flagged");

  console.log("\n── matching");
  const a = find("youtube", "vietnamese", "Attack vs Defense");
  ok(similarity(a.caption, a.caption) === 1, "a caption matches itself fully");
  ok(similarity(a.caption, find("youtube", "vietnamese", "Triple Match Roundup").caption) < 0.5, "two different cards do not match");
  ok(similarity(a.caption, a.caption.slice(0, 120) + "… See more") >= 0.9, "a clipped caption with 'See more' still matches");
  const sent = Date.parse(a.sentAt);
  const posts = [{ externalId: "p1", ts: new Date(sent + 90e3).toISOString(), text: a.caption },
                 { externalId: "p2", ts: new Date(sent + 60e3).toISOString(), text: "something else entirely about another match tonight" }];
  const m = bestMatch(a, posts, new Set(), 20, 180);
  ok(m && m.post.externalId === "p1", "the post saying the same thing wins over a nearer unrelated one");
  ok(!bestMatch(a, posts, new Set(["p1"]), 20, 180), "a post already given to another delivery is not reused");
  ok(bestMatch(a, [{ externalId: "r", ts: new Date(sent + 120e3).toISOString(), text: "" }], new Set(), 20, 180), "a bare reel (no text) matches on time inside the window");
  ok(!bestMatch(a, [{ externalId: "r", ts: new Date(sent + 40 * 60e3).toISOString(), text: "" }], new Set(), 20, 180), "…but not 40 min later");

  console.log("\n── the channel map agrees with the daily check");
  const engine = fs.readFileSync(path.join(__dirname, "..", "src", "engine", "engine.js"), "utf8");
  for (const [k, v] of Object.entries(FM_CHANNELS)) if (v.read) {
    const line = engine.split("\n").find(l => l.includes(`id:"${v.read.id}"`));
    ok(line && line.includes(`"${v.read.url}"`), `${k} → ${v.read.id} is the same account the daily check reads`);
  }
  ok(routeOf("viber", "english").mode === "assume", "Viber is the one channel taken on FM's word");
  ok(routeOf("threads", "english").mode === "unwatched", "a platform FM adds later is 'not watched', not an error");

  console.log("\n── report merge");
  const rep = { posts: { "yt-vn": [{ externalId: "a", ts: new Date().toISOString(), views: 5, thumb: "t" }] }, meta: {}, confirms: { x: 1 } };
  const { report, added } = mergeInto(rep, [{ channelId: "yt-vn", ok: true, source: "youtube-api", posts: [{ externalId: "a", ts: new Date().toISOString(), views: 9, thumb: "" }, { externalId: "b", ts: new Date().toISOString() }] },
                                            { channelId: "fb-vn", ok: false, note: "boom" }], Date.now());
  ok(added === 1 && report.posts["yt-vn"].length === 2, "new posts are added, known ones refreshed");
  ok(report.posts["yt-vn"].find(p => p.externalId === "a").views === 9 && report.posts["yt-vn"].find(p => p.externalId === "a").thumb === "t",
     "a fresh counter wins, an empty field never wipes a filled one");
  ok(!report.meta["fb-vn"] && report.confirms.x === 1, "a failed read marks nothing; hand answers are kept");

  console.log("\n── WhatsApp batching");
  const long = Array.from({ length: 80 }, (_, i) => "line " + i + " " + "x".repeat(40)).join("\n");
  ok(chunks(long).length > 1 && chunks(long).every(c => c.length <= 1700), "a long message is split at line breaks", chunks(long).length + " parts");
  const sentMsgs = [];
  const f1 = await flush([{ kind: "a", text: "one" }, { kind: "b", text: "two" }], { send: async t => { if (t === "two") throw new Error("down"); sentMsgs.push(t); }, gapMs: 0 });
  ok(sentMsgs.join() === "one" && f1.left.length === 1 && f1.left[0].tries === 1, "a failed message stays in the outbox for the next tick");

  console.log("\n── X through FxTwitter");
  const fx = { results: [
    { id: "2", created_timestamp: 1759567080, text: "real post", author: { screen_name: "Sportsfcvn", name: "SportsFc" }, views: 7, likes: 0, replies: 0, reposts: 0,
      media: { all: [{ type: "video", duration: 47.8, thumbnail_url: "https://pbs.twimg.com/t.jpg" }] },
      raw_text: { facets: [{ type: "url", replacement: "https://sfc.my/r/abc" }, { type: "hashtag", original: "football" }] }, url: "https://x.com/Sportsfcvn/status/2" },
    { id: "3", created_timestamp: 1759567000, text: "RT", author: { screen_name: "Sportsfcvn" }, reposted_by: { screen_name: "Sportsfcvn" } },
    { id: "4", created_timestamp: 1759566000, text: "@someone hi", author: { screen_name: "Sportsfcvn" }, replying_to: "someone" },
  ] };
  const xp = xParseFx(fx, "Sportsfcvn");
  ok(xp.length === 1 && xp[0].externalId === "2" && xp[0].kind === "video" && xp[0].duration === 48, "a post is read; reposts and replies are dropped");
  ok(xp[0].link === "https://sfc.my/r/abc" && xp[0].thumb && xp[0].views === 7 && xp[0].hashtags.includes("football"), "link, cover, views and hashtags come through");

  console.log("\n── a whole tick, replayed on 2026-10-04");
  const mkStore = (ledger = {}) => {
    let row = { data: ledger, updatedAt: "v0" }, report = { data: { posts: {}, meta: {} } }, n = 0;
    return {
      get ledger() { return row.data; }, get report() { return report.data; },
      async lockLedger(owner) { if (row.data.lock && row.data.lock.until > Date.now()) return null;
        row = { data: { ...row.data, lock: { owner, until: Date.now() + 150000 } }, updatedAt: "v" + (++n) }; return { ledger: row.data, updatedAt: row.updatedAt }; },
      async saveLedger(led, base, release) { if (base !== row.updatedAt) throw new Conflict("x"); row = { data: release ? { ...led, lock: null } : led, updatedAt: "v" + (++n) }; },
      async mergeIntoReport(results, now) { const m = mergeInto(report.data, results, now); report.data = m.report; return { added: m.added }; },
    };
  };
  const at = iso => Date.parse(iso);
  const visibleAt = now => id => (FX.posts[id] || []).filter(p => Date.parse(p.ts) <= now);
  const mkCollect = (now, broken = []) => {
    const calls = [];
    const fn = async (channels, opts) => { calls.push({ ids: channels.map(c => c.id), noPaid: opts.noPaid });
      return { results: channels.map(c => broken.includes(c.id) ? { channelId: c.id, ok: false, note: "HTTP 429" }
                                                                : { channelId: c.id, ok: true, source: "stub", posts: visibleAt(now)(c.id) }) }; };
    fn.calls = calls; return fn;
  };
  const mkWa = () => { const out = []; return { out, flush: async (box) => { out.push(...box.map(m => m.text)); return { left: [], log: box.map(m => ({ ok: true, kind: m.kind })) }; } }; };
  const fmAt = now => async () => D.filter(d => Date.parse(d.queuedAt) <= now);

  /* the pipeline started in the morning; replay the evening at 21:00 IST */
  let now = at("2026-10-04T15:30:00Z");
  let st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wa = mkWa(), col = mkCollect(now);
  let r = await tick({ fm: fmAt(now), collect: col, store: st, wa, now, force: true });
  const E = Object.values(st.ledger.deliveries);
  const c = s => E.filter(e => e.status === s).length;
  ok(E.length === 62, "all 62 FM deliveries are in the ledger", E.length);
  ok(c("verified") === 34 && c("missing") === 1, "34 verified, 1 missing", `verified ${c("verified")}, missing ${c("missing")}`);
  ok(c("assumed") === 8 && c("unwatched") === 16 && c("unverifiable") === 3, "8 Viber assumed, 16 not watched yet, 3 Instagram 18+",
     `${c("assumed")}/${c("unwatched")}/${c("unverifiable")}`);
  const miss = E.find(e => e.status === "missing");
  ok(miss.channel === "x" && miss.language === "vietnamese" && miss.card === "Triple Match Roundup", "the missing one is X VN 10:30 — exactly what was found by hand");
  ok(E.filter(e => e.status === "verified").every(e => e.lag >= -5 && e.lag <= 20 && e.sim >= 50), "every verified delivery is inside 20 min with matching words");
  const msg = wa.out.join("\n");
  ok(/Missing\* — X VN · 10:30 "Triple Match Roundup"/.test(msg), "WhatsApp says X VN 10:30 is missing");
  ok(/Caption too long\* — X PT · 10:30/.test(msg), "…and that the Portuguese X caption is too long");
  ok(/Drop delivered\* — 18:30 "Attack vs Defense"/.test(msg) && /Drop with problems\* — 10:30/.test(msg), "…with a summary per drop: 18:30 clean, 10:30 with problems");
  ok(!/@/.test(JSON.stringify(Object.values(st.ledger.deliveries).map(e => e.publishedBy))), "no editor email is stored");
  ok(col.calls.length === 1 && col.calls[0].noPaid === true, "one batched read, free readers only", JSON.stringify(col.calls.map(x => x.ids.length)));
  ok(Object.keys(st.report.posts).length === 13 && st.report.autoAt, "what was read is merged into the daily-check report");

  /* a second tick a few minutes later: nothing new to say, nothing re-sent */
  const before = wa.out.length;
  now += 6 * 60e3;
  r = await tick({ fm: fmAt(now), collect: mkCollect(now), store: st, wa, now });
  ok(wa.out.length === before, "the next tick repeats no alert", wa.out.length - before);

  /* a fresh pipeline the same evening: everything older than 3 h is filed quietly — no flood */
  now = at("2026-10-04T15:30:00Z");
  st = mkStore(); wa = mkWa();
  await tick({ fm: fmAt(now), collect: mkCollect(now), store: st, wa, now, force: true });
  ok(!/10:30/.test(wa.out.join("\n")), "a brand-new pipeline does not alert about the morning", wa.out.length + " message(s)");

  /* live: 18:30 IST drop, read 7 min after — verified, no summary yet (window still open) */
  now = at("2026-10-04T13:07:00Z");
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }); wa = mkWa();
  await tick({ fm: fmAt(now), collect: mkCollect(now), store: st, wa, now, force: true });
  const evening = Object.values(st.ledger.deliveries).filter(e => e.card === "Attack vs Defense" && e.mode === "verify");
  ok(evening.length === 13 && evening.every(e => e.status === "verified"), "7 min after the 18:30 drop all 13 checked channels are already verified",
     evening.map(e => e.status).join(","));
  ok(!/18:30 "Attack vs Defense"/.test(wa.out.join("\n")), "…but its summary waits until the 20-min window closes");
  now = at("2026-10-04T13:22:00Z");
  await tick({ fm: fmAt(now), collect: mkCollect(now), store: st, wa, now });
  ok(/Drop delivered\* — 18:30 "Attack vs Defense"/.test(wa.out.join("\n")), "…and is sent once it does");

  /* a broken reader: Facebook VN refuses twice — reader-down alert, not a false "missing" */
  now = at("2026-10-04T13:05:00Z");
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }); wa = mkWa();
  await tick({ fm: fmAt(now), collect: mkCollect(now, ["fb-vn"]), store: st, wa, now, force: true });
  now = at("2026-10-04T13:25:00Z");
  await tick({ fm: fmAt(now), collect: mkCollect(now, ["fb-vn"]), store: st, wa, now });
  const fbv = Object.values(st.ledger.deliveries).find(e => e.chId === "fb-vn" && e.card === "Attack vs Defense");
  ok(fbv.status === "reader_failed" && /Reader down\* — fb-vn/.test(wa.out.join("\n")), "a broken reader is reported as such, never as a missing post", fbv.status);
  ok(!/Missing\* — Facebook VN · 18:30/.test(wa.out.join("\n")), "…and Facebook VN 18:30 is not called missing");

  /* FM failed / stuck */
  now = at("2026-10-04T13:20:00Z");
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }); wa = mkWa();
  const twisted = D.map(d => d.channel === "youtube" && d.language === "english" && d.template.label === "Attack vs Defense"
    ? { ...d, state: "failed", failureStage: "fm", error: "upload rejected" }
    : d.channel === "telegram" && d.language === "english" && d.template.label === "Attack vs Defense" ? { ...d, state: "queued", sentAt: null } : d);
  await tick({ fm: async () => twisted.filter(d => Date.parse(d.queuedAt) <= now), collect: mkCollect(now), store: st, wa, now, force: true });
  ok(/FM failed\* — YouTube EN · 18:30 "Attack vs Defense" — stage: fm — upload rejected/.test(wa.out.join("\n")), "an FM failure is alerted with its stage and error");
  ok(/Stuck in FM\* — Telegram EN · scheduled 18:30/.test(wa.out.join("\n")), "a card still queued 15+ min after its time is alerted");

  /* FM unreachable for 15+ min */
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z"), fm: { failingSince: at("2026-10-04T13:00:00Z") } }); wa = mkWa();
  now = at("2026-10-04T13:20:00Z");
  await tick({ fm: async () => { throw new Error("HTTP 503"); }, collect: mkCollect(now), store: st, wa, now, force: true });
  ok(/FM Deliveries feed unreachable\* for 20 min/.test(wa.out.join("\n")), "an unreachable FM feed is alerted after 15 min");
  ok(st.ledger.lock === null, "the ledger is unlocked after every tick");

  /* WhatsApp not set up for hours: the queue does not grow into a flood */
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z"), outbox: [{ at: at("2026-10-04T08:00:00Z"), kind: "slot", text: "old" }] }); wa = mkWa();
  now = at("2026-10-04T15:30:00Z");
  await tick({ fm: fmAt(now), collect: mkCollect(now), store: st, wa, now, force: true });
  ok(!wa.out.includes("old"), "a message stuck for 3+ hours is dropped, not sent late");

  /* phone push (ntfy) goes out at once, beside WhatsApp — and marks a problem as one */
  const pushed = [];
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") });
  wa = { ...mkWa(), pushConfigured: () => true, push: async (text, o) => { pushed.push({ text, problem: o.problem }); } };
  now = at("2026-10-04T15:30:00Z");
  await tick({ fm: fmAt(now), collect: mkCollect(now), store: st, wa, now, force: true });
  ok(pushed.length === 1 && pushed[0].problem && /Missing\* — X VN/.test(pushed[0].text), "the same alert is pushed to the phone, flagged as a problem");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
