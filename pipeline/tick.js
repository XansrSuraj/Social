/**
 * One tick of the FM → channels pipeline. Run every few minutes (api/pipeline.js?op=tick).
 *
 *   1. read FM Deliveries (prod) for the last 36 h — what was scheduled / sent, to which channel
 *   2. check every new card's caption against the platform's limits (X 280 by X's own count, …)
 *   3. for each delivery FM has sent, read only the channels now due and look for the post —
 *      matched on time AND words (FM gives the exact caption)
 *   4. decide: verified (inside 20 min) · late · missing · reader failed · assumed (Viber) ·
 *      not watched (no link yet) · can't verify (Instagram 18+) · FM failed / stuck
 *   5. merge what was read into the daily-check report, so the website stays current
 *   6. WhatsApp: problems the moment they are known, a summary when a drop is fully settled,
 *      a digest at night — every alert sent once (keys in the ledger), batched into few messages
 *
 * Every outside thing is passed in (fm, collect, store, wa, now), so the whole tick is tested
 * end to end without a network (test/pipeline.test.js).
 */
const { routeOf, labelOf } = require("./channels.js");
const { captionProblem, assign } = require("./rules.js");
const realTeams = require("./teams.js");
const { dropData, dropText } = require("./report.js");

const WINDOW_MIN = 20;            // every channel normally shows the post within ~5 min; 20 is the buffer
const FIRST_CHECK_MIN = 2;        // first look 2 min after FM sent it
const LATE_MAX_MIN = 180;         // keep looking for a missing post this long, to report a late arrival
const RECHECK_MISSING_MIN = 15;   // …but only every 15 min once it is past the window
const READ_GRACE_MIN = 10;        // a channel that can't be read at the 20-min mark gets 10 more minutes of retries
/* Scraper health — a reader failing, coming back, a post that couldn't be checked — is shown on the Live
   page (System status) and never sent as a notification: the free readers hiccup for a minute or two and
   recover on their own (FxTwitter answering 404 for X, 8 Oct), and the drop report already says when a
   channel could not be checked. (2026-10-08, at the user's request.) */
const INTERNAL = new Set(["reader_down", "reader_up", "reader_failed"]);
const STUCK_MIN = 15;             // FM still not sent 15 min after the scheduled time
const FM_DOWN_MIN = 15;
const BACKFILL_QUIET_H = 3;       // on the very first tick, stay quiet about anything older than this
const KEEP_DAYS = 3;
const MIN_TICK_GAP_MS = 40000;
const PIPELINE_URL = "https://aiko-social-distribution-check.vercel.app/#/live";

const SHORT = { youtube: "YouTube", telegram: "Telegram", telegram_direct: "Bot", x: "X", facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", viber: "Viber" };
const FLAG = { vietnamese: "🇻🇳 ", english: "🇬🇧 ", portuguese: "🇧🇷 ", hindi: "🇮🇳 " };
const LANG_SHORT = { vietnamese: "VN", english: "EN", portuguese: "PT", hindi: "HI" };
const PROBLEM = { missing: `not on the channel 20 min after FM sent it`, reader_failed: "couldn't be checked — the channel couldn't be read",
                  fm_failed: "FM failed to send it", fm_unconfirmed: "FM can't confirm it went out" };

const FINAL = new Set(["verified", "late", "assumed", "unwatched", "unverifiable", "fm_failed", "fm_unconfirmed"]);
const SETTLED = new Set([...FINAL, "missing", "reader_failed", "unchecked"]);
const ist = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16);
const istDay = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const T = (iso) => Date.parse(iso);

/* Group deliveries into drops: the same card going out within 20 min (every language, every channel)
   is one drop. Keyed by card + the first delivery's minute; each delivery carries its dropKey so
   the Live page groups exactly the same way. */
function dropsOf(deliveries) {
  const groups = [];
  for (const e of Object.values(deliveries).sort((a, b) => a.when - b.when)) {
    const g = groups.find(x => x.card === e.card && e.when - x.first <= 20 * 60e3);
    if (g) g.list.push(e); else groups.push({ card: e.card, first: e.when, list: [e] });
  }
  const out = {};
  for (const g of groups) {
    const key = `${g.card}@${new Date(g.first).toISOString().slice(0, 16)}`;
    for (const e of g.list) e.dropKey = key;
    out[key] = g.list;
  }
  return out;
}

function fresh(led, now) {
  led.v = 1;
  led.deliveries = led.deliveries || {};
  led.alerts = led.alerts || [];
  led.outbox = led.outbox || [];
  led.readers = led.readers || {};
  led.slots = led.slots || {};
  led.fm = led.fm || {};
  led.waLog = led.waLog || [];
  led.sent = led.sent || {};                 // alert keys already sent
  led.startedAt = led.startedAt || now;
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
  const raise = (key, kind, text, when, extra) => {
    if (led.sent[key]) return;
    led.sent[key] = now;
    const a = { at: now, kind, text, ...(INTERNAL.has(kind) ? { internal: true } : {}) };
    led.alerts.unshift(a);                       // the log keeps the text; the full report rides on the alert only
    if (!INTERNAL.has(kind) && !quiet(when == null ? now : when)) news.push({ ...a, ...(extra || {}) });
  };
  const errors = [];

  /* the clock stopped (cron-job.org down, GitHub late…): the first tick back says for how long */
  if (led.lastTickAt && now - led.lastTickAt > 10 * 60e3)
    raise(`gap:${led.lastTickAt}`, "pipeline", `🕒 *Pipeline was paused* for ${Math.round((now - led.lastTickAt) / 60e3)} min (no checks from ${ist(led.lastTickAt)} to ${ist(now)} IST) — running again, and anything sent meanwhile is being checked now.`);

  /* ── 1. FM ── */
  let fmRows = null;
  try {
    fmRows = await fm({ since: new Date(now - 36 * 3600e3).toISOString() });
    led.fm = { ok: true, lastOkAt: now, count: fmRows.length };
  } catch (e) {
    const since = led.fm.failingSince || now;
    led.fm = { ...led.fm, ok: false, lastError: String(e.message || e).slice(0, 300), failingSince: since };
    if (now - since >= FM_DOWN_MIN * 60e3) raise(`fmdown:${istDay(since)}:${Math.floor(since / 7200e3)}`, "fm_down",
      `📡 *FM Deliveries feed unreachable* for ${Math.round((now - since) / 60e3)} min — ${led.fm.lastError}`);
    errors.push("fm: " + led.fm.lastError);
  }

  /* ── 2. ledger entries from FM ── */
  for (const d of fmRows || []) {
    if (!d || !d.cardId) continue;
    const route = routeOf(d.channel, d.language);
    /* an account that does not exist yet: FM sends, distribution drops it — not ours to judge */
    if (route.mode === "skip") { delete led.deliveries[d.cardId]; continue; }
    const e = led.deliveries[d.cardId] || { cardId: d.cardId, firstSeen: now, checks: 0, status: "new" };
    const prevMode = e.mode;
    Object.assign(e, {
      setId: d.setId, channel: d.channel, language: d.language, label: labelOf(d.channel, d.language),
      card: (d.template && d.template.label) || d.collection || "card",
      caption: String(d.caption || "").slice(0, 700),
      scheduledAt: d.scheduledAt || null, queuedAt: d.queuedAt || null, sentAt: d.sentAt || null,
      fmState: d.state, fmError: d.error ? String(d.error).slice(0, 200) : null, failureStage: d.failureStage || null,
      mode: route.mode, soft: !!route.soft, why: route.why || null, chId: route.read ? route.read.id : null,
      /* who published is kept only as scheduler / editor — the status page is public, an email is not */
      deliveryMode: d.deliveryMode || null, publishedBy: d.publishedBy ? (/^cron:/.test(d.publishedBy) ? "scheduler" : "editor") : null,
    });
    /* a channel switched to "verify" since this delivery was filed (its link was added): check it from now on */
    if (prevMode && prevMode !== e.mode && e.mode === "verify" && ["assumed", "unwatched", "unverifiable"].includes(e.status)) e.status = "waiting";
    const when = T(e.sentAt || e.scheduledAt || e.queuedAt) || now;
    e.when = when;
    if (!e.capChecked) {
      e.capChecked = true;
      const problem = captionProblem(d.channel, d.caption);
      if (problem) {
        e.capProblem = problem;
        const atLimit = /may be rejected/.test(problem);
        raise(`cap:${e.cardId}`, "caption", `⚠️ *Caption ${atLimit ? "at the limit" : "too long"}* — ${e.label} · ${ist(when)} "${e.card}" — ${problem}` +
          (atLimit ? "" : ". The platform will likely reject it."), when);
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
      e.status = "fm_failed";
      raise(`fmfail:${e.cardId}`, "fm_failed", `🛑 *FM ${e.fmState}* — ${e.label} · ${ist(e.when)} "${e.card}"` +
        (e.failureStage ? ` — stage: ${e.failureStage}` : "") + (e.fmError ? ` — ${e.fmError}` : ""), e.when);
    } else if (e.fmState === "unknown") {
      e.status = "fm_unconfirmed";
      raise(`fmunk:${e.cardId}`, "fm_unconfirmed", `❔ *FM can't confirm* — ${e.label} · ${ist(e.when)} "${e.card}" — FM does not know whether it went out`, e.when);
    } else if (e.fmState === "queued" || e.fmState === "sending") {
      e.status = "fm_pending";
      const due = T(e.scheduledAt || e.queuedAt);
      if (due && now - due >= STUCK_MIN * 60e3)
        raise(`stuck:${e.cardId}`, "fm_stuck", `⏳ *Stuck in FM* — ${e.label} · scheduled ${ist(due)} "${e.card}" is still ${e.fmState} after ${Math.round((now - due) / 60e3)} min`, due);
    } else if (e.fmState === "sent") {
      if (e.mode === "assume") e.status = "assumed";
      else if (e.mode === "unwatched") e.status = "unwatched";
      else if (e.mode === "unverifiable") e.status = "unverifiable";
      else if (e.status === "new" || e.status === "fm_pending") e.status = "waiting";
    }
  }

  /* ── 4. which channels to read now ── */
  const sinceSent = e => (now - T(e.sentAt)) / 60e3;
  const due = Object.values(led.deliveries).filter(e => {
    if (e.mode !== "verify" || e.fmState !== "sent" || !e.sentAt || !e.chId) return false;
    if (e.status === "verified" || e.status === "late" || e.status === "unverifiable") return false;
    const m = sinceSent(e);
    if (m < FIRST_CHECK_MIN) return false;
    /* past the late limit only a delivery never looked at gets its one catch-up check (the read covers 30 h) */
    if (m > LATE_MAX_MIN && (e.checks || 0) > 0) return false;
    if ((e.status === "missing" || e.status === "reader_failed") && e.lastCheckAt && now - e.lastCheckAt < RECHECK_MISSING_MIN * 60e3) return false;
    return true;
  });
  const reads = {};
  for (const e of due) if (!reads[e.chId]) reads[e.chId] = routeOf(e.channel, e.language).read;

  const byCh = {};
  if (Object.keys(reads).length) {
    try {
      const out = await collect(Object.values(reads), { hours: 30, noPaid: true });
      for (const r of out.results || []) byCh[r.channelId] = r;
    } catch (e) { errors.push("collect: " + String(e.message || e)); }
    /* a free read that failed at a delivery's last chance gets ONE paid attempt — never on every tick */
    const lastChance = [...new Set(due.filter(e => !e.soft && sinceSent(e) >= WINDOW_MIN && !e.paidTried &&
                                                   byCh[e.chId] && !byCh[e.chId].ok).map(e => e.chId))];
    if (lastChance.length && Date.now() - t0 < 30000) {
      for (const e of due) if (lastChance.includes(e.chId)) e.paidTried = true;
      try {
        const out = await collect(lastChance.map(id => reads[id]), { hours: 30, noPaid: false });
        for (const r of out.results || []) if (r.ok) byCh[r.channelId] = r;
      } catch (e) { errors.push("collect (paid retry): " + String(e.message || e)); }
    }
  }

  /* reader health — a channel failing twice in a row counts as down (shown on the Live page with since
     when and why), and its recovery too; neither is a notification (INTERNAL) */
  const softIds = new Set(due.filter(e => e.soft).map(e => e.chId));
  for (const [id, r] of Object.entries(byCh)) {
    const h = led.readers[id] || { fails: 0 };
    if (softIds.has(id)) { led.readers[id] = { ...h, ok: !!r.ok, soft: true, ...(r.ok ? { lastOkAt: now, source: r.source } : { lastFailAt: now, lastError: String(r.note || "").slice(0, 300) }) }; continue; }
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
  /* per channel, all due deliveries against all posts at once — best pairs first */
  const hits = new Map();
  for (const [id, r] of Object.entries(byCh)) if (r.ok) {
    const used = new Set([...claimed].filter(k => k.startsWith(id + ":")).map(k => k.slice(id.length + 1)));
    for (const [d, m] of assign(due.filter(e => e.chId === id), r.posts || [], used, WINDOW_MIN, LATE_MAX_MIN)) hits.set(d, m);
  }
  for (const e of due.sort((a, b) => T(a.sentAt) - T(b.sentAt))) {
    const r = byCh[e.chId];
    e.checks = (e.checks || 0) + 1;
    e.lastCheckAt = now;
    const m = sinceSent(e);
    if (!r || !r.ok) {
      e.readNote = r ? String(r.note || "").slice(0, 200) : "not read this tick";
      if (m >= WINDOW_MIN && e.status !== "missing") {
        /* Instagram's 18+ wall (its embed shows no posts): nothing to wait for. Any other failure is
           retried every minute for READ_GRACE_MIN more before the drop is reported without it — a
           scraper hiccup of a minute or two must never decide a verdict. */
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
      if (e.status === "late" && (was === "missing" || was === "reader_failed"))
        raise(`late:${e.cardId}`, "late", `🕒 *Arrived late* — ${e.label} · ${ist(e.when)} "${e.card}" — appeared ${Math.round(hit.lag)} min after FM sent it`, e.when);
      continue;
    }
    /* nothing yet: only call it missing once the window is over AND the read reached back that far */
    const oldest = Math.min(...(r.posts || []).map(p => T(p.ts)).filter(isFinite));
    const covered = !(r.posts || []).length || oldest <= T(e.sentAt) + 60e3;
    if (m >= WINDOW_MIN) {
      /* a catch-up check of a delivery from before the pipeline ran: the read no longer reaches back that far.
         Nothing is known either way — neutral, not a problem */
      if (!covered && m > LATE_MAX_MIN) { e.readNote = "too old to check — sent before the pipeline was watching"; e.status = "unchecked"; continue; }
      if (!covered) { e.readNote = "the read did not reach back to this post's time"; e.status = "reader_failed"; continue; }
      if (e.status !== "missing") {
        e.status = "missing";
        raise(`miss:${e.cardId}`, "missing", `❌ *Missing* — ${e.label} · ${ist(e.when)} "${e.card}" — FM sent it at ${ist(T(e.sentAt))}, not on the channel after ${WINDOW_MIN} min` +
          (e.capProblem ? ` (likely why: ${e.capProblem})` : ""), e.when);
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

  /* ── 6. keep the daily-check report current ── */
  const okReads = Object.values(byCh).filter(r => r.ok);
  if (okReads.length) {
    try { const m = await store.mergeIntoReport(okReads, now); led.lastReportMerge = { at: now, added: m.added, channels: okReads.length }; }
    catch (e) { errors.push("report merge: " + String(e.message || e)); }
  }

  /* ── 7. drop summaries, once every delivery of a drop is settled ── */
  const bySet = dropsOf(led.deliveries);
  for (const [setId, list] of Object.entries(bySet)) {
    const slot = led.slots[setId] = led.slots[setId] || {};
    if (slot.summarySent) continue;
    const sentOnes = list.filter(e => e.fmState === "sent");
    if (!list.every(e => SETTLED.has(e.status))) continue;
    if (list.some(e => e.mode === "verify" && e.fmState === "sent" && sinceSent(e) < WINDOW_MIN)) continue;
    slot.summarySent = now;
    /* the full drop report (pipeline/report.js): every channel per language, when it landed, how fast,
       what wasn't checked and why, and every problem with its reason */
    const d = dropData(list);
    const title = (d.problems.length ? "⚠️ " : "✅ ") + `${ist(d.when)} ${d.card} — ` +
      (d.problems.length ? `${d.problems.length} problem${d.problems.length === 1 ? "" : "s"}` : `all delivered (${d.ok}/${d.checked})`);
    raise(`slot:${setId}`, "slot", dropText(d), d.when, { report: d, title });
  }

  /* ── 8. the nightly digest (after 23:00 IST, once a day) ── */
  const day = istDay(now);
  if (new Date(now + 5.5 * 3600e3).getUTCHours() >= 23 && led.lastDigestDay !== day) {
    led.lastDigestDay = day;
    const todays = Object.values(led.deliveries).filter(e => istDay(e.when) === day);
    if (todays.length) {
      const c = s => todays.filter(e => e.status === s).length;
      raise(`digest:${day}`, "digest", [`📊 *Today ${day}* — ${todays.length} FM deliveries in ${new Set(todays.map(e => e.dropKey || e.setId)).size} drops`,
        `✓ ${c("verified") + c("late")} confirmed (${c("late")} late) · ❌ ${c("missing")} missing · 🔧 ${c("reader_failed")} couldn't check`,
        `≈ ${c("assumed")} Viber assumed · – ${c("unwatched")} not watched yet · ? ${c("unverifiable")} IG 18+`,
        `🛑 FM failed ${c("fm_failed")} · caption problems ${todays.filter(e => e.capProblem).length}`].join("\n"));
    }
  }

  /* ── 9. notify: problems together in one message; every drop report as a message of its own ──
     (a report is a few KB — several in one would pass ntfy's 4 KB and Teams' 28 KB) */
  if (news.length) {
    const order = ["pipeline", "fm_down", "fm_failed", "missing", "caption", "fm_stuck", "fm_unconfirmed", "reader_down", "reader_failed", "late", "reader_up", "slot", "digest"];
    news.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind));
    const plain = news.filter(x => !x.report), reports = news.filter(x => x.report);
    const messages = [];
    if (plain.length) messages.push({ kind: plain[0].kind, alerts: plain,
      text: `*SportsFC · FM ↔ channels*\n\n${plain.map(x => x.text).join("\n\n")}\n\n${PIPELINE_URL}`,
      title: (plain[0].title || plain[0].text.split("\n")[0].replace(/\*/g, "")).slice(0, 110) + (plain.length > 1 ? `  (+${plain.length - 1} more)` : ""),
      problem: plain.some(x => !["digest", "reader_up"].includes(x.kind)) });
    for (const r of reports) messages.push({ kind: "slot", alerts: [r], text: `${r.text}\n\n${PIPELINE_URL}`, title: r.title || "Drop report", problem: r.report.problems.length > 0 });
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

  /* ── 10. tidy and save ── */
  const keepFrom = now - KEEP_DAYS * 86400e3;
  for (const [k, e] of Object.entries(led.deliveries)) if ((e.when || e.firstSeen) < keepFrom) delete led.deliveries[k];
  for (const k of Object.keys(led.slots)) if (!bySet[k]) delete led.slots[k];
  for (const [k, at] of Object.entries(led.sent)) if (at < keepFrom) delete led.sent[k];
  led.alerts = led.alerts.slice(0, 300);
  led.outbox = led.outbox.slice(-20);
  led.lastTickAt = now;
  led.ticks = (led.ticks || 0) + 1;
  led.lastTick = { at: now, ms: Date.now() - t0, fm: fmRows ? fmRows.length : null, read: Object.keys(reads), checked: due.length,
                   alerts: news.length, errors };
  await store.saveLedger(led, lock.updatedAt, true);
  return { ok: true, ...led.lastTick };
  }
}

module.exports = { tick, WINDOW_MIN, PIPELINE_URL };
