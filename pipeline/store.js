/**
 * Where the pipeline keeps its state, and how it feeds the daily-check report.
 *
 *   ledger  — orghub_state row 5: one entry per FM delivery and what became of it, the alert log,
 *             reader health, the WhatsApp outbox, and the tick lock. Only the pipeline writes it.
 *   report  — orghub_state row 3: the SportsFC daily-check report the website reads. The pipeline
 *             merges the posts it reads into it, so the report stays current with nobody pressing
 *             Run. That row is also written by browsers, so every write here is conditional on the
 *             row not having changed since it was read (compare-and-set on updated_at) and retried —
 *             a browser's save is never overwritten by a stale copy.
 *
 * Without Supabase (local development) both live in files beside the app.
 */
const fs = require("fs");
const path = require("path");

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const TABLE = "orghub_state";
const LEDGER_ROW = 5, REPORT_ROW = 3;
const FILES = { [LEDGER_ROW]: path.join(__dirname, "..", ".pipeline.json"), [REPORT_ROW]: path.join(__dirname, "..", ".report-local.json") };

const configured = () => !!(SB_URL && SB_KEY);
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
      body: JSON.stringify([{ id, data, updated_at: now }]), signal: AbortSignal.timeout(15000) });
    if (w.status === 409) throw new Conflict("created meanwhile");
    if (!w.ok) throw new Error(`store insert failed (${w.status}): ${(await w.text()).slice(0, 200)}`);
    return now;
  }
  /* select=id: the answer is the matched row's id only (an empty list = it changed meanwhile), not the whole row */
  const w = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${id}&updated_at=eq.${encodeURIComponent(base)}&select=id`, {
    method: "PATCH", headers: sbHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({ data, updated_at: now }), signal: AbortSignal.timeout(15000) });
  if (!w.ok) throw new Error(`store write failed (${w.status}): ${(await w.text()).slice(0, 200)}`);
  const rows = await w.json();
  if (!Array.isArray(rows) || !rows.length) throw new Conflict("changed meanwhile");
  return now;
}

/* ── the ledger, with a lock so two ticks never work on it at once ── */
const LOCK_MS = 150000;
async function lockLedger(owner) {
  const { data, updatedAt } = await readRow(LEDGER_ROW);
  const led = data || {};
  if (led.lock && led.lock.until > Date.now()) return null;           // another tick is running
  const mine = { ...led, lock: { owner, until: Date.now() + LOCK_MS } };
  try { return { ledger: mine, updatedAt: await writeRow(LEDGER_ROW, mine, updatedAt) }; }
  catch (e) { if (e instanceof Conflict) return null; throw e; }
}
async function saveLedger(ledger, updatedAt, release) {
  const out = release ? { ...ledger, lock: null } : ledger;
  return writeRow(LEDGER_ROW, out, updatedAt);
}
const readLedger = async () => (await readRow(LEDGER_ROW)).data || {};

/* ── the daily-check report: merge freshly read posts, never clobber a browser's save ── */
const POST_KEEP_DAYS = 14;
function mergeInto(report, results, nowMs) {
  const r = report || {};
  r.posts = r.posts || {}; r.meta = r.meta || {};
  let added = 0;
  for (const res of results) {
    if (!res.ok) continue;                         // a failed automatic read never marks a channel failed
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
    r.meta[res.channelId] = { ok: true, note: res.note || "", source: res.source || "", browserRequired: false,
      unsupported: false, dead: false, at: nowMs, cost: null, cached: false, partialRead: !!res.partialRead, auto: true };
  }
  r.autoAt = new Date(nowMs).toISOString();
  return { report: r, added };
}
async function mergeIntoReport(results, nowMs) {
  if (!results.some(r => r.ok)) return { added: 0 };
  for (let i = 0; i < 4; i++) {
    const { data, updatedAt } = await readRow(REPORT_ROW);
    const { report, added } = mergeInto(data, results, nowMs);
    try { await writeRow(REPORT_ROW, report, updatedAt); return { added }; }
    catch (e) { if (!(e instanceof Conflict)) throw e; await new Promise(r => setTimeout(r, 400 + i * 600)); }
  }
  throw new Error("the report kept changing under the merge — will try again next tick");
}

module.exports = { lockLedger, saveLedger, readLedger, mergeIntoReport, mergeInto, Conflict, configured, readRow, writeRow, LEDGER_ROW, REPORT_ROW };
