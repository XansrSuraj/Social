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
  /* select= columns, and JSON fields as PostgREST takes them: alias:data->field / alias:data->>field */
  const pick = row => (select ? Object.fromEntries(select.split(",").map(k => {
    const m = k.match(/^(\w+):data->>?(\w+)$/);
    return m ? [m[1], row.data && row.data[m[2]] !== undefined ? row.data[m[2]] : null] : [k, row[k]];
  })) : row);
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
process.env.ADMIN_PASSWORD = "test-admin-password-123";

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

  console.log("\n── a tick that can't run costs a few bytes, not the ledger (15 Oct 2026 review)");
  {
    const fresh = () => { delete require.cache[require.resolve("../pipeline/store.js")]; return require("../pipeline/store.js"); };
    const fullReads = () => log.filter(l => l.method === "GET" && l.id === 5 && /data,updated_at/.test(l.select || "")).length;
    /* another instance holds the lock */
    rows[5] = { id: 5, data: { ...big, lock: { owner: "other", until: Date.now() + 60e3 }, lastTickAt: Date.now() - 90e3 }, updated_at: stamp() };
    let b0 = fullReads(), n0 = log.length;
    const held = await Promise.all(Array.from({ length: 20 }, () => fresh().lockLedger("x", { minGapMs: 40e3 })));
    const bytes = log.slice(n0).reduce((t, l) => t + l.bytes, 0);
    ok(held.every(x => x === null) && fullReads() === b0 && bytes < 20 * 300, "20 calls while another tick holds the lock: all told so, the ledger never read", bytes + " bytes in all");
    /* the last tick was 10 s ago */
    rows[5] = { id: 5, data: { ...big, lock: null, lastTickAt: Date.now() - 10e3 }, updated_at: stamp() };
    b0 = fullReads();
    const soon = await fresh().lockLedger("x", { minGapMs: 40e3 });
    ok(soon && soon.tooSoon && fullReads() === b0, "10 s after the last tick: 'too soon', the ledger never read");
    /* free and due: it runs, as before */
    rows[5].data.lastTickAt = Date.now() - 70e3; rows[5].updated_at = stamp();
    const go = await fresh().lockLedger("x", { minGapMs: 40e3 });
    ok(go && go.ledger && go.ledger.lock && go.ledger.lock.owner === "x", "70 s after it, with no lock: the tick runs");
    /* status reads arriving together share one read */
    const st = fresh(); b0 = fullReads();
    const many = await Promise.all(Array.from({ length: 25 }, () => st.readLedger()));
    ok(fullReads() === b0 + 1 && many.every(m => m.deliveries && m.deliveries.c0), "25 status reads at once: one read of the ledger", (fullReads() - b0) + " reads");
    many[0].deliveries.c0.caption = "changed";
    ok((await st.readLedger()).deliveries.c0.caption !== "changed", "…each gets its own copy");
  }

  console.log("\n── the pipeline's report merges are written from its own copy (15 Oct 2026)");
  {
    delete require.cache[require.resolve("../pipeline/store.js")];
    const ps = require("../pipeline/store.js");
    rows[3] = { id: 3, data: { posts: { a: Array.from({ length: 200 }, (_, i) => ({ externalId: "p" + i, ts: new Date().toISOString(), text: "y".repeat(300) })) }, meta: {} }, updated_at: stamp() };
    const reads3 = () => log.filter(l => l.method === "GET" && l.id === 3).length;
    const post = id => [{ channelId: "a", ok: true, posts: [{ externalId: id, ts: new Date().toISOString(), text: "new" }] }];
    let r0 = reads3();
    await ps.mergeIntoReport(post("n1"), Date.now());
    ok(reads3() === r0 + 1, "the first merge reads the row once");
    r0 = reads3();
    await ps.mergeIntoReport(post("n2"), Date.now()); await ps.mergeIntoReport(post("n3"), Date.now());
    ok(reads3() === r0 && ["n1", "n2", "n3"].every(id => rows[3].data.posts.a.some(p => p.externalId === id)), "the next merges read nothing — and every post landed");
    rows[3] = { ...rows[3], data: { ...rows[3].data, lastRun: "someone pressed Run" }, updated_at: stamp() };   // written elsewhere
    r0 = reads3();
    await ps.mergeIntoReport(post("n4"), Date.now());
    ok(reads3() === r0 + 1 && rows[3].data.lastRun === "someone pressed Run" && rows[3].data.posts.a.some(p => p.externalId === "n4"),
       "a row changed elsewhere is read again, and what the other writer wrote is kept");
  }

  console.log("\n── the shared report (api/report.js)");
  const report = require("../api/report.js");
  const call = (method, query = {}, body, headers = {}) => new Promise(resolve => {
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; }, end() { resolve({ status: this.statusCode }); } };
    report({ method, query, headers, body }, res);
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
  const anon = await call("PUT", {}, { data: { posts: {}, wiped: 1 } });
  ok(anon.status === 401 && !rows[3].data.wiped, "a save without the admin signed in is refused — nobody can replace or empty the report", anon.status);
  const { token } = require("../admin-auth.js").issue();
  const put = await call("PUT", {}, { data: { posts: {}, x: 1 }, baseUpdatedAt: changed.body.updatedAt }, { authorization: "Bearer " + token });
  const back = log.slice(n1).filter(l => l.method === "POST" || l.method === "PATCH");   // a conditional PATCH since 15 Oct
  ok(put.status === 200 && put.body.saved && back.length === 1 && back[0].bytes < 80 && back[0].select === "updated_at", "a save gets back only the stored time, not the report",
     back.map(l => l.bytes + " bytes").join(","));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
