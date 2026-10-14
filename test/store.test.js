/**
 * pipeline/store.js and api/report.js against a stand-in Supabase (PostgREST) — what is read, what is
 * written, and that the ledger lock stays safe while reading far less. On the free plan Supabase counts
 * every byte it sends back (egress, 5 GB a month); reading the ~0.4 MB ledger every minute used most of
 * it (September–October 2026), so these check that a tick normally reads nothing at all.
 *
 *   node test/store.test.js
 */
let pass = 0, fail = 0;
const ok = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra !== undefined ? "  — " + extra : ""}`); };

/* a tiny PostgREST: rows by id, conditional PATCH on updated_at, select= on reads and on writes */
const rows = {};
const log = [];
let clock = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 10, 0, 0, 0) + (++clock) * 1000).toISOString();
global.fetch = async (url, opts = {}) => {
  const u = new URL(url), method = opts.method || "GET";
  const id = Number((u.searchParams.get("id") || "").replace("eq.", "")) || null;
  const select = u.searchParams.get("select");
  const pick = row => (select ? Object.fromEntries(select.split(",").map(k => [k, row[k]])) : row);
  const json = (body, status = 200) => { const text = JSON.stringify(body); log.push({ method, id, select, bytes: text.length }); return new Response(text, { status, headers: { "content-type": "application/json" } }); };
  if (method === "GET") return json(rows[id] ? [pick(rows[id])] : []);
  /* like PostgREST: half an emoji (a lone surrogate) is "Empty or invalid json" */
  if (opts.body && /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(opts.body)) return json({ code: "PGRST102", message: "Empty or invalid json" }, 400);
  if (method === "PATCH") {
    const base = (u.searchParams.get("updated_at") || "").replace("eq.", "");
    const body = JSON.parse(opts.body);
    if (!rows[id] || rows[id].updated_at !== decodeURIComponent(base)) return json([]);
    rows[id] = { id, ...body };
    return json([pick(rows[id])]);
  }
  if (method === "POST") {
    for (const r of JSON.parse(opts.body)) rows[r.id] = { ...r };
    const back = JSON.parse(opts.body).map(r => pick(rows[r.id]));
    return json(back, 201);
  }
  return json({ error: "?" }, 400);
};
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_KEY = "k";

(async () => {
  const store = require("../pipeline/store.js");
  const big = { deliveries: Object.fromEntries(Array.from({ length: 200 }, (_, i) => ["c" + i, { caption: "x".repeat(500) }])) };
  rows[5] = { id: 5, data: big, updated_at: stamp() };

  console.log("── the ledger: a tick reads nothing when this instance holds the latest copy");
  let lock = await store.lockLedger("t1");
  ok(lock && lock.ledger.deliveries.c0, "the first tick reads the ledger once and takes the lock");
  await store.saveLedger({ ...lock.ledger, n: 1 }, lock.updatedAt, true);
  const readsBefore = log.filter(l => l.method === "GET").length;
  for (let i = 2; i <= 10; i++) {
    lock = await store.lockLedger("t" + i);
    lock.ledger.n = i;
    await store.saveLedger(lock.ledger, lock.updatedAt, true);
  }
  const gets = log.filter(l => l.method === "GET").length - readsBefore;
  ok(gets === 0 && rows[5].data.n === 10 && rows[5].data.lock === null, "nine more ticks: no read at all, every save landed, the lock released", `${gets} reads`);
  const writeBack = log.filter(l => l.method === "PATCH").map(l => l.bytes);
  ok(Math.max(...writeBack) < 40, "a write gets back only the row's id — never the ledger", Math.max(...writeBack) + " bytes");

  console.log("\n── …and stays safe when something else wrote the row");
  rows[5] = { ...rows[5], data: { ...rows[5].data, fromElsewhere: true }, updated_at: stamp() };   // a test alert, another instance
  lock = await store.lockLedger("t11");
  ok(lock && lock.ledger.fromElsewhere === true, "the conditional write is refused, the row is read, and the tick works on the newer copy");
  await store.saveLedger(lock.ledger, lock.updatedAt, true);
  rows[5] = { ...rows[5], data: { ...rows[5].data, lock: { owner: "other", until: Date.now() + 60000 } }, updated_at: stamp() };
  ok(await store.lockLedger("t12") === null, "a tick running elsewhere: this one steps aside");
  ok(await store.lockLedger("t13") === null, "…and again while it still runs (no write over its lock)");
  rows[5] = { ...rows[5], data: { ...rows[5].data, lock: null }, updated_at: stamp() };
  lock = await store.lockLedger("t14");
  ok(lock && lock.ledger.lock.owner === "t14", "once it is done, the next tick goes ahead");
  await store.saveLedger(lock.ledger, lock.updatedAt, true);

  /* 14 Oct 23:00: a caption cut through an emoji made the ledger unsaveable */
  lock = await store.lockLedger("t15");
  lock.ledger.broken = "🔥🔥".slice(0, 3);
  let saved = true; try { await store.saveLedger(lock.ledger, lock.updatedAt, true); } catch (e) { saved = false; }
  ok(saved && rows[5].data.lock === null, "a text with half an emoji in it still saves (made well-formed first)");

  console.log("\n── the status endpoint (Live and Health pages)");
  const g0 = log.filter(l => l.method === "GET").length;
  const s1 = await store.readLedger(), s2 = await store.readLedger();
  ok(log.filter(l => l.method === "GET").length === g0 && s1.n === s2.n, "inside a minute of the last tick it answers from this instance's copy");
  s1.deliveries.c0.caption = "changed by a caller";
  ok((await store.readLedger()).deliveries.c0.caption !== "changed by a caller", "…and hands out a copy, so a caller can never change it");

  console.log("\n── the shared report (api/report.js)");
  const report = require("../api/report.js");
  const call = (method, query = {}, body) => new Promise(resolve => {
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; }, end() { resolve({ status: this.statusCode }); } };
    report({ method, query, headers: {}, body }, res);
  });
  rows[3] = { id: 3, data: { posts: { a: Array.from({ length: 300 }, (_, i) => ({ externalId: "p" + i, text: "y".repeat(300) })) } }, updated_at: stamp() };
  const full = await call("GET");
  ok(full.status === 200 && full.body.data && full.body.data.posts, "a first read returns the report");
  const n0 = log.length;
  const same = await call("GET", { since: full.body.updatedAt });
  const sent = log.slice(n0).reduce((t, l) => t + l.bytes, 0);
  ok(same.body.unchanged === true && !same.body.data && sent < 100, "asked again with the version it holds: 'unchanged', and Supabase sent a few bytes", sent + " bytes");
  rows[3] = { ...rows[3], data: { ...rows[3].data, more: 1 }, updated_at: stamp() };
  const changed = await call("GET", { since: full.body.updatedAt });
  ok(!changed.body.unchanged && changed.body.data && changed.body.data.more === 1, "once it changed, the new report comes back");
  const n1 = log.length;
  const put = await call("PUT", {}, { data: { posts: {}, x: 1 }, baseUpdatedAt: changed.body.updatedAt });
  const back = log.slice(n1).filter(l => l.method === "POST");
  ok(put.status === 200 && put.body.saved && back.length === 1 && back[0].bytes < 80 && back[0].select === "updated_at", "a save gets back only the stored time, not the report",
     back.map(l => l.bytes + " bytes").join(","));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
