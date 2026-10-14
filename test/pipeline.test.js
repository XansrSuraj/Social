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
const { xLength, xPostedLength, captionProblem, similarity, bestMatch } = require("../pipeline/rules.js");
const { FM_CHANNELS, routeOf } = require("../pipeline/channels.js");
const { tick } = require("../pipeline/tick.js");
const { mergeInto, Conflict } = require("../pipeline/store.js");
const { chunks, flush } = require("../pipeline/whatsapp.js");
const { xParseFx } = require("../api/collect.js");

let pass = 0, fail = 0;
const ok = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra !== undefined ? "  — " + extra : ""}`); };
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "fm-2026-10-04.json"), "utf8"));
const D = FX.deliveries;
/* Most checks below read every drop report's text, so they run with every report sent (the old rule);
   the rule production runs — problems and the day's summary only — is checked on its own near the end. */
process.env.PIPELINE_NOTIFY = "all";
/* Instagram EN (sportsfc.fans) was 18+ on 4 Oct, so the fixture has no read of it; it is public since ~9 Oct
   and checked like every other channel — its posts stand in here, each 90 s after FM sent it */
FX.posts["ig-fans"] = D.filter(d => d.channel === "instagram" && d.language === "english")
  .map((d, i) => ({ externalId: "igf" + i, ts: new Date(Date.parse(d.sentAt) + 90e3).toISOString(), text: d.caption }));
const find = (ch, lang, card) => D.find(d => d.channel === ch && d.language === lang && d.template.label === card);

(async () => {
  console.log("── caption rules");
  const xPt = find("x", "portuguese", "Triple Match Roundup"), xVn = find("x", "vietnamese", "Triple Match Roundup");
  ok(xLength(xPt.caption) === 305, "the Portuguese X caption is 305 by X's count", xLength(xPt.caption));
  ok(/X allows 280/.test(captionProblem("x", xPt.caption)), "…and is flagged as too long");
  ok(xLength(xVn.caption) === 280 && /X allows 280/.test(captionProblem("x", xVn.caption)),
     "the Vietnamese one (280 by FM's text, never reached X) is flagged as too long — 315 as posted", captionProblem("x", xVn.caption));
  /* every X VN caption of 4–9 Oct: counted as posted (short link in front, sportsfc.fans as a link) the
     count equals X's own count of the post, and it alone tells which ones X refused */
  {
    const XR = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "x-vn-2026-10.json"), "utf8")).rows;
    const posted = XR.filter(x => x.posted), refused = XR.filter(x => !x.posted);
    ok(posted.every(x => xPostedLength(x.caption) === x.xCountOfPost), "the as-posted count equals X's own count of every post that appeared",
       posted.filter(x => xPostedLength(x.caption) !== x.xCountOfPost).length + " differ");
    ok(refused.length >= 5 && refused.every(x => xPostedLength(x.caption) > 280) && posted.every(x => xPostedLength(x.caption) <= 280),
       "every caption X refused is over 280 as posted, every one it took is not", refused.map(x => xPostedLength(x.caption)).join(","));
    ok(refused.every(x => /X allows 280/.test(captionProblem("x", x.caption))) && posted.every(x => !/X allows 280/.test(captionProblem("x", x.caption))),
       "…so the caption warning names exactly the ones that went missing (8 Oct 16:35 and 9 Oct 14:30 were missed before)");
  }
  ok(captionProblem("x", find("x", "english", "Attack vs Defense").caption) === "", "a normal X caption is not flagged");
  ok(xLength("https://sfc.my/r/abcdefghijklmnopqrstuvwxyz1234567890 hi") === 26, "a link counts 23 whatever its length");
  ok(xLength("🔥🔥") === 4 && xLength("ạ") === 2 && xLength("a") === 1, "emoji and accented Vietnamese weigh 2, plain letters 1");
  ok(/Telegram allows 1024/.test(captionProblem("telegram", "x".repeat(1100))), "a Telegram video caption over 1024 is flagged");
  ok(/30/.test(captionProblem("instagram", Array.from({ length: 31 }, (_, i) => "#t" + i).join(" "))), "31 Instagram hashtags are flagged");

  console.log("\n── matching");
  const a = find("youtube", "vietnamese", "Attack vs Defense");
  ok(similarity(a.caption, a.caption) === 1, "a caption matches itself fully");
  ok(similarity(a.caption, find("youtube", "vietnamese", "Triple Match Roundup").caption) < 0.5, "two different cards do not match");
  ok(similarity(find("instagram", "english", "The Full Verdict").caption, find("instagram", "english", "Attack vs Defense").caption) < 0.75,
     "…not even two cards of the same family that share many words (0.52)");
  ok(similarity(a.caption, a.caption.slice(0, 120) + "… See more") >= 0.9, "a clipped caption with 'See more' still matches");
  const sent = Date.parse(a.sentAt);
  const posts = [{ externalId: "p1", ts: new Date(sent + 90e3).toISOString(), text: a.caption },
                 { externalId: "p2", ts: new Date(sent + 60e3).toISOString(), text: "something else entirely about another match tonight" }];
  const m = bestMatch(a, posts, new Set(), 20, 180);
  ok(m && m.post.externalId === "p1", "the post saying the same thing wins over a nearer unrelated one");
  ok(!bestMatch(a, posts, new Set(["p1"]), 20, 180), "a post already given to another delivery is not reused");
  ok(bestMatch(a, [{ externalId: "r", ts: new Date(sent + 120e3).toISOString(), text: "" }], new Set(), 20, 180), "a bare reel (no text) matches on time inside the window");
  ok(!bestMatch(a, [{ externalId: "r", ts: new Date(sent + 40 * 60e3).toISOString(), text: "" }], new Set(), 20, 180), "…but not 40 min later");
  /* 3 Oct, Instagram VN: "The Full Verdict" for Spain–Czechia (16:30) and for Croatia–England (18:25)
     share 78% of their words. The later card's post must never pass as the earlier one arriving late. */
  const fv1 = { sentAt: "2026-10-03T11:00:00Z", caption: "Tây Ban Nha có thể khuất phục được Séc? 🔥 📊 SPORTSFC.FANS 🏆 UEFA Nations League 📅 Sat 03 Oct 2026 🕘 9:30 pm ICT 📍 Estadio 🔮 Tây Ban Nha có 62% cơ hội giành chiến thắng ⚽ 43% khả năng cả hai đội cùng ghi bàn 📈 72% khả năng trận đấu có trên 2,5 bàn thắng 👉 Xem ngay dự đoán và thống kê chi tiết tại sportsfc.fans" };
  const fv2 = { externalId: "later", ts: "2026-10-03T12:56:00Z", text: "Croatia có thể khuất phục được Anh trên sân Stadion HNK Rijeka? 🔥 📊 SPORTSFC.FANS 🏆 UEFA Nations League 📅 Sat 03 Oct 2026 🕘 11:00 pm ICT 📍 Stadion HNK Rijeka 🔮 Croatia có 41% cơ hội giành chiến thắng ⚽ 52% khả năng cả hai đội cùng ghi bàn 📈 64% khả năng trận đấu có dưới 2,5 bàn thắng 👉 Xem ngay dự đoán và thống kê chi tiết tại sportsfc.fans" };
  ok(similarity(fv1.caption, fv2.text) >= 0.75 && !bestMatch(fv1, [fv2], new Set(), 20, 180),
     "the same template for a different match, 2 h later, is NOT taken as a late arrival", similarity(fv1.caption, fv2.text).toFixed(2));
  ok(bestMatch(fv1, [{ externalId: "same", ts: "2026-10-03T12:00:00Z", text: fv1.caption }], new Set(), 20, 180),
     "…while the same card really arriving 60 min late still is");

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

  /* FxTwitter answering 404 for a moment (8 Oct) is asked again before the read is given up */
  {
    const realFetch = global.fetch;
    const fresh = { results: [{ ...fx.results[0], created_timestamp: Math.floor(Date.now() / 1000) - 3600 }] };
    let calls = 0;
    global.fetch = async (url, opts) => {
      if (/api\.fxtwitter\.com/.test(String(url))) { calls++; return calls === 1 ? new Response("not found", { status: 404 }) : new Response(JSON.stringify(fresh), { status: 200 }); }
      return realFetch(url, opts);
    };
    let r;
    try { r = (await require("../api/collect.js").collectChannels([{ id: "x-vn", platform: "x", url: "https://x.com/Sportsfcvn", handle: "Sportsfcvn" }], { hours: 48, noPaid: true })).results[0]; }
    finally { global.fetch = realFetch; }
    ok(calls === 2 && r.ok && r.source === "x-free" && r.posts.length === 1, "a 404 from FxTwitter is asked again — the read goes through",
       `${calls} call(s), ${r.ok ? r.source : r.note}`);
  }

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
    const fn = async (channels, opts) => { calls.push({ ids: channels.map(c => c.id), noPaid: opts.noPaid, fresh: opts.fresh });
      return { results: channels.map(c => broken.includes(c.id) ? { channelId: c.id, ok: false, note: "HTTP 429" }
        : !FX.posts[c.id] ? { channelId: c.id, ok: false, note: "free read failed (no posts found on the page)" }
        : { channelId: c.id, ok: true, source: "stub", posts: visibleAt(now)(c.id) }) }; };
    fn.calls = calls; return fn;
  };
  const mkWa = () => { const out = []; return { out, flush: async (box) => { out.push(...box.map(m => m.text)); return { left: [], log: box.map(m => ({ ok: true, kind: m.kind })) }; } }; };
  const fmAt = now => async () => D.filter(d => Date.parse(d.queuedAt) <= now);

  /* the pipeline started in the morning; replay the evening at 21:00 IST */
  let now = at("2026-10-04T15:30:00Z");
  let st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wa = mkWa(), col = mkCollect(now);
  let r = await tick({ fm: fmAt(now), collect: col, store: st, wa, now, force: true });
  ok(!/Missing\*/.test(wa.out.join("\n")) && Object.values(st.ledger.deliveries).some(e => e.absent === 1 && e.status === "waiting"),
     "one read without the post is not enough to call it missing");
  /* …the post must be absent from two reads a minute apart */
  now += 60e3;
  r = await tick({ fm: fmAt(now), collect: col, store: st, wa, now });
  const E = Object.values(st.ledger.deliveries);
  const c = s => E.filter(e => e.status === s).length;
  ok(E.length === 46, "46 of the 62 FM deliveries are kept — the 16 to accounts not created yet are ignored", E.length);
  ok(!E.some(e => ["x/english", "x/portuguese", "tiktok/english", "tiktok/portuguese", "telegram/portuguese", "telegram_direct/english", "telegram_direct/portuguese"]
                  .includes(e.channel + "/" + e.language)), "none of the 7 not-yet-created channels is in the ledger");
  ok(c("verified") === 37 && c("missing") === 1, "37 verified, 1 missing", `verified ${c("verified")}, missing ${c("missing")}`);
  ok(c("assumed") === 8 && c("unwatched") === 0 && c("unverifiable") === 0, "8 Viber assumed, nothing 'not watched', nothing that can't be checked",
     `${c("assumed")}/${c("unwatched")}/${c("unverifiable")}`);
  const miss = E.find(e => e.status === "missing");
  ok(miss.channel === "x" && miss.language === "vietnamese" && miss.card === "Triple Match Roundup", "the missing one is X VN 10:30 — exactly what was found by hand");
  ok(E.filter(e => e.status === "verified").every(e => e.lag >= -5 && e.lag <= 20 && e.sim >= 50), "every verified delivery is inside 20 min with matching words");
  const msg = wa.out.join("\n");
  ok(/Missing\* — X VN · 10:30 "Triple Match Roundup"/.test(msg), "WhatsApp says X VN 10:30 is missing");
  ok(!/X PT|TikTok EN|Telegram PT|Bot EN|Bot PT|Not watched yet/.test(msg), "the channels that don't exist yet appear nowhere in the alerts");
  ok(!/18\+/.test(msg) && /🇬🇧 \*ENGLISH\*[^🇧]*• Instagram — ✓ Delivered/.test(msg),
     "Instagram EN is checked like every other channel — no '18+' left anywhere in the alerts");
  ok(/DROP REPORT — 18:30 IST[^\n]*\n✅ \*All delivered\* · 14\/14 channels confirmed/.test(msg) && /DROP REPORT — 10:30 IST[^\n]*\n⚠️ \*1 problem\* · 13\/14 channels confirmed/.test(msg),
     "…with a full report per drop: 18:30 all delivered, 10:30 with one problem");
  ok(/🇻🇳 \*VIETNAMESE\* — 6\/7 delivered/.test(msg) && /• X — ✗ Missing/.test(msg) && /• YouTube — ✓ Delivered at \d\d:\d\d:\d\d \(\+\d+\.\d min\) · caption 100%/.test(msg) &&
     /\*Needs attention:\*\n❌ X VN — not on X — caption 315\/280 as X counts it, so X refused it/.test(msg) && /\*Sent:\* scheduled for 10:30 \(sent by the scheduler\)/.test(msg),
     "…listing every channel per language with its time, delay and caption match, who sent it, and what went wrong");
  ok(wa.out.filter(t => /DROP REPORT/.test(t)).every(t => (t.match(/DROP REPORT/g) || []).length === 1), "every drop report is a message of its own");
  ok(/🇻🇳 \*VIETNAMESE\* — 6\/7 delivered\n(• [^\n]+\n)*• Telegram bot — ✓ Delivered/.test(msg), "the Telegram bot has its row in the Vietnamese table");

  /* a card FM did not send to the Telegram bot (5 Oct, 16:31): the row is there and says so */
  {
    const noBot = D.filter(d => !(d.channel === "telegram_direct" && d.template.label === "Attack vs Defense"));
    const n2 = at("2026-10-04T15:30:00Z"), st2 = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wa2 = mkWa();
    await tick({ fm: async () => noBot.filter(d => Date.parse(d.queuedAt) <= n2), collect: mkCollect(n2), store: st2, wa: wa2, now: n2, force: true });
    const r18 = wa2.out.find(t => /DROP REPORT — 18:30/.test(t)) || "";
    ok(/• Telegram bot — ○ Not sent by content team/.test(r18) && /🇻🇳 \*VIETNAMESE\* — 6\/6 delivered · 1 not sent by content team/.test(r18),
       "a channel the content team didn't send to is listed as 'not sent by content team', not left out and not counted as missing");
  }
  if (process.env.SHOW) console.log("\n" + wa.out[0] + "\n");
  ok(!/@/.test(JSON.stringify(Object.values(st.ledger.deliveries).map(e => e.publishedBy))), "no editor email is stored");
  ok(col.calls.length === 2 && col.calls.every(c => c.noPaid === true && c.fresh === true), "one batched read per tick, free readers only, never a cached read",
     JSON.stringify(col.calls.map(x => x.ids.length)));
  ok(Object.keys(st.report.posts).length === 14 && st.report.autoAt, "what was read is merged into the daily-check report");

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
  const evening = Object.values(st.ledger.deliveries).filter(e => e.card === "Attack vs Defense" && e.mode === "verify" && !e.soft);
  ok(evening.length === 14 && evening.every(e => e.status === "verified"), "7 min after the 18:30 drop all 14 checked channels are already verified",
     evening.map(e => e.status).join(","));
  ok(!/18:30 "Attack vs Defense"/.test(wa.out.join("\n")), "…but its summary waits until the 20-min window closes");
  now = at("2026-10-04T13:22:00Z");
  await tick({ fm: fmAt(now), collect: mkCollect(now), store: st, wa, now });
  ok(/DROP REPORT — 18:30 IST/.test(wa.out.join("\n")), "…and is sent once it does");

  /* a broken reader: Facebook VN refuses — kept on the website, never a notification, never a false "missing" */
  now = at("2026-10-04T13:05:00Z");
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }); wa = mkWa();
  await tick({ fm: fmAt(now), collect: mkCollect(now, ["fb-vn"]), store: st, wa, now, force: true });
  now = at("2026-10-04T13:25:00Z");
  await tick({ fm: fmAt(now), collect: mkCollect(now, ["fb-vn"]), store: st, wa, now });
  let fbv = Object.values(st.ledger.deliveries).find(e => e.chId === "fb-vn" && e.card === "Attack vs Defense");
  ok(fbv.status === "waiting" && !/DROP REPORT — 18:30/.test(wa.out.join("\n")),
     "25 min after FM sent it, an unreadable channel is still being retried — no verdict, no drop report yet", fbv.status);
  now = at("2026-10-04T13:31:00Z");
  await tick({ fm: fmAt(now), collect: mkCollect(now, ["fb-vn"]), store: st, wa, now });
  fbv = Object.values(st.ledger.deliveries).find(e => e.chId === "fb-vn" && e.card === "Attack vs Defense");
  const out1 = wa.out.join("\n"), r1830a = wa.out.find(t => /DROP REPORT — 18:30/.test(t)) || "";
  ok(fbv.status === "reader_failed" && /🇻🇳 \*VIETNAMESE\*[^🇬]*• Facebook — ! Couldn't check/.test(r1830a),
     "after 10 more minutes of retries the drop is reported, with Facebook VN as couldn't-check", fbv.status);
  ok(!/Reader down|Reader back|Can't confirm/.test(out1), "scraper health is never sent as a notification");
  ok(!/Missing\* — Facebook VN · 18:30/.test(out1), "…and Facebook VN 18:30 is not called missing");
  const fbh = st.ledger.readers["fb-vn"];
  ok(fbh.down && fbh.failingSince === at("2026-10-04T13:05:00Z") && /HTTP 429/.test(fbh.lastError),
     "the website still knows: Facebook VN down, since when, and why");
  ok(st.ledger.alerts.some(a => a.kind === "reader_down" && a.internal) && st.ledger.alerts.some(a => a.kind === "reader_failed" && a.internal),
     "…and lists the incident (marked website-only) in its log");

  /* a hiccup: X can't be read at the 20-min mark, then reads again 2 minutes later — nobody hears of it */
  now = at("2026-10-04T13:21:00Z");
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }); wa = mkWa();
  await tick({ fm: fmAt(now), collect: mkCollect(now, ["x-vn"]), store: st, wa, now, force: true });
  now = at("2026-10-04T13:22:00Z");
  await tick({ fm: fmAt(now), collect: mkCollect(now, ["x-vn"]), store: st, wa, now });
  now = at("2026-10-04T13:23:00Z");
  await tick({ fm: fmAt(now), collect: mkCollect(now), store: st, wa, now });
  const xv = Object.values(st.ledger.deliveries).find(e => e.chId === "x-vn" && e.card === "Attack vs Defense");
  const out2 = wa.out.join("\n"), r1830b = wa.out.find(t => /DROP REPORT — 18:30/.test(t)) || "";
  ok(xv.status === "verified" && /✅ \*All delivered\*/.test(r1830b) && !/Couldn't check/.test(r1830b) && !/Reader down|Reader back|Can't confirm/.test(out2),
     "a reader that recovers within the grace is invisible: X verified, the drop all delivered, no notification", xv.status);
  ok(st.ledger.readers["x-vn"].ok && !st.ledger.readers["x-vn"].down && st.ledger.readers["x-vn"].failingSince === null,
     "…and the website shows X working again");

  /* Instagram: a post not on the public profile is "check by hand", never "missing" — Instagram puts an 18+
     wall on single posts by itself and nothing logged-out can see those (9 Oct 22:30, Instagram PT) */
  {
    const igPost = FX.posts["ig-vn"].find(p => Date.parse(p.ts) > at("2026-10-04T12:55:00Z") && Date.parse(p.ts) < at("2026-10-04T13:10:00Z"));
    const colI = t => async chs => ({ results: chs.map(c => FX.posts[c.id] ? { channelId: c.id, ok: true, source: "stub",
      posts: FX.posts[c.id].filter(p => Date.parse(p.ts) <= t && p !== igPost) } : { channelId: c.id, ok: false, note: "no posts found" }) });
    const si = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wi = mkWa();
    const cards = [], teamsI = { configured: () => true, card: require("../pipeline/teams.js").card, post: async () => {}, flush: async q => { cards.push(...q.map(m => m.payload)); return { left: [], log: [] }; } };
    for (const t of ["13:21:00", "13:22:00", "13:23:00"]) { const n = at("2026-10-04T" + t + "Z"); await tick({ fm: fmAt(n), collect: colI(n), store: si, wa: wi, teams: teamsI, now: n, force: true }); }
    const ig = Object.values(si.ledger.deliveries).find(e => e.chId === "ig-vn" && e.card === "Attack vs Defense");
    const out = wi.out.join("\n"), rep18 = wi.out.find(t => /DROP REPORT — 18:30/.test(t)) || "";
    ok(ig.status === "not_visible" && /⚠️ \*Check by hand\* — Instagram VN · 18:30 "Attack vs Defense" — not on the public profile 20 min after FM sent it\. It may be 18\+ restricted by Instagram \(our reader can't see those\) or not posted — please check in the app\./.test(out) && !/Missing\* — Instagram/.test(out),
       "an Instagram post not on the profile is a short 'check by hand' alert (maybe 18+, maybe not posted) — not 'missing'", ig.status);
    ok(/⚠️ \*1 to check by hand\* · 13\/14 channels confirmed/.test(rep18) && /• Instagram — ⚠ Not found — maybe 18\+, check the app/.test(rep18) &&
       /\*Needs attention:\*\n⚠️ Instagram VN — not on the public profile — maybe 18\+ restricted by Instagram/.test(rep18),
       "…and the drop report says the same, as something to check — not a problem");
    /* the section that says it, and the drop report's header, are amber — red is for problems only */
    const sections = cards.flatMap(c => c.attachments[0].content.body).filter(b => b.type === "Container");
    const checkBox = sections.find(b => /Check by hand/.test(JSON.stringify(b)));
    const dropBox = sections.map(b => (b.items || []).find(i => i.type === "Container" && /Drop report — 18:30/.test(JSON.stringify(i)))).find(Boolean);
    ok(checkBox && checkBox.style === "warning" && dropBox && dropBox.style === "warning", "…in Teams it is amber, not red",
       `${checkBox && checkBox.style} / ${dropBox && dropBox.style}`);
  }

  /* FM failed / stuck */
  now = at("2026-10-04T13:20:00Z");
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }); wa = mkWa();
  const twisted = D.map(d => d.channel === "youtube" && d.language === "english" && d.template.label === "Attack vs Defense"
    ? { ...d, state: "failed", failureStage: "fm", error: "upload rejected" }
    : d.channel === "telegram" && d.language === "english" && d.template.label === "Attack vs Defense" ? { ...d, state: "queued", sentAt: null } : d);
  await tick({ fm: async () => twisted.filter(d => Date.parse(d.queuedAt) <= now), collect: mkCollect(now), store: st, wa, now, force: true });
  ok(/🛑 \*Not sent — FM failed\* — YouTube EN · 18:30 "Attack vs Defense" — upload rejected/.test(wa.out.join("\n")), "an FM failure is alerted in plain words, with its error");
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
  pushed.length = 0;                       // the second read is the one that settles X VN 10:30
  await tick({ fm: fmAt(now + 60e3), collect: mkCollect(now), store: st, wa, now: now + 60e3 });
  ok(pushed[0] && pushed[0].problem && /Missing\* — X VN/.test(pushed[0].text), "the problems are pushed to the phone first, flagged as a problem");
  ok(pushed.filter(p => /DROP REPORT/.test(p.text)).length >= 1 && pushed.every(p => p.text.length < 4000), "…then each drop report as its own push, each under ntfy's 4 KB",
     pushed.map(p => p.text.length).join(","));

  console.log("\n── Microsoft Teams, and the pipeline's own health");
  const { card } = require("../pipeline/teams.js");
  const cards = [];
  const teamsStub = { configured: () => true, card, post: async p => { cards.push(p); }, flush: async q => { cards.push(...q.map(m => m.payload)); return { left: [], log: [] }; } };
  now = at("2026-10-04T15:30:00Z");
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }); wa = mkWa();
  await tick({ fm: fmAt(now), collect: mkCollect(now), store: st, wa, teams: teamsStub, now, force: true });
  await tick({ fm: fmAt(now + 60e3), collect: mkCollect(now), store: st, wa, teams: teamsStub, now: now + 60e3 });
  const c0 = (cards.find(c => /Missing/.test(JSON.stringify(c))) || cards[0]).attachments[0];
  ok(cards.length >= 4 && cards.every(c => c.attachments[0].contentType === "application/vnd.microsoft.card.adaptive" && c.attachments[0].content.type === "AdaptiveCard"),
     "Adaptive Cards go to the Teams channel: the problems, then one card per drop report", cards.length + " cards");
  const blocks = JSON.stringify(c0.content.body);
  ok(/"style":"attention"/.test(blocks) && /\*\*Missing\*\* — X VN · 10:30/.test(blocks), "a missing post is a red section, in Teams' **bold**");
  const clean = cards.map(c => JSON.stringify(c)).find(j => /Drop report — 18:30 IST/.test(j)) || "";
  ok(/"style":"good"/.test(clean) && /All delivered · 14\/14 channels confirmed/.test(clean) && /"title":"Sent"/.test(clean) && /\*\*Channel\*\*/.test(clean),
     "a fully delivered drop is a green report card: overview facts and a per-language table");
  ok(cards.every(c => JSON.stringify(c).length < 28000), "every card stays under Teams' 28 KB limit", cards.map(c => JSON.stringify(c).length).join(","));

  /* the clock stopped for 25 min: the first tick back says so */
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z"), lastTickAt: at("2026-10-04T15:05:00Z") }); wa = mkWa();
  now = at("2026-10-04T15:30:00Z");
  await tick({ fm: fmAt(now), collect: mkCollect(now), store: st, wa, teams: { ...teamsStub, configured: () => false }, now });
  ok(/Pipeline was paused\* for 25 min \(no checks from 20:35 to 21:00 IST\)/.test(wa.out.join("\n")), "a 25-min gap in the clock is reported");

  /* a tick that crashes: one alert on every channel, then quiet for 30 min while it retries */
  const pushes = [];
  const waCrash = { ...mkWa(), pushConfigured: () => true, push: async (t) => { pushes.push(t); } };
  st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") });
  /* FM answering with something that is not a list makes the tick itself throw */
  const garbage = async () => ({ deliveries: "nonsense" });
  let crashed = 0;
  for (const m of [0, 1, 2]) {
    try { await tick({ fm: garbage, collect: mkCollect(now), store: st, wa: waCrash, teams: { ...teamsStub, configured: () => false }, now: now + m * 60e3, force: true }); }
    catch (e) { crashed++; }
  }
  ok(crashed === 3 && pushes.length === 1 && /Pipeline check failed/.test(pushes[0]), "a crashing tick alerts exactly once per 30 min", `${crashed} crashes, ${pushes.length} alert(s)`);
  ok(st.ledger.lock === null && st.ledger.lastCrash, "…and the ledger is never left locked by a crash");

  console.log("\n── never an old report, never a superseded failure, never a verdict from a bad read (9–10 Oct)");
  {
    /* 9 Oct: drops of 6 Oct were reported again on 9 Oct — the 3-day clean-up removed a drop's first posts
       and the rest looked like a new drop. Replay 4 Oct, then run the clock on for three days through
       every moment a delivery of that day turns 3 days old. */
    now = at("2026-10-04T15:30:00Z");
    st = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }); wa = mkWa();
    const fm36 = t => async () => D.filter(d => Date.parse(d.queuedAt) <= t && Date.parse(d.queuedAt) >= t - 36 * 3600e3);
    await tick({ fm: fm36(now), collect: mkCollect(now), store: st, wa, now, force: true });
    await tick({ fm: fm36(now + 60e3), collect: mkCollect(now), store: st, wa, now: now + 60e3 });
    const reportsBefore = wa.out.filter(t => /DROP REPORT/.test(t)).length;
    const whens = Object.values(st.ledger.deliveries).map(e => e.when);
    const times = new Set();
    for (let t = now + 2 * 60e3; t <= at("2026-10-07T16:00:00Z"); t += 9 * 60e3) times.add(t);
    for (const w of whens) for (let k = -3; k <= 3; k++) times.add(Math.floor((w + 3 * 86400e3) / 60e3) * 60e3 + k * 60e3);
    for (const t of [...times].sort((a, b) => a - b)) await tick({ fm: fm36(t), collect: mkCollect(t), store: st, wa, now: t, force: true });
    const later = wa.out.slice(0).filter(t => /DROP REPORT/.test(t)).length - reportsBefore;
    ok(reportsBefore >= 3 && later === 0, "a drop's report goes out once — three days on, as its posts are cleaned up, nothing is reported again",
       `${reportsBefore} reports on the day, ${later} later`);
    ok(!wa.out.some(t => /Not sent by content team/.test(t) && /Sun, 4 Oct/.test(t) && wa.out.indexOf(t) >= reportsBefore + 2),
       "…and no channel that was sent is ever listed as 'not sent by content team'");
    ok(!Object.keys(st.ledger.deliveries).length && !Object.keys(st.ledger.drops).length, "…and the day is cleaned up as a whole, drops and all");

    /* a ledger from before this version (drops not fixed yet): its old drops are never reported */
    const v1 = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wv = mkWa();
    now = at("2026-10-04T15:30:00Z");
    await tick({ fm: fm36(now), collect: mkCollect(now), store: v1, wa: wv, now, force: true });
    await tick({ fm: fm36(now + 60e3), collect: mkCollect(now), store: v1, wa: wv, now: now + 60e3 });
    const old = v1.ledger;
    delete old.drops; old.slots = {};
    for (const e of Object.values(old.deliveries)) if (e.dropKey) old.slots[e.dropKey] = {};   // v1 forgot it had sent them
    wv.out.length = 0;
    const t9 = at("2026-10-05T09:00:00Z");
    await tick({ fm: async () => [], collect: mkCollect(t9), store: v1, wa: wv, now: t9, force: true });
    ok(!wv.out.some(t => /DROP REPORT/.test(t)), "an old ledger's drops (from before fixed drops) are never reported again", wv.out.length + " message(s)");

    /* old news is never news: a delivery from two days ago turning up now raises nothing */
    const xOld = { ...find("x", "vietnamese", "Triple Match Roundup"), cardId: "old-x", sentAt: "2026-10-02T05:00:00Z", queuedAt: "2026-10-02T05:00:00Z", scheduledAt: null };
    const so = mkStore({ startedAt: at("2026-10-01T00:00:00Z") }), wo = mkWa();
    const tOld = at("2026-10-04T05:00:00Z");
    await tick({ fm: async () => [xOld], collect: mkCollect(tOld), store: so, wa: wo, now: tOld, force: true });
    await tick({ fm: async () => [xOld], collect: mkCollect(tOld + 60e3), store: so, wa: wo, now: tOld + 60e3 });
    ok(!wo.out.length && !so.ledger.alerts.length, "a delivery from an earlier day is never alerted — not its caption, not a miss", wo.out.join(" | ").slice(0, 120));
  }
  {
    /* 9 Oct 18:22: the CMS skipped a card (no channel images; FM leaves template and caption empty) and the
       content team sent it again 58 s later. No alert, no "Card: card · 0/0" report — one report, with a note. */
    const card = D.filter(d => d.template.label === "Attack vs Defense" && d.language === "english");
    const t0 = Math.min(...card.map(d => Date.parse(d.queuedAt)));
    const skipped = card.map(d => ({ ...d, cardId: d.cardId + "-first", rowId: "first", state: "skipped", outcome: "failed", failureStage: "cms",
      error: `No ${d.channel} image for this caption (template + language) — regenerate, or untick ${d.channel}.`,
      template: { id: null, key: null, label: null, kind: null }, caption: null, sentAt: null, scheduledAt: null, deliveryMode: null,
      queuedAt: new Date(t0 - 58e3).toISOString() }));
    const fmS = t => async () => [...skipped, ...D].filter(d => Date.parse(d.queuedAt) <= t);
    const ss = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), ws = mkWa();
    for (const t of [t0 - 30e3, t0 + 60e3, t0 + 6 * 60e3, t0 + 22 * 60e3, t0 + 23 * 60e3])
      await tick({ fm: fmS(t), collect: mkCollect(t), store: ss, wa: ws, now: t, force: true });
    const out = ws.out.join("\n");
    const rep = ws.out.find(t => /DROP REPORT — 18:30/.test(t)) || "";
    ok(!/Not sent —/.test(out) && !/Card:\* card\b/.test(out) && !/0\/0/.test(out), "a failed attempt the content team sent again is never alerted, and is no drop of its own");
    ok(/\*Note:\* A first attempt at 18:29 was skipped by the CMS/.test(rep) && /sent it again at 18:30/.test(rep) && /✅ \*All delivered\*/.test(rep),
       "…the card's report says so in a note, and the card is all delivered", (rep.match(/\*Note:\*[^\n]*/) || [""])[0]);
    ok(Object.values(ss.ledger.deliveries).filter(e => e.status === "superseded").length === skipped.filter(d => routeOf(d.channel, d.language).mode !== "skip").length,
       "…its rows are kept as 'superseded'");

    /* the same failure with no second send: held 5 min, then alerted, and reported as not sent at all */
    const lone = skipped.map(d => ({ ...d, setId: "lone", cardId: d.cardId + "-lone", collection: "multi-match-reels" }));
    const sl = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wl = mkWa();
    await tick({ fm: async () => lone, collect: mkCollect(t0), store: sl, wa: wl, now: t0, force: true });
    ok(!wl.out.length && Object.values(sl.ledger.deliveries).every(e => e.status === "fm_failing"), "an FM failure is held for 5 minutes in case it is sent again");
    await tick({ fm: async () => lone, collect: mkCollect(t0 + 5 * 60e3), store: sl, wa: wl, now: t0 + 5 * 60e3, force: true });
    const lo = wl.out.join("\n");
    ok(/🛑 \*Not sent — the CMS skipped it\* — Facebook EN · 18:29 "Multi match reels" — No facebook image/.test(lo), "…then alerted in plain words, named by its collection when FM gives no template",
       (lo.match(/Not sent —[^\n]*/) || [""])[0].slice(0, 110));
    ok(/🛑 \*Not sent\* — FM\/CMS failed on \d+ channels, nothing went out/.test(lo) && !/0\/0/.test(lo), "…and its report says nothing went out — not '0/0 checked'");
  }
  {
    /* a read that proves nothing never makes a verdict: no posts at all, or a partial read */
    const yt = find("youtube", "vietnamese", "Attack vs Defense"), sent = Date.parse(yt.sentAt);
    for (const [label, res] of [["no posts", { ok: true, source: "stub", posts: [] }],
                                ["partial", { ok: true, source: "stub", partialRead: true, note: "Partial: a tab refused", posts: FX.posts["yt-vn"].filter(p => Date.parse(p.ts) < sent - 3600e3) }]]) {
      const se = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), we = mkWa();
      const colE = async chs => ({ results: chs.map(c => ({ channelId: c.id, ...res })) });
      for (const m of [21, 22, 31, 32]) await tick({ fm: async () => [yt], collect: colE, store: se, wa: we, now: sent + m * 60e3, force: true });
      const e = se.ledger.deliveries[yt.cardId];
      ok(e.status === "reader_failed" && !/Missing/.test(we.out.join("\n")), `a successful read with ${label} is "couldn't check", never "missing"`, `${e.status} — ${e.readNote}`);
    }

    /* a post with no caption goes to the card that made it: card A (12:00) never posted, card B (12:10)
       posted a bare reel at 12:11 — read at 12:11:30, before B is due, A must not take it */
    const base = { setId: "s", collection: "c", channel: "youtube", language: "vietnamese", state: "sent", deliveryMode: "scheduled", publishedBy: "cron:x" };
    const A = { ...base, cardId: "A", template: { label: "Card A" }, caption: "Một hai ba bốn năm sáu bảy tám chín mười hôm nay", queuedAt: "2026-10-04T06:30:00Z", sentAt: "2026-10-04T06:30:00Z" };
    const B = { ...base, cardId: "B", setId: "s2", template: { label: "Card B" }, caption: "Trận cầu đinh cuối tuần này ai sẽ thắng đây các bạn", queuedAt: "2026-10-04T06:40:00Z", sentAt: "2026-10-04T06:40:00Z" };
    const older = FX.posts["yt-vn"].filter(p => Date.parse(p.ts) < at("2026-10-04T06:00:00Z"));
    const bare = { externalId: "bare", ts: "2026-10-04T06:41:00Z", text: "" };
    const sb = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wb = mkWa();
    const colB = async chs => ({ results: chs.map(c => ({ channelId: c.id, ok: true, source: "stub", posts: [bare, ...older] })) });
    for (const t of ["06:41:30", "06:43:00", "06:50:00", "06:51:00", "07:01:00"]) await tick({ fm: async () => [A, B], collect: colB, store: sb, wa: wb, now: at("2026-10-04T" + t + "Z"), force: true });
    ok(sb.ledger.deliveries.B.status === "verified" && sb.ledger.deliveries.B.postId === "bare" && sb.ledger.deliveries.A.status === "missing",
       "a caption-less post is given to the card sent just before it, not to an older card that never posted",
       `A ${sb.ledger.deliveries.A.status}, B ${sb.ledger.deliveries.B.status}`);
  }
  {
    /* health: every reader is read at least every 30 min whether a card is due or not, and the Health page
       says per part what works */
    const { healthOf } = require("../pipeline/health.js");
    const sh = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wh = mkWa();
    const colH = mkCollect(at("2026-10-04T15:30:00Z"), ["fb-br"]);
    let t = at("2026-10-04T15:30:00Z");
    for (let i = 0; i < 6; i++, t += 60e3) await tick({ fm: async () => [], collect: colH, store: sh, wa: wh, now: t, force: true });
    const read = Object.entries(sh.ledger.readers).filter(([, h]) => h.lastReadAt);
    ok(read.length === 14 && colH.calls.every(c => c.ids.length <= 3), "with nothing due, every one of the 14 readers is still read — 3 per tick, stalest first",
       `${read.length} read, ${colH.calls.map(c => c.ids.length).join("/")} per tick`);
    const H = healthOf(sh.ledger, t, { teams: true, push: true, whatsapp: false });
    const R = H.groups.find(g => g.id === "readers").items;
    const fbBr = R.find(i => i.id === "fb-br"), ytVn = R.find(i => i.id === "yt-vn"), igFans = R.find(i => i.id === "ig-fans");
    ok(R.length === 14 && ytVn.state === "ok" && /posts in 30 h/.test(ytVn.detail) && fbBr.state !== "ok" && igFans.state === "ok",
       "the Health page lists every reader: working (Instagram EN too), failing with why", `${fbBr.state}: ${fbBr.detail.slice(0, 60)}`);
    ok(H.groups.find(g => g.id === "pipeline").items[0].state === "ok" && H.groups.find(g => g.id === "fm").items[0].state === "ok" &&
       H.groups.find(g => g.id === "alerts").items.find(i => i.id === "whatsapp").state === "off" && H.overall === "degraded",
       "…the clock, FM and the alert channels too, with one overall verdict", H.overall + " — " + H.summary);
    const late = healthOf({ ...sh.ledger, lastTickAt: t - 30 * 60e3 }, t, {});
    ok(late.overall === "down" && late.groups[0].items[0].state === "bad", "a stopped clock is 'down'");

    /* report sync (15 Oct 2026): a merge happens only when a read brings a new post, so a quiet night two
       hours past the last merge is "up to date" — it showed "1 to check" before */
    const rsOf = led => healthOf({ ...sh.ledger, ...led }, t, {}).groups[0].items.find(i => i.id === "report");
    const quiet = rsOf({ lastReportMerge: { at: t - 2 * 3600e3, channels: 3 }, reportSync: { pendingSince: null, failingSince: null } });
    ok(quiet.state === "ok" && /up to date/.test(quiet.detail), "nothing new for 2 h: report sync is up to date, not 'check'", quiet.detail);
    const stuck = rsOf({ lastReportMerge: { at: t - 2 * 3600e3, channels: 3 }, reportSync: { pendingSince: t - 70 * 60e3 } });
    ok(stuck.state === "warn" && /still waiting/.test(stuck.detail), "new posts read over an hour ago and still not merged: 'check'", stuck.detail);
    const failing = rsOf({ reportSync: { pendingSince: t - 40 * 60e3, failingSince: t - 40 * 60e3, lastError: "store write failed (503)" } });
    ok(failing.state === "bad" && /can't be saved.*503/.test(failing.detail), "the merge failing for 30+ min: 'not working', with why", failing.detail);
    const blip = rsOf({ reportSync: { pendingSince: t - 2 * 60e3, failingSince: t - 2 * 60e3, lastError: "timeout" } });
    ok(blip.state === "warn", "…a single failure just now: 'check'");
  }

  console.log("\n── the day's summary (23:00 IST)");
  {
    const sd = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wd = mkWa();
    const cards = [], teamsD = { configured: () => true, card: require("../pipeline/teams.js").card, post: async () => {}, flush: async q => { cards.push(...q.map(m => m.payload)); return { left: [], log: [] }; } };
    for (const t of ["15:30:00", "15:31:00", "17:31:00", "17:40:00"]) { const n = at("2026-10-04T" + t + "Z"); await tick({ fm: fmAt(n), collect: mkCollect(n), store: sd, wa: wd, teams: teamsD, now: n, force: true }); }
    const sums = wd.out.filter(t => /DAILY SUMMARY/.test(t)), sum = sums[0] || "";
    if (process.env.SHOW) console.log("\n" + sum + "\n");
    ok(sums.length === 1 && !/DROP REPORT/.test(sum), "one summary a day, a message of its own", sums.length + " summaries");
    ok(/^📊 \*DAILY SUMMARY — Sun, 4 Oct 2026\*\n⚠️ \*37 of 38 posts confirmed on their channels\* · 1 needs attention\n/.test(sum),
       "it opens with the day and the result in one line", sum.split("\n").slice(0, 2).join(" | "));
    ok(/\*Today:\* \d+ drops · 46 deliveries from FM · 97% confirmed/.test(sum) && /\*By language:\* 🇻🇳 Vietnamese \d+\/\d+ · 🇬🇧 English \d+\/\d+ · 🇧🇷 Portuguese \d+\/\d+/.test(sum),
       "…then the totals and each language");
    ok(/\*Needs attention \(1\):\*\n❌ 10:30 X VN — Triple Match Roundup: not on X — caption 315\/280 as X counts it, so X refused it/.test(sum),
       "…then a short list of what needs attention, each with its time and why");
    ok(/• Viber: 8 taken on FM's word \(Viber can't be read\)/.test(sum) && !/18\+|IG 18|unverifiable|≈ \d+ Viber assumed/.test(sum),
       "…notes in plain words, nothing stale (no '18+', no codes)");
    const dc = JSON.stringify(cards.find(c => /Daily summary/.test(JSON.stringify(c))) || {});
    ok(/Daily summary — Sun, 4 Oct 2026/.test(dc) && /\*\*Language\*\*/.test(dc) && /"title":"Confirmed on the channel","value":"37 of 38 \(97%\)"/.test(dc) && dc.length < 28000,
       "in Teams: a card of its own — totals, a table per language, what needs attention", dc.length + " bytes");
    /* a drop still being checked at 23:00 is not lost: it is in the next summary, once, with a note */
    {
      const late = D.filter(d => d.template.label === "Attack vs Defense" && d.language === "english")
        .map(d => ({ ...d, cardId: d.cardId + "-late", setId: "late", queuedAt: "2026-10-04T17:20:00Z", sentAt: "2026-10-04T17:20:00Z", scheduledAt: null }));
      const sl = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wl = mkWa();
      const fmL = t => async () => [...D, ...late].filter(d => Date.parse(d.queuedAt) <= t);
      for (const t of ["15:30:00", "15:31:00", "17:31:00", "17:45:00", "18:00:00"]) { const n = at("2026-10-04T" + t + "Z"); await tick({ fm: fmL(n), collect: mkCollect(n), store: sl, wa: wl, now: n, force: true }); }
      const first = wl.out.filter(t => /DAILY SUMMARY/.test(t));
      for (const t of ["2026-10-05T17:31:00Z"]) { const n = at(t); await tick({ fm: fmL(n), collect: mkCollect(n), store: sl, wa: wl, now: n, force: true }); }
      const next = wl.out.filter(t => /DAILY SUMMARY — Mon, 5 Oct/.test(t))[0] || "";
      ok(first.length === 1 && /still being checked — counted in tomorrow's summary/.test(first[0]),
         "a drop still being checked at 23:00 is noted as such in that night's summary");
      ok(/includes \d+ deliveries from late last night/.test(next) && !/DAILY SUMMARY — Sun/.test(wl.out.slice(wl.out.indexOf(first[0]) + 1).join("\n")),
         "…and counted in the next night's summary, once", (next.match(/\*Today:\*[^\n]*/) || [""])[0]);
    }
    const { dayData, dayText } = require("../pipeline/report.js");
    const clean = dayText(dayData(Object.values(sd.ledger.deliveries).filter(e => !(e.channel === "x" && e.card === "Triple Match Roundup")), "2026-10-04"));
    ok(/✅ \*All 37 posts confirmed on their channels\*/.test(clean) && /\*Needs attention:\* nothing/.test(clean), "a clean day says so plainly");
  }

  console.log("\n── nothing holds a drop back, and the shared rows are touched only when needed");
  {
    /* a card stuck in FM's queue an hour past its time: the drop is reported with it, not held for ever */
    const stuck = D.map(d => d.channel === "youtube" && d.language === "english" && d.template.label === "Attack vs Defense" ? { ...d, state: "queued", sentAt: null } : d);
    const ss = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), ws = mkWa();
    for (const t of ["13:30:00", "13:31:00", "14:05:00"]) { const n = at("2026-10-04T" + t + "Z"); await tick({ fm: async () => stuck.filter(d => Date.parse(d.queuedAt) <= n), collect: mkCollect(n), store: ss, wa: ws, now: n, force: true }); }
    const r = ws.out.filter(t => /DROP REPORT — 18:30/.test(t));
    ok(r.length === 1 && /• YouTube — ✗ Stuck in FM/.test(r[0]) && /❌ YouTube EN — still queued in FM/.test(r[0]),
       "a card stuck in FM an hour past its time: the drop is reported with it, not held back", r.length + " report(s)");

    /* an FM state this pipeline doesn't know: shown as it is, never holds the drop */
    const odd = D.map(d => d.channel === "telegram" && d.language === "english" && d.template.label === "Attack vs Defense" ? { ...d, state: "cancelled" } : d);
    const so = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wo = mkWa();
    for (const t of ["13:30:00", "13:31:00"]) { const n = at("2026-10-04T" + t + "Z"); await tick({ fm: async () => odd.filter(d => Date.parse(d.queuedAt) <= n), collect: mkCollect(n), store: so, wa: wo, now: n, force: true }); }
    ok(wo.out.some(t => /DROP REPORT — 18:30/.test(t) && /• Telegram — · FM state not known here/.test(t)), "an FM state added later never holds a drop back");

    /* the shared report row is rewritten only when a read brings a post it hasn't had */
    let merges = 0;
    const sm = mkStore({ startedAt: at("2026-10-04T03:00:00Z") }), wm = mkWa();
    const merge0 = sm.mergeIntoReport; sm.mergeIntoReport = async (...a) => { merges++; return merge0(...a); };
    let n = at("2026-10-04T15:30:00Z");
    await tick({ fm: fmAt(n), collect: mkCollect(n), store: sm, wa: wm, now: n, force: true });
    const afterFirst = merges;
    for (let i = 1; i <= 8; i++) await tick({ fm: fmAt(n + i * 60e3), collect: mkCollect(n), store: sm, wa: wm, now: n + i * 60e3, force: true });
    ok(afterFirst === 1 && merges === 1, "nothing new on the channels → the report row is not rewritten (health probes read every minute)", `${afterFirst} then ${merges}`);

    /* the website's log keeps a short copy of a long report; the message itself is whole */
    const longest = Math.max(...sm.ledger.alerts.map(a => a.text.length)), sentLongest = Math.max(...wm.out.map(t => t.length));
    ok(longest <= 610 && sentLongest > 1000 && sm.ledger.alerts.length <= 150, "the log keeps a short copy (≤ 600 chars, 150 entries); the message goes out whole",
       `${longest} / ${sentLongest}`);
  }

  console.log("\n── who hears what — problems only, and the day's summary (production since 14 Oct)");
  {
    delete process.env.PIPELINE_NOTIFY;
    const cards = [], pushes = [];
    const teamsP = { configured: () => true, card: require("../pipeline/teams.js").card, post: async p => { cards.push(p); },
                     flush: async q => { cards.push(...q.map(m => m.payload)); return { left: [], log: [] }; } };
    const waP = { ...mkWa(), pushConfigured: () => true, push: async (t, o) => { pushes.push({ t, title: o.title }); } };
    const sp = mkStore({ startedAt: at("2026-10-04T03:00:00Z"), lastTickAt: at("2026-10-04T15:05:00Z") });   // the clock stopped for 25 min
    for (const t of ["15:30:00", "15:31:00", "17:31:00"]) { const n = at("2026-10-04T" + t + "Z"); await tick({ fm: fmAt(n), collect: mkCollect(n), store: sp, wa: waP, teams: teamsP, now: n, force: true }); }
    const tj = cards.map(c => JSON.stringify(c));
    ok(!tj.some(j => /All delivered/.test(j)) && !pushes.some(p => /All delivered/.test(p.t)), "a drop that went out everywhere is sent nowhere — it is on the website");
    ok(sp.ledger.alerts.some(a => a.kind === "slot" && /All delivered/.test(a.text)), "…and is in the website's log like every drop");
    ok(tj.some(j => /\*\*Missing\*\* — X VN · 10:30/.test(j)) && tj.some(j => /Drop report — 10:30/.test(j)), "a problem goes to Teams: the alert, and that drop's report");
    ok(tj.filter(j => /Daily summary — Sun, 4 Oct 2026/.test(j)).length === 1, "the day's summary goes once, at 23:00");
    ok(!tj.some(j => /Pipeline was paused/.test(j)) && pushes.some(p => /Pipeline was paused/.test(p.t)), "the pipeline's own trouble goes to the admin's phone, never to Teams");
    const before = cards.length;
    const crashStore = mkStore({ startedAt: at("2026-10-04T03:00:00Z") });
    try { await tick({ fm: async () => ({ deliveries: "nonsense" }), collect: mkCollect(at("2026-10-04T17:40:00Z")), store: crashStore, wa: waP, teams: teamsP, now: at("2026-10-04T17:40:00Z"), force: true }); } catch (e) {}
    ok(cards.length === before && pushes.some(p => /Pipeline check failed/.test(p.t)), "a crash: the admin's phone, not Teams");
    ok((crashStore.ledger.errorLog || []).some(x => x.source === "crash"), "…and it is kept in the error log for the Admin page");
    const se = mkStore({ startedAt: at("2026-10-04T03:00:00Z") });
    await tick({ fm: fmAt(at("2026-10-04T13:30:00Z")), collect: async () => { throw new Error("network down"); }, store: se, wa: mkWa(), teams: { ...teamsP, configured: () => false }, now: at("2026-10-04T13:30:00Z"), force: true });
    ok((se.ledger.errorLog || []).some(x => /network down/.test(x.text)), "every error of a check is kept for the Admin page", JSON.stringify(se.ledger.errorLog || []).slice(0, 120));
    process.env.PIPELINE_NOTIFY = "all";
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
