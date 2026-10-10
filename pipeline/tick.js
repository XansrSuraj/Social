/**
 * One tick of the FM → channels pipeline. Run every minute (api/pipeline.js?op=tick).
 *
 *   1. read FM Deliveries (prod) for the last 36 h — what was scheduled / sent, to which channel
 *   2. check every new card's caption against the platform's limits (X 280 by X's count as posted, …)
 *   3. for each delivery FM has sent, read only the channels now due and look for the post —
 *      matched on time AND words (FM gives the exact caption); every reader is also read at least
 *      every 30 min whether a card is due or not, so its health on the website is always current
 *   4. decide: verified (inside 20 min) · late · missing · not visible (Instagram — maybe 18+, check by
 *      hand) · reader failed · assumed (Viber) · not watched (no link yet) · FM failed / stuck · superseded
 *   5. merge what was read into the daily-check report, so the website stays current
 *   6. alerts: problems the moment they are known, one report when a drop is fully settled, the day's
 *      summary at 23:00 IST — every alert sent once (keys in the ledger), and NEVER about anything old
 *
 * Two rules that keep alerts true (both broke on 9 Oct 2026):
 *   - A drop's identity is fixed the moment it is formed (led.drops). The old code re-derived drops
 *     from whatever deliveries were left each tick; when the 3-day clean-up removed a drop's first
 *     posts, the rest looked like a new drop and its report went out again three days late, with the
 *     removed channels listed as "not sent by content team". Now a drop is cleaned up only as a whole,
 *     and its report is sent once, ever.
 *   - Old news is never news: nothing whose time is not today (IST) or within the last 6 hours is
 *     notified, whatever the ledger says. A drop report is about today's drops only.
 *
 * Every outside thing is passed in (fm, collect, store, wa, now), so the whole tick is tested
 * end to end without a network (test/pipeline.test.js).
 */
const { routeOf, labelOf, FM_CHANNELS } = require("./channels.js");
const { captionProblem, assign, xPostedLength } = require("./rules.js");
const realTeams = require("./teams.js");
const { dropData, dropText, dayData, dayText } = require("./report.js");

const WINDOW_MIN = 20;            // every channel normally shows the post within ~5 min; 20 is the buffer
const FIRST_CHECK_MIN = 2;        // first look 2 min after FM sent it
const LATE_MAX_MIN = 180;         // keep looking for a missing post this long, to report a late arrival
const RECHECK_MISSING_MIN = 15;   // …but only every 15 min once it is past the window
const READ_GRACE_MIN = 10;        // a channel that can't be read at the 20-min mark gets 10 more minutes of retries
/* Scraper health — a reader failing, coming back, a post that couldn't be checked — is shown on the
   website (Health page) and never sent as a notification: the free readers hiccup for a minute or two
   and recover on their own (FxTwitter answering 404 for X, 8 Oct). (2026-10-08, at the user's request.) */
const INTERNAL = new Set(["reader_down", "reader_up", "reader_failed"]);
const STUCK_MIN = 15;             // FM still not sent 15 min after the scheduled time
const FM_DOWN_MIN = 15;
/* An FM failure is held 5 min before it is alerted: on 9 Oct the CMS skipped a card at 18:22 (no channel
   images) and the content team sent it again 58 s later — the failure was already handled. A later send
   of the same card (same set, same language, queued ≥ 20 s after — one send's rows are queued within ~8 s)
   supersedes the failed one: no alert, and it is not a drop of its own. */
const FAIL_HOLD_MIN = 5;
const RESEND_GAP_MS = 20000;
const FRESH_H = 6;                // nothing older than this, and not from today (IST), is ever notified
const DROP_SPAN_MIN = 20;         // the same card going out within 20 min (every language, every channel) is one drop
const PROBE_MIN = 30;             // every reader is read at least this often — the Health page stays live
const PROBES_PER_TICK = 3;        // …a few per tick, stalest first, so a tick stays short
const BACKFILL_QUIET_H = 3;       // on the very first tick, stay quiet about anything older than this
const KEEP_DAYS = 3;
const MIN_TICK_GAP_MS = 40000;
const PIPELINE_URL = "https://aiko-social-distribution-check.vercel.app/#/live";

const FINAL = new Set(["verified", "late", "assumed", "unwatched", "unverifiable", "fm_failed", "fm_unconfirmed", "fm_other"]);
/* fm_stuck: still queued in FM an hour after its time — the drop is reported with it rather than held for
   ever; if FM sends it after all, it is checked like any other */
const SETTLED = new Set([...FINAL, "missing", "not_visible", "reader_failed", "unchecked", "fm_stuck"]);
const STUCK_REPORT_MIN = 60;
/* Not found on the channel. On Instagram that is "not_visible", not "missing": Instagram puts an 18+ wall on
   single posts by itself (9 Oct 22:30, Instagram PT — a betting-style reel), and no logged-out reader, Apify
   included, can see such a post at all — so "missing" there could be wrong. It is still flagged, to be checked
   by hand in the app. */
const MISS = new Set(["missing", "not_visible"]);
const SENDABLE = new Set(["queued", "sending", "sent"]);
const ist = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16);
const istDay = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const T = (iso) => Date.parse(iso);
/* "multi-match-reels" → "Multi-match reels" — a card's name when FM gives no template */
const pretty = s => String(s || "").replace(/[-_]+/g, " ").replace(/^\w/, c => c.toUpperCase()).replace(/\bmatch reels\b/i, "match reels");

/* Every delivery belongs to one drop, fixed once formed (see the header). A delivery joins the drop of the
   same card that started within 20 min of it and has not been reported yet; otherwise it starts one. A
   delivery whose drop was already reported stays there; one that no longer fits an unreported drop (a
   rescheduled card, a card renamed once FM filled in its template) is placed again. A superseded failed
   attempt belongs to no drop. Returns the drops' members. */
function placeDrops(led) {
  const drops = led.drops, span = DROP_SPAN_MIN * 60e3;
  const list = Object.values(led.deliveries).sort((a, b) => a.when - b.when);
  for (const e of list) {
    if (e.status === "superseded") { e.dropKey = null; continue; }
    const cur = e.dropKey && drops[e.dropKey];
    if (cur && (cur.summarySent || (cur.card === e.card && Math.abs(e.when - cur.anchor) <= span))) continue;
    const fit = Object.entries(drops).find(([, d]) => !d.summarySent && d.card === e.card && Math.abs(e.when - d.anchor) <= span);
    if (fit) { e.dropKey = fit[0]; continue; }
    let key = `${e.card}@${new Date(e.when).toISOString().slice(0, 16)}`;
    while (drops[key]) key += "+";
    drops[key] = { card: e.card, anchor: e.when, first: e.when, last: e.when, summarySent: null };
    e.dropKey = key;
  }
  const members = {};
  for (const e of list) if (e.dropKey) (members[e.dropKey] = members[e.dropKey] || []).push(e);
  for (const [k, d] of Object.entries(drops)) {
    const m = members[k] || [];
    if (!m.length) { if (!d.summarySent) delete drops[k]; continue; }
    d.first = Math.min(...m.map(e => e.when));
    d.last = Math.max(...m.map(e => e.when));
  }
  return members;
}

function fresh(led, now) {
  led.v = 2;
  led.deliveries = led.deliveries || {};
  led.alerts = led.alerts || [];
  led.outbox = led.outbox || [];
  led.readers = led.readers || {};
  led.fm = led.fm || {};
  led.waLog = led.waLog || [];
  led.sent = led.sent || {};                 // alert keys already sent
  led.startedAt = led.startedAt || now;
  if (!led.drops) {
    /* from the v1 ledger: its drops as they stand now become fixed; one already summarised (or settled
       and old) is marked reported, so nothing from before this version is ever reported again */
    led.drops = {};
    const groups = {};
    for (const e of Object.values(led.deliveries)) if (e.dropKey) (groups[e.dropKey] = groups[e.dropKey] || []).push(e);
    for (const [k, m] of Object.entries(groups)) {
      const first = Math.min(...m.map(e => e.when)), last = Math.max(...m.map(e => e.when));
      const sent = (led.slots && led.slots[k] && led.slots[k].summarySent) || (now - last > FRESH_H * 3600e3 ? now : null);
      led.drops[k] = { card: m[0].card, anchor: first, first, last, summarySent: sent };
    }
  }
  delete led.slots;
  /* an Instagram post not found before the not_visible verdict existed (9 Oct 22:30) — said the new way */
  for (const e of Object.values(led.deliveries)) if (e.channel === "instagram" && e.status === "missing") e.status = "not_visible";
  return led;
}

async function tick({ fm, collect, store, wa, teams = realTeams, now = Date.now(), owner = "tick", force = false }) {
  const t0 = Date.now();
  const lock = await store.lockLedger(owner);
  if (!lock) return { ok: true, skipped: "another tick is running" };
  const led = fresh(lock.ledger, now);
  try {
    return await run(led, lock);
  } catch (e) {
    /* the pipeline itself broke: say so on every channel at once (at most every 30 min — it retries
       every minute), and never leave the ledger locked behind a crash */
    if (!led.lastCrashAlertAt || now - led.lastCrashAlertAt > 30 * 60e3) {
      led.lastCrashAlertAt = now;
      const text = `🚨 *Pipeline check failed* — ${String(e.message || e).slice(0, 200)}. It retries every minute; nothing is lost while it does.`;
      try { if (wa.pushConfigured && wa.pushConfigured()) await wa.push(text, { problem: true, click: PIPELINE_URL, title: "🚨 Pipeline check failed" }); } catch (e2) {}
      try { if (teams.configured()) await teams.post(teams.card([{ kind: "pipeline", text }], { link: PIPELINE_URL })); } catch (e2) {}
      led.outbox = [...(led.outbox || []), { at: now, kind: "pipeline", text: `*SportsFC · FM ↔ channels*\n\n${text}\n\n${PIPELINE_URL}` }];
    }
    try { await store.saveLedger({ ...led, lastCrash: { at: now, error: String(e.stack || e).slice(0, 500) } }, lock.updatedAt, true); } catch (e2) {}
    throw e;
  }

  async function run(led, lock) {
  if (!force && led.lastTickAt && now - led.lastTickAt < MIN_TICK_GAP_MS) {
    await store.saveLedger(led, lock.updatedAt, true);
    return { ok: true, skipped: "too soon after the last tick" };
  }

  const news = [];                           // alerts raised in this tick
  const quiet = when => when < led.startedAt - BACKFILL_QUIET_H * 3600e3;
  /* today (IST) or the last 6 h — a card scheduled ahead counts as current */
  const current = when => istDay(when) === istDay(now) || now - when <= FRESH_H * 3600e3;
  const raise = (key, kind, text, when, extra) => {
    if (led.sent[key]) return;
    led.sent[key] = now;
    /* old news is never news: whatever the ledger says, nothing from an earlier day is notified or logged */
    if (when != null && !current(when)) return;
    const a = { at: now, kind, text, ...(INTERNAL.has(kind) ? { internal: true } : {}) };
    /* the log (on the website) keeps a short copy — the full report goes out in the message */
    led.alerts.unshift({ ...a, text: text.length > 600 ? text.slice(0, 600).replace(/\n[^\n]*$/, "") + "\n…" : text });
    if (!INTERNAL.has(kind) && !quiet(when == null ? now : when)) news.push({ ...a, ...(extra || {}) });
  };
  const errors = [];

  /* the clock stopped (cron-job.org down, GitHub late…): the first tick back says for how long */
  if (led.lastTickAt && now - led.lastTickAt > 10 * 60e3)
    raise(`gap:${led.lastTickAt}`, "pipeline", `🕒 *Pipeline was paused* for ${Math.round((now - led.lastTickAt) / 60e3)} min (no checks from ${ist(led.lastTickAt)} to ${ist(now)} IST) — running again, and anything sent meanwhile is being checked now.`);

  /* ── 1. FM ── */
  let fmRows = null;
  const fmT0 = Date.now();
  try {
    fmRows = await fm({ since: new Date(now - 36 * 3600e3).toISOString() });
    if (!Array.isArray(fmRows)) throw new Error("FM answered with something that is not a list of deliveries");
    const newest = Math.max(...fmRows.map(d => T(d && (d.sentAt || d.queuedAt))).filter(isFinite));
    led.fm = { ok: true, lastOkAt: now, count: fmRows.length, ms: Date.now() - fmT0, newestAt: isFinite(newest) ? newest : null,
               history: [{ at: now, ok: true }, ...((led.fm && led.fm.history) || [])].slice(0, 30) };
  } catch (e) {
    const since = led.fm.failingSince || now;
    led.fm = { ...led.fm, ok: false, lastError: String(e.message || e).slice(0, 300), failingSince: since, lastFailAt: now,
               history: [{ at: now, ok: false }, ...((led.fm && led.fm.history) || [])].slice(0, 30) };
    if (now - since >= FM_DOWN_MIN * 60e3) raise(`fmdown:${istDay(since)}:${Math.floor(since / 7200e3)}`, "fm_down",
      `📡 *FM Deliveries feed unreachable* for ${Math.round((now - since) / 60e3)} min — ${led.fm.lastError}`);
    errors.push("fm: " + led.fm.lastError);
    /* a feed that answers with garbage is the pipeline's own crash (alerted once per 30 min) */
    if (/not a list/.test(led.fm.lastError)) throw e;
  }

  /* ── 2. ledger entries from FM ── */
  const rows = (fmRows || []).filter(d => d && d.cardId);
  /* a card's name when FM leaves the template empty (a CMS-skipped attempt has no template): the
     name its sibling rows of the same set carry */
  const labelOfSet = {};
  for (const d of rows) if (d.setId && d.template && d.template.label && !labelOfSet[d.setId]) labelOfSet[d.setId] = d.template.label;
  const resentAfter = d => rows.find(s => s !== d && s.setId === d.setId && s.language === d.language && s.cardId !== d.cardId &&
                                          SENDABLE.has(s.state) && T(s.queuedAt) - T(d.queuedAt) >= RESEND_GAP_MS);
  for (const d of rows) {
    const route = routeOf(d.channel, d.language);
    /* an account that does not exist yet: FM sends, distribution drops it — not ours to judge */
    if (route.mode === "skip") { delete led.deliveries[d.cardId]; continue; }
    const e = led.deliveries[d.cardId] || { cardId: d.cardId, firstSeen: now, checks: 0, status: "new" };
    const prevMode = e.mode;
    const resend = (d.state === "failed" || d.state === "skipped") ? resentAfter(d) : null;
    const settledOld = SETTLED.has(e.status) && e.when && now - e.when > 6 * 3600e3;
    Object.assign(e, {
      setId: d.setId, channel: d.channel, language: d.language, label: labelOf(d.channel, d.language),
      card: (d.template && d.template.label) || labelOfSet[d.setId] || (e.card && e.card !== "card" ? e.card : "") || pretty(d.collection) || "card",
      caption: String(d.caption || "").slice(0, settledOld ? 200 : 700),
      scheduledAt: d.scheduledAt || null, queuedAt: d.queuedAt || null, sentAt: d.sentAt || null,
      fmState: d.state, fmError: d.error ? String(d.error).slice(0, 200) : null, failureStage: d.failureStage || null,
      mode: route.mode, soft: !!route.soft, why: route.why || null, chId: route.read ? route.read.id : null,
      /* who published is kept only as scheduler / editor — the status page is public, an email is not */
      deliveryMode: d.deliveryMode || null, publishedBy: d.publishedBy ? (/^cron:/.test(d.publishedBy) ? "scheduler" : "editor") : null,
      resentAt: resend ? T(resend.queuedAt) : null, resentSame: resend ? rows.some(s => s.setId === d.setId && s.language === d.language &&
        s.channel === d.channel && s.cardId !== d.cardId && SENDABLE.has(s.state) && T(s.queuedAt) > T(d.queuedAt)) : null,
    });
    /* a channel switched to "verify" since this delivery was filed (its link was added): check it from now on */
    if (prevMode && prevMode !== e.mode && e.mode === "verify" && ["assumed", "unwatched", "unverifiable"].includes(e.status)) e.status = "waiting";
    const when = T(e.sentAt || e.scheduledAt || e.queuedAt) || now;
    e.when = when;
    if (!e.capChecked && d.caption) {
      e.capChecked = true;
      if (d.channel === "x") e.xLen = xPostedLength(d.caption);        // kept: the caption itself is shortened later
      const problem = captionProblem(d.channel, d.caption);
      if (problem) {
        e.capProblem = problem;
        const atLimit = /may be rejected/.test(problem);
        raise(`cap:${e.cardId}`, "caption", `⚠️ *Caption ${atLimit ? "at the limit" : "too long"}* — ${e.label} · ${ist(when)} "${e.card}" — ${problem}` +
          (atLimit ? "." : ". The platform will refuse it — shorten the caption."), when);
      }
    }
    led.deliveries[d.cardId] = e;
  }

  for (const [k, e] of Object.entries(led.deliveries)) if (routeOf(e.channel, e.language).mode === "skip") delete led.deliveries[k];
  /* a late match kept from before the late-match rule (≥ 90% of the words) is looked at again */
  for (const e of Object.values(led.deliveries))
    if (e.status === "late" && e.sim != null && e.sim < 90)
      Object.assign(e, { status: "waiting", postId: null, postAt: null, postUrl: "", lag: null, sim: null, checks: 0 });

  /* ── 3. FM-side states ── */
  for (const e of Object.values(led.deliveries)) {
    if (e.fmState === "failed" || e.fmState === "skipped") {
      if (e.resentAt) { e.status = "superseded"; continue; }      // the content team sent it again
      const since = T(e.queuedAt) || e.when;
      if (now - since < FAIL_HOLD_MIN * 60e3) { e.status = "fm_failing"; continue; }
      e.status = "fm_failed";
      raise(`fmfail:${e.cardId}`, "fm_failed", `🛑 *Not sent — ${e.failureStage === "cms" ? "the CMS skipped it" : "FM failed"}* — ${e.label} · ${ist(e.when)} "${e.card}"` +
        (e.fmError ? ` — ${e.fmError}` : ""), e.when);
    } else if (e.fmState === "unknown") {
      e.status = "fm_unconfirmed";
      raise(`fmunk:${e.cardId}`, "fm_unconfirmed", `❔ *FM can't confirm* — ${e.label} · ${ist(e.when)} "${e.card}" — FM does not know whether it went out`, e.when);
    } else if (e.fmState === "queued" || e.fmState === "sending") {
      const due = T(e.scheduledAt || e.queuedAt);
      e.status = due && now - due >= STUCK_REPORT_MIN * 60e3 ? "fm_stuck" : "fm_pending";
      if (due && now - due >= STUCK_MIN * 60e3)
        raise(`stuck:${e.cardId}`, "fm_stuck", `⏳ *Stuck in FM* — ${e.label} · scheduled ${ist(due)} "${e.card}" is still ${e.fmState} after ${Math.round((now - due) / 60e3)} min`, due);
    } else if (e.fmState === "sent") {
      if (e.mode === "assume") e.status = "assumed";
      else if (e.mode === "unwatched") e.status = "unwatched";
      else if (e.mode === "unverifiable") e.status = "unverifiable";
      else if (["new", "fm_pending", "fm_stuck", "fm_failing", "fm_failed", "fm_other", "superseded"].includes(e.status)) e.status = "waiting";
    } else {
      /* a state FM added later: shown as it is, and never holds a drop back */
      e.status = "fm_other";
    }
  }

  /* ── 4. which channels to read now ── */
  const sinceSent = e => (now - T(e.sentAt)) / 60e3;
  const due = Object.values(led.deliveries).filter(e => {
    if (e.mode !== "verify" || e.fmState !== "sent" || !e.sentAt || !e.chId) return false;
    if (e.status === "verified" || e.status === "late" || e.status === "unverifiable") return false;
    const m = sinceSent(e);
    if (m < FIRST_CHECK_MIN) return false;
    /* past the late limit only a catch-up check (a delivery the pipeline didn't see in time — the read covers
       30 h) is made, and only until it has a verdict */
    if (m > LATE_MAX_MIN && (e.checks || 0) > 0 && SETTLED.has(e.status)) return false;
    if ((MISS.has(e.status) || e.status === "reader_failed") && e.lastCheckAt && now - e.lastCheckAt < RECHECK_MISSING_MIN * 60e3) return false;
    return true;
  });
  const reads = {};
  for (const e of due) if (!reads[e.chId]) reads[e.chId] = routeOf(e.channel, e.language).read;
  /* health probes: a reader not read for 30 min is read now, card due or not (stalest first, a few a tick) */
  const allReaders = {}, softReader = new Set();
  for (const v of Object.values(FM_CHANNELS)) if (v.read && v.mode !== "skip") { allReaders[v.read.id] = v.read; if (v.soft) softReader.add(v.read.id); }
  const lastRead = id => (led.readers[id] || {}).lastReadAt || 0;
  const probes = Object.values(allReaders).filter(rd => !reads[rd.id] && now - lastRead(rd.id) >= PROBE_MIN * 60e3)
    .sort((a, b) => lastRead(a.id) - lastRead(b.id)).slice(0, PROBES_PER_TICK);
  for (const rd of probes) reads[rd.id] = rd;

  const byCh = {};
  if (Object.keys(reads).length) {
    try {
      /* fresh: a read of NOW — never a cached or earlier read (api/collect.js, freshOnly) */
      const out = await collect(Object.values(reads), { hours: 30, noPaid: true, fresh: true });
      for (const r of out.results || []) byCh[r.channelId] = r;
    } catch (e) { errors.push("collect: " + String(e.message || e)); }
    /* a free read that failed at a delivery's last chance gets ONE paid attempt — never on every tick */
    const lastChance = [...new Set(due.filter(e => !e.soft && sinceSent(e) >= WINDOW_MIN && !e.paidTried &&
                                                   byCh[e.chId] && !byCh[e.chId].ok).map(e => e.chId))];
    if (lastChance.length && Date.now() - t0 < 30000) {
      for (const e of due) if (lastChance.includes(e.chId)) e.paidTried = true;
      try {
        const out = await collect(lastChance.map(id => reads[id]), { hours: 30, noPaid: false, fresh: true });
        for (const r of out.results || []) if (r.ok) byCh[r.channelId] = r;
      } catch (e) { errors.push("collect (paid retry): " + String(e.message || e)); }
    }
  }

  /* reader health — every read is recorded (when, how many posts, the newest one), a channel failing twice
     in a row counts as down (shown on the Health page with since when and why), and its recovery too;
     neither is a notification (INTERNAL) */
  for (const id of Object.keys(reads)) {
    const r = byCh[id] || { ok: false, note: "not answered this tick" };
    const h = led.readers[id] || { fails: 0 };
    const newest = Math.max(...(r.posts || []).map(p => T(p.ts)).filter(isFinite));
    Object.assign(h, { lastReadAt: now, history: [{ at: now, ok: !!r.ok }, ...(h.history || [])].slice(0, 30),
      ...(r.ok ? { posts: (r.posts || []).length, newestPostAt: isFinite(newest) ? newest : null } : {}) });
    if (softReader.has(id)) { led.readers[id] = { ...h, ok: !!r.ok, soft: true, ...(r.ok ? { lastOkAt: now, source: r.source, failingSince: null } : { lastFailAt: now, lastError: String(r.note || "").slice(0, 300) }) }; continue; }
    if (r.ok) {
      if (h.down) raise(`up:${id}:${now}`, "reader_up", `🟢 *Reader back* — ${id} is being read again (${r.source})`);
      Object.assign(h, { ok: true, fails: 0, down: false, failingSince: null, lastOkAt: now, source: r.source, lastError: h.lastError || null });
    } else {
      h.fails = (h.fails || 0) + 1;
      Object.assign(h, { ok: false, lastFailAt: now, failingSince: h.failingSince || now, lastError: String(r.note || "").slice(0, 300) });
      if (h.fails >= 2 && !h.down) {
        h.down = true;
        raise(`down:${id}:${now}`, "reader_down", `🔧 *Reader down* — ${id} can't be read: ${String(r.note || "").slice(0, 160)}. Posts there can't be confirmed until it's back.`);
      }
    }
    led.readers[id] = h;
  }

  /* ── 5. match ── */
  const claimed = new Set(Object.values(led.deliveries).filter(e => e.postId).map(e => e.chId + ":" + e.postId));
  /* per channel, every sent and still unmatched delivery against all posts at once — best pairs first.
     Not only the due ones: a post with no caption is matched on time alone, and a card sent a minute
     ago must be there to claim its own post, or an older card that never posted takes it (and the new
     one is then called missing). Only the due deliveries' results are used this tick. */
  const hits = new Map();
  for (const [id, r] of Object.entries(byCh)) if (r.ok) {
    const used = new Set([...claimed].filter(k => k.startsWith(id + ":")).map(k => k.slice(id.length + 1)));
    const open = [...new Set([...due.filter(e => e.chId === id), ...Object.values(led.deliveries).filter(e => e.chId === id && e.mode === "verify" &&
      e.fmState === "sent" && e.sentAt && !e.postId && sinceSent(e) <= LATE_MAX_MIN)])];
    for (const [d, m] of assign(open, r.posts || [], used, WINDOW_MIN, LATE_MAX_MIN)) if (due.includes(d)) hits.set(d, m);
  }
  for (const e of due.sort((a, b) => T(a.sentAt) - T(b.sentAt))) {
    const r = byCh[e.chId];
    e.checks = (e.checks || 0) + 1;
    e.lastCheckAt = now;
    const m = sinceSent(e);
    if (!r || !r.ok) {
      e.readNote = r ? String(r.note || "").slice(0, 200) : "not read this tick";
      if (m >= WINDOW_MIN && !MISS.has(e.status)) {
        /* a soft channel whose page shows no posts at all (an account-wide age wall): nothing to wait for.
           Any other failure is retried every minute for READ_GRACE_MIN more before the drop is reported
           without it — a scraper hiccup of a minute or two must never decide a verdict. */
        if (e.soft && /no posts found/i.test(e.readNote)) e.status = "unverifiable";
        else if (m >= WINDOW_MIN + READ_GRACE_MIN) e.status = "reader_failed";
      }
      continue;
    }
    const hit = hits.get(e) || null;
    if (hit) {
      const was = e.status;
      Object.assign(e, { status: hit.lag <= WINDOW_MIN ? "verified" : "late", postId: hit.post.externalId,
        postAt: hit.post.ts, postUrl: hit.post.permalink || "", lag: Math.round(hit.lag * 10) / 10,
        sim: hit.sim == null ? null : Math.round(hit.sim * 100), readNote: null });
      claimed.add(e.chId + ":" + e.postId);
      if (e.status === "late" && (MISS.has(was) || was === "reader_failed"))
        raise(`late:${e.cardId}`, "late", `🕒 *Arrived late* — ${e.label} · ${ist(e.when)} "${e.card}" — appeared ${Math.round(hit.lag)} min after FM sent it`, e.when);
      continue;
    }
    /* nothing yet: only call it missing once the window is over AND the read could have shown it — it
       reached back past the post's time (a post may be stamped up to 5 min before FM's send), it was
       complete, and it had posts at all (a read with none proves nothing). And never on one read: the
       post must be absent from two reads at least a minute apart. */
    const posts = r.posts || [];
    const oldest = Math.min(...posts.map(p => T(p.ts)).filter(isFinite));
    const covered = posts.length > 0 && !r.partialRead && oldest <= T(e.sentAt) - 5 * 60e3;
    if (m >= WINDOW_MIN) {
      /* a catch-up check of a delivery from before the pipeline ran: the read no longer reaches back that far.
         Nothing is known either way — neutral, not a problem */
      if (!covered && m > LATE_MAX_MIN) { e.readNote = "too old to check — sent before the pipeline was watching"; e.status = "unchecked"; continue; }
      if (!covered) {
        e.readNote = !posts.length ? "the read returned no posts" : r.partialRead ? "the read was partial — " + String(r.note || "").slice(0, 140)
          : "the read did not reach back to this post's time";
        if (m >= WINDOW_MIN + READ_GRACE_MIN) e.status = "reader_failed";
        continue;
      }
      e.absent = (e.absent || 0) + 1;
      if (!MISS.has(e.status) && e.absent < 2) continue;
      if (!MISS.has(e.status) && e.channel === "instagram") {
        e.status = "not_visible";
        raise(`miss:${e.cardId}`, "not_visible", `⚠️ *Check by hand* — ${e.label} · ${ist(e.when)} "${e.card}" — not on the public profile 20 min after FM sent it. ` +
          `It may be 18+ restricted by Instagram (our reader can't see those) or not posted — please check in the app.`, e.when);
      } else if (!MISS.has(e.status)) {
        e.status = "missing";
        raise(`miss:${e.cardId}`, "missing", `❌ *Missing* — ${e.label} · ${ist(e.when)} "${e.card}" — FM sent it at ${ist(T(e.sentAt))}, not on the channel after ${WINDOW_MIN} min` +
          (e.capProblem ? ` — likely why: ${e.capProblem}` : ""), e.when);
      }
    }
  }
  const unconfirmed = {};
  for (const e of Object.values(led.deliveries))
    if (e.status === "reader_failed" && e.mode === "verify" && sinceSent(e) >= WINDOW_MIN && !led.sent[`rf:${e.cardId}`] && !(led.readers[e.chId] || {}).down)
      (unconfirmed[e.chId] = unconfirmed[e.chId] || []).push(e);
  for (const [id, list] of Object.entries(unconfirmed)) {
    for (const e of list) led.sent[`rf:${e.cardId}`] = now;
    const last = Math.max(...list.map(e => e.when));
    raise(`rfch:${id}:${now}`, "reader_failed", `🔧 *Can't confirm* — ${list[0].label}: ${list.length} post${list.length === 1 ? "" : "s"} (` +
      list.sort((a, b) => a.when - b.when).map(e => ist(e.when)).join(", ") + `) — the channel couldn't be read: ${list[0].readNote || "unknown"}`, last);
  }

  /* ── 6. keep the daily-check report current ──
     Only a read that brings a post the report hasn't had is merged: a merge reads and rewrites the whole
     shared report row (~0.5 MB), and the health probes read 3 channels every minute. */
  const seen = id => new Set((led.readers[id] || {}).seenIds || []);
  const okReads = Object.values(byCh).filter(r => r.ok && (r.posts || []).some(p => p && p.externalId && !seen(r.channelId).has(p.externalId)));
  if (okReads.length) {
    try {
      const m = await store.mergeIntoReport(okReads, now);
      led.lastReportMerge = { at: now, added: m.added, channels: okReads.length };
      for (const r of okReads) if (led.readers[r.channelId]) led.readers[r.channelId].seenIds = (r.posts || []).map(p => p.externalId).filter(Boolean).slice(0, 40);
    } catch (e) { errors.push("report merge: " + String(e.message || e)); }
  }

  /* ── 7. drop reports: once every delivery of a drop is settled — once per drop, ever, and only a current one ── */
  const members = placeDrops(led);
  for (const [key, list] of Object.entries(members)) {
    const drop = led.drops[key];
    if (drop.summarySent) continue;
    if (!list.every(e => SETTLED.has(e.status))) continue;
    if (list.some(e => e.mode === "verify" && e.fmState === "sent" && sinceSent(e) < WINDOW_MIN)) continue;
    drop.summarySent = now;
    if (!current(drop.last)) { drop.stale = true; continue; }     // never a report about an earlier day
    /* the full drop report (pipeline/report.js): every channel per language, when it landed, how fast,
       what wasn't checked and why, every problem with its reason — and a first attempt the content team
       sent again */
    const sets = new Set(list.map(e => e.setId));
    const retried = Object.values(led.deliveries).filter(e => e.status === "superseded" && sets.has(e.setId));
    const d = dropData(list, { retried });
    const title = (d.problems.length ? "⚠️ " : "✅ ") + `${ist(d.when)} ${d.card} — ` +
      (d.notSent ? `not sent — FM/CMS failed on ${d.problems.length} channel${d.problems.length === 1 ? "" : "s"}`
        : d.problems.length ? `${d.problems.length} problem${d.problems.length === 1 ? "" : "s"}` : `all delivered (${d.ok}/${d.checked})`);
    raise(`slot:${key}`, "slot", dropText(d), drop.last, { report: d, title });
  }

  /* ── 8. the day's summary (after 23:00 IST, once a day): what reached the channels, what needs attention ── */
  const day = istDay(now);
  if (new Date(now + 5.5 * 3600e3).getUTCHours() >= 23 && led.lastDigestDay !== day) {
    /* one time, from the summary that only looked at its own day: what it already covered stays covered */
    if (!led.summaryV) { for (const e of Object.values(led.deliveries)) if (led.lastDigestDay && istDay(e.when) <= led.lastDigestDay) e.summarized = led.lastDigestDay; led.summaryV = 1; }
    led.lastDigestDay = day;
    /* everything not in a summary yet: today's, and anything from last night that was still being checked
       (or went out after 23:00) when the last summary was sent — each delivery is in exactly one summary */
    const pool = Object.values(led.deliveries).filter(e => !e.summarized && e.when <= now && now - e.when < 2 * 86400e3);
    const todays = pool.filter(e => SETTLED.has(e.status) || e.status === "superseded");
    const pending = pool.filter(e => e.status !== "superseded" && !todays.includes(e)).length;   // in tomorrow's summary
    for (const e of todays) e.summarized = day;
    if (todays.some(e => e.status !== "superseded")) {
      const s = dayData(todays, day, { pending });
      raise(`digest:${day}`, "digest", dayText(s), null, { digest: s,
        title: (s.attention.length ? "⚠️ " : "✅ ") + `Daily summary ${day.slice(8)}/${day.slice(5, 7)} — ${s.ok}/${s.checked} reached` +
          (s.attention.length ? ` · ${s.attention.length} need${s.attention.length === 1 ? "s" : ""} attention` : "") });
    }
  }

  /* ── 9. notify: problems together in one message; every drop report as a message of its own ──
     (a report is a few KB — several in one would pass ntfy's 4 KB and Teams' 28 KB) */
  if (news.length) {
    const order = ["pipeline", "fm_down", "fm_failed", "missing", "not_visible", "caption", "fm_stuck", "fm_unconfirmed", "reader_down", "reader_failed", "late", "reader_up", "slot", "digest"];
    news.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind));
    /* a drop report and the day's summary are each a message of their own */
    const plain = news.filter(x => !x.report && !x.digest), reports = news.filter(x => x.report || x.digest);
    const messages = [];
    if (plain.length) messages.push({ kind: plain[0].kind, alerts: plain,
      text: `*SportsFC · FM ↔ channels*\n\n${plain.map(x => x.text).join("\n\n")}\n\n${PIPELINE_URL}`,
      title: (plain[0].title || plain[0].text.split("\n")[0].replace(/\*/g, "")).slice(0, 110) + (plain.length > 1 ? `  (+${plain.length - 1} more)` : ""),
      problem: plain.some(x => !["reader_up"].includes(x.kind)) });
    for (const r of reports) messages.push({ kind: r.kind, alerts: [r], text: `${r.text}\n\n${PIPELINE_URL}`, title: r.title || "Drop report",
      problem: r.report ? r.report.problems.length > 0 : r.digest.attention.length > 0 });
    for (const m of messages) {
      led.outbox.push({ at: now, kind: m.kind, text: m.text });
      if (teams.configured()) led.teamsOutbox = [...(led.teamsOutbox || []), { at: now, kind: m.kind, payload: teams.card(m.alerts, { link: PIPELINE_URL }) }];
      /* the phone push (ntfy) goes out at once; its title is the result itself, so the lock screen says it */
      if (wa.pushConfigured && wa.pushConfigured()) {
        try { await wa.push(m.text, { problem: m.problem, click: PIPELINE_URL, title: m.title }); led.waLog.unshift({ at: now, ok: true, via: "push", kind: m.kind }); }
        catch (e) { led.waLog.unshift({ at: now, ok: false, via: "push", error: String(e.message || e).slice(0, 200) }); }
      }
    }
  }
  /* Microsoft Teams: one Adaptive Card per message, queued and retried */
  led.teamsOutbox = (led.teamsOutbox || []).filter(m => now - m.at < 3 * 3600e3);
  if (led.teamsOutbox.length) {
    try {
      const { left, log } = await teams.flush(led.teamsOutbox);
      led.teamsOutbox = left;
      led.waLog = [...log, ...led.waLog].slice(0, 60);
    } catch (e) { errors.push("teams: " + String(e.message || e)); }
  }

  /* a message that could not go out for 3 h (WhatsApp not set up, or down) is stale — dropped, still in the log */
  led.outbox = led.outbox.filter(m => !m.at || now - m.at < 3 * 3600e3);
  if (led.outbox.length) {
    try {
      const { left, log } = await wa.flush(led.outbox, { now });
      led.outbox = left;
      led.waLog = [...log, ...led.waLog].slice(0, 60);
    } catch (e) { errors.push("whatsapp: " + String(e.message || e)); }
  }

  /* ── 10. tidy and save — a drop is cleaned up only as a whole (see the header) ── */
  const keepFrom = now - KEEP_DAYS * 86400e3;
  for (const [k, d] of Object.entries(led.drops)) if (d.last < keepFrom) {
    for (const e of members[k] || []) delete led.deliveries[e.cardId];
    delete led.drops[k];
  }
  for (const [k, e] of Object.entries(led.deliveries)) if (!e.dropKey && (e.when || e.firstSeen) < keepFrom) delete led.deliveries[k];
  /* alert keys outlive what they are about by a day, so nothing is ever "new" twice */
  for (const [k, at] of Object.entries(led.sent)) if (at < keepFrom - 86400e3) delete led.sent[k];
  led.alerts = led.alerts.slice(0, 150);
  led.outbox = led.outbox.slice(-20);
  led.lastTickAt = now;
  led.ticks = (led.ticks || 0) + 1;
  led.lastTick = { at: now, ms: Date.now() - t0, fm: fmRows ? fmRows.length : null, read: Object.keys(reads), probes: probes.map(p => p.id),
                   checked: due.length, alerts: news.length, errors };
  led.tickLog = [{ at: now, ms: led.lastTick.ms, errors: errors.length }, ...(led.tickLog || [])].slice(0, 60);
  await store.saveLedger(led, lock.updatedAt, true);
  return { ok: true, ...led.lastTick };
  }
}

module.exports = { tick, placeDrops, WINDOW_MIN, PIPELINE_URL, FRESH_H, PROBE_MIN };
