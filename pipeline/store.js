/**
 * Where the pipeline keeps its state, and how it feeds the daily-check report.
 *
 *   ledger  — orghub_state row 5: one entry per FM delivery and what became of it, the alert log,
 *             reader health, the WhatsApp outbox, and the tick lock. Only the pipeline writes it.
 *   report  — orghub_state row 3: the SportsFC daily-check report the website reads. The pipeline
 *             merges the posts it reads into it, so the report stays current with nobody pressing
 *             Run. That row is also written by browsers, so every write here is conditional on the
 *             row not having changed since it was read (compare-and-set on updated_at) and retried —
 *             a browser's save is never overwritten by a stale copy. The content team's "Run everything"
 *             (api/collect.js, teamRun) is merged in here too — row 3, or MatchPulse's row 4.
 *
 * Without Supabase (local development) both live in files beside the app.
 */
const fs = require("fs");
const path = require("path");

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const TABLE = "orghub_state";
const LEDGER_ROW = 5, REPORT_ROW = 3, MATCHPULSE_ROW = 4, CLAIMS_ROW = 6;
const FILES = { [LEDGER_ROW]: path.join(__dirname, "..", ".pipeline.json"), [REPORT_ROW]: path.join(__dirname, "..", ".report-local.json"),
                [MATCHPULSE_ROW]: path.join(__dirname, "..", ".report-local-matchpulse.json"), [CLAIMS_ROW]: path.join(__dirname, "..", ".claims-local.json") };

const configured = () => !!(SB_URL && SB_KEY);
/* Every string made well-formed before it is sent: a text cut through the middle of an emoji leaves half a
   surrogate pair, and Supabase refuses the whole row as "Empty or invalid json" (14 Oct 2026, 23:00 — the
   ledger could not be saved, so the day's summary and the crash alert went out every minute). */
const wellFormed = v => JSON.stringify(v, (k, x) => (typeof x === "string" && x.toWellFormed ? x.toWellFormed() : x));
const sbHeaders = extra => Object.assign({ apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" }, extra || {});
class Conflict extends Error {}

async function readRow(id) {
  if (!configured()) {
    try { return JSON.parse(fs.readFileSync(FILES[id], "utf8")); } catch (e) { return { data: null, updatedAt: null }; }
  }
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${id}&select=data,updated_at`, { headers: sbHeaders(), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`store read failed (${r.status})`);
  const rows = await r.json();
  return rows && rows[0] ? { data: rows[0].data, updatedAt: rows[0].updated_at } : { data: null, updatedAt: null };
}

/* write only if the row is still at `base` (null = the row must not exist yet) */
async function writeRow(id, data, base) {
  const now = new Date().toISOString();
  if (!configured()) {
    const cur = (() => { try { return JSON.parse(fs.readFileSync(FILES[id], "utf8")); } catch (e) { return { updatedAt: null }; } })();
    if ((cur.updatedAt || null) !== (base || null)) throw new Conflict("changed meanwhile");
    fs.writeFileSync(FILES[id], JSON.stringify({ data, updatedAt: now }));
    return now;
  }
  if (!base) {
    /* first write: insert, refusing if someone created it meanwhile */
    const w = await fetch(`${SB_URL}/rest/v1/${TABLE}?select=id`, { method: "POST", headers: sbHeaders({ Prefer: "return=representation" }),
      body: wellFormed([{ id, data, updated_at: now }]), signal: AbortSignal.timeout(15000) });
    if (w.status === 409) throw new Conflict("created meanwhile");
    if (!w.ok) throw new Error(`store insert failed (${w.status}): ${(await w.text()).slice(0, 200)}`);
    return now;
  }
  /* select=id: the answer is the matched row's id only (an empty list = it changed meanwhile), not the whole row */
  const w = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${id}&updated_at=eq.${encodeURIComponent(base)}&select=id`, {
    method: "PATCH", headers: sbHeaders({ Prefer: "return=representation" }),
    body: wellFormed({ data, updated_at: now }), signal: AbortSignal.timeout(15000) });
  if (!w.ok) throw new Error(`store write failed (${w.status}): ${(await w.text()).slice(0, 200)}`);
  const rows = await w.json();
  if (!Array.isArray(rows) || !rows.length) throw new Conflict("changed meanwhile");
  return now;
}

/* ── the ledger, with a lock so two ticks never work on it at once ──
   Supabase's free plan counts every byte it sends back (egress, 5 GB a month), and reading the whole
   ledger every minute used most of it — the quota was exceeded in September 2026. So this instance keeps
   the copy it last read or wrote, and a tick takes the lock by writing onto that copy *conditionally*
   (compare-and-set on updated_at): if the row is still what this instance last saw, no read is needed at
   all; if anything else wrote it meanwhile (another instance, a test alert), the write is refused and the
   row is read as before. Writes send the row (ingress, free) and get back only its id. */
const LOCK_MS = 150000;
const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
let mem = null;                                   // { data, updatedAt, at } — this instance's last known copy
const remember = (data, updatedAt) => { mem = { data: clone(data), updatedAt, at: Date.now() }; };
/* Anyone may call op=tick (cron-job.org does, every minute), so a call that can't run — the lock is held, or
   the last tick was under opts.minGapMs ago — must cost almost nothing: decided from this instance's copy
   when it can be (a copy saying "too soon" is never wrong — the real last tick can only be later), else from
   the lock and the last tick's time alone (a few bytes, not the ~0.3 MB row). Returns the lock, null (another
   tick holds it) or { tooSoon: true }. (15 Oct 2026 review: a loop of calls read the whole ledger each time.) */
async function peekLedger() {
  if (!configured()) { const { data, updatedAt } = await readRow(LEDGER_ROW); const d = data || {}; return { updatedAt, lock: d.lock || null, last: d.lastTickAt || null }; }
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${LEDGER_ROW}&select=updated_at,lock:data->lock,last:data->lastTickAt`, { headers: sbHeaders(), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`store read failed (${r.status})`);
  const rows = await r.json();
  const row = rows && rows[0];
  return row ? { updatedAt: row.updated_at, lock: row.lock || null, last: row.last || null } : { updatedAt: null, lock: null, last: null };
}
async function lockLedger(owner, opts = {}) {
  const now = opts.now || Date.now(), gap = opts.minGapMs || 0;
  const tooSoon = last => !!(gap && last && now - last < gap);
  if (mem && mem.data && tooSoon(mem.data.lastTickAt)) return { tooSoon: true };
  if (mem && !(mem.data && mem.data.lock && mem.data.lock.until > Date.now())) {
    const mine = { ...clone(mem.data || {}), lock: { owner, until: Date.now() + LOCK_MS } };
    try { const ts = await writeRow(LEDGER_ROW, mine, mem.updatedAt); remember(mine, ts); return { ledger: mine, updatedAt: ts }; }
    catch (e) { if (!(e instanceof Conflict)) throw e; mem = null; }    // changed elsewhere — read it below
  }
  const p = await peekLedger();
  if (p.lock && p.lock.until > Date.now()) return null;                // another tick is running
  if (tooSoon(p.last)) return { tooSoon: true };
  const { data, updatedAt } = await readRow(LEDGER_ROW);
  const led = data || {};
  if (led.lock && led.lock.until > Date.now()) { remember(led, updatedAt); return null; }   // another tick is running
  const mine = { ...led, lock: { owner, until: Date.now() + LOCK_MS } };
  try { const ts = await writeRow(LEDGER_ROW, mine, updatedAt); remember(mine, ts); return { ledger: mine, updatedAt: ts }; }
  catch (e) { if (e instanceof Conflict) { mem = null; return null; } throw e; }
}
async function saveLedger(ledger, updatedAt, release) {
  const out = release ? { ...ledger, lock: null } : ledger;
  try { const ts = await writeRow(LEDGER_ROW, out, updatedAt); remember(out, ts); return ts; }
  catch (e) { mem = null; throw e; }
}
/* the status endpoint (Live and Health pages, every minute): this instance's copy if it is under a
   minute old — the pipeline itself only changes once a minute — else one read */
let reading = null;                               // one read shared by status calls arriving together
async function readLedger() {
  if (mem && Date.now() - mem.at < 60e3) return clone(mem.data) || {};
  if (!reading) reading = readRow(LEDGER_ROW).then(({ data, updatedAt }) => { remember(data || {}, updatedAt); }).finally(() => { reading = null; });
  await reading;
  return clone(mem && mem.data) || {};
}

/* ── the daily-check report: merge freshly read posts, never clobber a browser's save ──
   Two callers: the pipeline (automatic reads — only what was read is merged, a failed read changes
   nothing) and the content team's "Run everything" (api/collect.js, teamRun: { manual, lastRun } —
   like a press in the browser, every channel's result is recorded, failures too, and the run time). */
const POST_KEEP_DAYS = 14;
const newestOf = list => { let t = -Infinity; for (const p of list || []) { const x = Date.parse(p && p.ts); if (x > t) t = x; } return isFinite(t) ? new Date(t).toISOString() : null; };
function mergeInto(report, results, nowMs, opts = {}) {
  const r = report || {};
  r.posts = r.posts || {}; r.meta = r.meta || {};
  let added = 0;
  for (const res of results) {
    if (!res.ok) {
      /* a failed automatic read never marks a channel failed; a press says what it found, as the browser does */
      if (opts.manual) r.meta[res.channelId] = { ok: false, note: res.note || "", source: res.source || "", browserRequired: !!res.browserRequired,
        unsupported: !!res.unsupported, dead: !!res.dead, at: nowMs, cost: res.cost && !res.cost.cached ? res.cost.usd : null,
        cached: !!(res.cost && res.cost.cached), partialRead: !!res.partialRead };
      continue;
    }
    const have = r.posts[res.channelId] || [];
    const byId = new Map(have.map(p => [p.externalId, p]));
    for (const p of res.posts || []) {
      if (!p || !p.externalId || !p.ts) continue;
      const old = byId.get(p.externalId);
      if (!old) { added++; byId.set(p.externalId, p); continue; }
      const merged = { ...old };
      for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined && v !== "") merged[k] = v;
      byId.set(p.externalId, merged);
    }
    const keepFrom = nowMs - POST_KEEP_DAYS * 86400e3;
    r.posts[res.channelId] = [...byId.values()].filter(p => !(Date.parse(p.ts) < keepFrom))
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 400);
    /* n / newest: what this read itself returned — the report tells "posted nothing in the window" from "not read" by them */
    const seen = { n: (res.posts || []).length, newest: newestOf(res.posts) };
    r.meta[res.channelId] = opts.manual
      ? { ok: true, note: res.note || "", source: res.source || "", browserRequired: false, unsupported: false, dead: false, at: nowMs,
          cost: res.cost && !res.cost.cached ? res.cost.usd : null, cached: !!(res.cost && res.cost.cached), partialRead: !!res.partialRead, ...seen }
      /* at: when the channel was read — res.at for posts the pipeline read earlier and merges now */
      : { ok: true, note: res.note || "", source: res.source || "", browserRequired: false,
          unsupported: false, dead: false, at: res.at || nowMs, cost: null, cached: false, partialRead: !!res.partialRead, auto: true, ...seen };
  }
  if (opts.manual) r.lastRun = opts.lastRun || new Date(nowMs).toISOString();
  else r.autoAt = new Date(nowMs).toISOString();
  return { report: r, added };
}
/* opts.row: the brand's report row (SportsFC 3, MatchPulse 4 — directory.js); opts.manual: see mergeInto */
/* The report row is ~0.7 MB and Supabase's free plan counts every byte it sends: the merge is written onto
   this instance's copy of the row when it still is the latest (compare-and-set on updated_at), so a merge
   normally reads nothing — the row is read only when someone else wrote it meanwhile (a Run, the admin). */
const reportMem = {};                              // row → { data, updatedAt }
async function mergeIntoReport(results, nowMs, opts = {}) {
  const row = opts.row || REPORT_ROW;
  if (!opts.manual && !results.some(r => r.ok)) return { added: 0 };
  for (let i = 0; i < 4; i++) {
    const base = i === 0 && reportMem[row] ? reportMem[row] : await readRow(row);
    const { report, added } = mergeInto(clone(base.data), results, nowMs, opts);
    try { const ts = await writeRow(row, report, base.updatedAt); reportMem[row] = { data: report, updatedAt: ts }; return { added }; }
    catch (e) {
      delete reportMem[row];
      if (!(e instanceof Conflict)) throw e;
      if (i > 0) await new Promise(r => setTimeout(r, 400 + i * 600));
    }
  }
  throw new Error("the report kept changing under the merge — will try again next tick");
}
/* When a report's last Run was — a few bytes (one JSON field, not the ~0.7 MB row), for the content
   team's Run to check it isn't pressed again straight after one */
async function lastRunOf(row) {
  if (!configured()) { const { data } = await readRow(row); return data && data.lastRun || null; }
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${row}&select=lastRun:data->>lastRun`, { headers: sbHeaders(), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`store read failed (${r.status})`);
  const rows = await r.json();
  return rows && rows[0] && rows[0].lastRun || null;
}

/* "Is anyone else doing this right now?" across every instance — row 6, a few timestamps: { key: at }.
   claim(key, gapMs) succeeds for exactly one caller per gap, however many press at once (compare-and-set on
   updated_at; the losers are told when it was taken). The content team's Run uses it (api/collect.js). */
async function claim(key, gapMs, now = Date.now()) {
  for (let i = 0; i < 3; i++) {
    const { data, updatedAt } = await readRow(CLAIMS_ROW);
    const d = data || {};
    if (d[key] && now - d[key] < gapMs) return { ok: false, at: d[key] };
    const next = { ...d, [key]: now };
    try { await writeRow(CLAIMS_ROW, next, updatedAt); return { ok: true, at: now }; }
    catch (e) { if (!(e instanceof Conflict)) throw e; }
  }
  return { ok: false, at: now };                  // pressed at the same moment as others — one of them has it
}

module.exports = { lockLedger, saveLedger, readLedger, mergeIntoReport, mergeInto, lastRunOf, claim, Conflict, configured, readRow, writeRow,
                   LEDGER_ROW, REPORT_ROW, MATCHPULSE_ROW, CLAIMS_ROW };
