/**
 * The content team's "Run everything" (api/collect.js, teamRun): anyone may press it, for SportsFC or
 * MatchPulse, and it can only ever read that brand's own channels (directory.js) and save the result
 * into that brand's report — server-side. No network: Supabase is an in-memory table, every other
 * request is refused (so each channel fails fast, which is all these checks need).
 *
 *   node test/teamrun.test.js
 */
process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_SERVICE_KEY = "test-key";
process.env.ADMIN_PASSWORD = "a-long-test-password-42";
for (const k of ["APIFY_TOKEN", "YOUTUBE_API_KEY", "TWITTERAPI_KEY", "X_SCRAPER", "TG_API_ID", "TG_API_HASH", "TG_SESSION", "PIPELINE_KEY"]) delete process.env[k];
const fs = require("fs"), path = require("path");

let pass = 0, fail = 0;
const ok = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra !== undefined ? "  — " + String(extra).slice(0, 220) : ""}`); };

/* orghub_state, in memory: rows by id, each { data, updated_at } */
const rows = {}, outside = [];
let stamp = 0;
global.fetch = async (url, opt = {}) => {
  const u = new URL(url);
  if (u.host !== "sb.test") { outside.push(url); throw new Error("network is off in this test"); }
  const id = Number((u.searchParams.get("id") || "").replace("eq.", "")) || null;
  const select = u.searchParams.get("select") || "";
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const method = (opt.method || "GET").toUpperCase();
  if (method === "GET") {
    const row = rows[id];
    if (!row) return json(200, []);
    if (select === "lastRun:data->>lastRun") return json(200, [{ lastRun: (row.data && row.data.lastRun) || null }]);
    return json(200, [{ data: row.data, updated_at: row.updated_at }]);
  }
  if (method === "PATCH") {
    const want = decodeURIComponent((u.searchParams.get("updated_at") || "").replace("eq.", ""));
    const body = JSON.parse(opt.body);
    if (!rows[id] || (want && rows[id].updated_at !== want)) return json(200, []);
    rows[id] = { data: body.data, updated_at: body.updated_at + "#" + (++stamp) };
    return json(200, [{ id }]);
  }
  if (method === "POST") {
    const body = JSON.parse(opt.body);
    for (const r of [].concat(body)) { if (rows[r.id]) return json(409, {}); rows[r.id] = { data: r.data, updated_at: (r.updated_at || "") + "#" + (++stamp) }; }
    return json(201, [{}]);
  }
  return json(405, {});
};

const call = (handler, { method = "POST", headers = {}, body, ip = "1.2.3.4" } = {}) => new Promise(resolve => {
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); return this; },
    end(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); } };
  Promise.resolve(handler({ method, query: {}, headers: { "x-real-ip": ip, ...headers }, body, socket: { remoteAddress: ip } }, res))
    .catch(e => resolve({ status: 599, body: String(e && e.stack || e) }));
});

(async () => {
  const DIRECTORY = require("../directory.js");
  console.log("── directory.js is the engine's own list of channels");
  const engine = fs.readFileSync(path.join(__dirname, "..", "src", "engine", "engine.js"), "utf8");
  const brandOf = name => {
    const a = engine.indexOf(`const ${name} = {`), b = engine.indexOf("\n};", a);
    return new Function("return " + engine.slice(a + `const ${name} = `.length, b + 2))();
  };
  const pick = c => JSON.stringify({ id: c.id, platform: c.platform, url: c.url, handle: c.handle || "", ytChannelId: c.ytChannelId || null });
  for (const [id, name] of [["sportsfc", "SPORTSFC"], ["matchpulse", "MATCHPULSE"]]) {
    const mine = DIRECTORY[id].channels.map(pick), theirs = brandOf(name).socials.map(pick);
    ok(JSON.stringify(mine) === JSON.stringify(theirs), `${id}: the same ${theirs.length} channels, ids, URLs, handles and YouTube ids`,
      mine.filter(x => !theirs.includes(x)).concat(theirs.filter(x => !mine.includes(x))).join(" | "));
  }
  ok(DIRECTORY.sportsfc.row === 3 && DIRECTORY.matchpulse.row === 4, "each brand's report row — the ones api/report.js serves");

  const collect = require("../api/collect.js");
  console.log("\n── anyone presses Run for SportsFC");
  rows[3] = { data: { posts: { "yt-vn": [{ externalId: "old", ts: new Date().toISOString(), text: "kept" }] }, meta: {}, lastRun: "2026-10-01T00:00:00Z", window: "today" }, updated_at: "t0" };
  const t0 = Date.now();
  const r1 = await call(collect, { body: { brand: "sportsfc", run: true,
    channels: [{ id: "evil", platform: "instagram", url: "https://instagram.com/someone-else", handle: "someone-else" }] } });
  ok(r1.status === 200 && r1.body.ok && r1.body.team === true, "the Run is accepted without signing in", r1.status + " " + (r1.body && (r1.body.error || "")));
  const ids = (r1.body.results || []).map(r => r.channelId);
  ok(JSON.stringify(ids) === JSON.stringify(DIRECTORY.sportsfc.channels.map(c => c.id)), "exactly SportsFC's own channels are read", ids.join(","));
  ok(!outside.some(u => /someone-else/.test(u)) && !ids.includes("evil"), "a channel the caller slipped in is never read");
  ok(!r1.headers["access-control-allow-origin"], "no CORS — another website's page can't press it");
  const rep = rows[3].data;
  ok(r1.body.saved === true && rep.lastRun === r1.body.collectedAt, "the server saved it into SportsFC's report (row 3), with the run time", rep.lastRun);
  ok(DIRECTORY.sportsfc.channels.every(c => rep.meta[c.id] && rep.meta[c.id].at >= t0), "every channel's result is recorded, as a press in the browser does");
  ok(rep.posts["yt-vn"] && rep.posts["yt-vn"][0].externalId === "old" && rep.window === "today", "what the report already held is kept");
  ok(!rows[4], "MatchPulse's report is not touched");
  ok(Date.now() - t0 < 20000, "it answers well inside the function's limit", (Date.now() - t0) + " ms");

  console.log("\n── pressed again straight away");
  const before = JSON.stringify(rows[3]), n = outside.length;
  const r2 = await call(collect, { body: { brand: "sportsfc", run: true } });
  ok(r2.status === 200 && /finished 1 min ago/.test(r2.body.skipped || "") && outside.length === n && JSON.stringify(rows[3]) === before,
    "inside 3 minutes: the one just run is shown — nothing read, nothing written", r2.body.skipped);

  console.log("\n── MatchPulse");
  const r3 = await call(collect, { body: { brand: "matchpulse", run: true }, ip: "5.5.5.5" });
  ok(r3.status === 200 && r3.body.saved === true && rows[4] && rows[4].data.lastRun === r3.body.collectedAt, "MatchPulse's Run is saved into its own report (row 4)");
  ok(JSON.stringify((r3.body.results || []).map(r => r.channelId)) === JSON.stringify(DIRECTORY.matchpulse.channels.map(c => c.id)), "…reading MatchPulse's channels only");

  console.log("\n── everything else stays the admin's");
  const refuse = async (label, body) => { const r = await call(collect, { body }); ok(r.status === 401, label, r.status); };
  await refuse("any channels the caller names, without a brand Run", { channels: [{ id: "x", platform: "x", url: "https://x.com/a" }] });
  await refuse("an unknown brand", { brand: "nope", run: true });
  await refuse("a brand name that is really a property of every object", { brand: "__proto__", run: true });
  await refuse("run must be exactly true", { brand: "sportsfc", run: "yes" });

  console.log("\n── at most 12 Runs an hour from one address");
  let last = null;
  for (let i = 0; i < 13; i++) {
    rows[3].data.lastRun = "2026-10-01T00:00:00Z";                // as if the last Run was long ago
    last = await call(collect, { body: { brand: "sportsfc", run: true }, ip: "9.9.9.9" });
    if (i === 11) ok(last.status === 200 && last.body.team, "the 12th is run", last.status);
  }
  ok(last.status === 429, "the 13th is refused, politely", last.body && last.body.error);
  const other = await call(collect, { body: { brand: "sportsfc", run: true }, ip: "8.8.8.8" });
  ok(other.status === 200, "…another address is not affected");

  console.log("\n── a channel that never answers can't hold the Run past its deadline");
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => (new URL(url).host === "sb.test" ? realFetch(url, opt) : new Promise(() => {}));
  const t1 = Date.now();
  const slow = await collect.collectChannels([DIRECTORY.sportsfc.channels.find(c => c.id === "tg-vn")], { hours: 24, deadlineMs: 400 });
  global.fetch = realFetch;
  const s0 = slow.results[0];
  ok(Date.now() - t1 < 3000 && s0.ok === false && s0.source === "timeout" && /press Run again/.test(s0.note), "answered at the deadline, as still being read", `${Date.now() - t1} ms · ${s0.note}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
