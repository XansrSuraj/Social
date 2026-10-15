/**
 * Admin sign-in (admin-auth.js, api/auth.js) and what each endpoint shows or refuses without it.
 * No network: handlers are called directly; storage is local (no Supabase env).
 *
 *   node test/auth.test.js
 */
let pass = 0, fail = 0;
const ok = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra !== undefined ? "  — " + extra : ""}`); };
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; delete process.env.PIPELINE_KEY;
delete process.env.ADMIN_PASSWORD;

const call = (handler, { method = "GET", query = {}, headers = {}, body } = {}) => new Promise(resolve => {
  if (method === "POST") headers = { "content-type": "application/json", ...headers };
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); return this; },
    end(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); } };
  Promise.resolve(handler({ method, query, headers, body, socket: { remoteAddress: headers["x-test-ip"] || "1.2.3.4" } }, res)).catch(e => resolve({ status: 599, body: String(e) }));
});

(async () => {
  const A = require("../admin-auth.js");
  console.log("── with no ADMIN_PASSWORD, nobody is admin (fails closed)");
  ok(!A.ready() && !A.verify("admin.9999999999999.abcdefghijklmnopqrstuvwx"), "no password: not ready, no token works");
  const login0 = await call(require("../api/auth.js"), { method: "POST", body: { password: "" } });
  ok(login0.status === 503, "signing in is refused until ADMIN_PASSWORD is set", login0.status);
  const fm0 = await call(require("../api/fm-deliveries.js"), { query: { env: "prod" } });
  ok(fm0.status === 503 && !fm0.body.deliveries, "FM Deliveries refuses everyone", fm0.status);

  process.env.ADMIN_PASSWORD = "a-long-test-password-42";
  console.log("\n── signing in");
  const authApi = require("../api/auth.js");
  const bad = await call(authApi, { method: "POST", body: { password: "guess" }, headers: { "x-test-ip": "9.9.9.9" } });
  ok(bad.status === 401 && !bad.body.token, "a wrong password gets no token", bad.status);
  const good = await call(authApi, { method: "POST", body: { password: "a-long-test-password-42" } });
  ok(good.status === 200 && /^admin\.\d{13}\./.test(good.body.token) && good.body.expiresAt - Date.now() > 11 * 3600e3, "the right one gets a 12-hour session token");
  const H = { authorization: "Bearer " + good.body.token };
  ok((await call(authApi, { headers: H })).body.admin === true && (await call(authApi)).body.admin === false, "GET /api/auth tells a signed-in caller from anyone else");
  ok(!A.verify(good.body.token.replace(/.$/, c => (c === "A" ? "B" : "A"))), "a token changed by one character is worthless");
  ok(!A.verify(A.issue(Date.now() - 13 * 3600e3).token), "an expired token is worthless");
  const forged = "admin." + (Date.now() + 3600e3) + ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  ok(!A.verify(forged), "a made-up token is worthless");
  for (let i = 0; i < 8; i++) await call(authApi, { method: "POST", body: { password: "nope" + i }, headers: { "x-test-ip": "6.6.6.6" } });
  const locked = await call(authApi, { method: "POST", body: { password: "a-long-test-password-42" }, headers: { "x-test-ip": "6.6.6.6" } });
  const plain = await call(authApi, { method: "POST", body: "{\"password\":\"a-long-test-password-42\"}", headers: { "content-type": "text/plain", "x-test-ip": "7.7.7.7" } });
  ok(plain.status === 415 && !plain.body.token, "a text/plain sign-in (what another website could send) is refused, even with the right password", plain.status);
  ok(locked.status === 429, "8 wrong guesses from one address: refused for 15 minutes, even the right password", locked.status);

  console.log("\n── every admin endpoint refuses a caller who isn't signed in");
  const gated = [
    ["FM Deliveries", require("../api/fm-deliveries.js"), { query: { env: "prod" } }],
    ["FM Deliveries vocabulary", require("../api/fm-deliveries-meta.js"), { query: { env: "prod" } }],
    ["Apify spend", require("../api/apify-usage.js"), {}],
    ["health / readers' credentials", require("../api/health.js"), {}],
    ["free-route probe", require("../api/health.js"), { query: { probe: "1" } }],
    ["reading the channels (can spend on Apify)", require("../api/collect.js"), { method: "POST", body: { channels: [{ id: "x", platform: "x", url: "https://x.com/a" }] } }],
    ["a test alert", require("../api/pipeline.js"), { query: { op: "test-alert" } }],
    ["re-sending a drop report", require("../api/pipeline.js"), { query: { op: "report", at: "16:30" } }],
  ];
  for (const [name, h, opts] of gated) {
    const r = await call(h, opts);
    ok(r.status === 401 && r.body && r.body.ok === false, name, r.status);
    ok(!r.headers["access-control-allow-origin"], `…and ${name} answers no other website (no CORS)`);
  }
  const put = await call(require("../api/data.js"), { method: "PUT", body: { data: {} } });
  ok(put.status === 401 || put.status === 503, "writing the settings needs the admin", put.status);

  console.log("\n── the pipeline status: the public view, and everything for the admin");
  const pub = await call(require("../api/pipeline.js"), {});
  const adm = await call(require("../api/pipeline.js"), { headers: H });
  ok(pub.status === 200 && pub.body.admin === false && Array.isArray(pub.body.deliveries), "anyone gets the public view");
  ok(!("health" in pub.body) && !("alerts" in pub.body) && !("readers" in pub.body) && !("whatsapp" in pub.body) && !("errorLog" in pub.body) && !("coverage" in pub.body),
     "…with nothing internal: no health, readers, alert or error logs, alert channels", Object.keys(pub.body).join(","));
  ok(adm.body.admin === true && "health" in adm.body && "errorLog" in adm.body && "alerts" in adm.body, "the admin gets everything");

  console.log("\n── a drop with problems: the content team is told why, in words; reader internals stay with the admin");
  const store = require("../pipeline/store.js"), realRead = store.readLedger, now = Date.now();
  store.readLedger = async () => ({ lastTickAt: now, deliveries: {
    a: { cardId: "a", setId: "s1", channel: "facebook", language: "vietnamese", label: "Facebook VN", when: now - 30 * 60e3, status: "missing",
         caption: "Arsenal 2-1 Chelsea ⚽ full time", readNote: "read via Apify run abc123", sim: 12, mode: "verify", fmState: "sent" },
    b: { cardId: "b", setId: "s1", channel: "x", language: "vietnamese", label: "X VN", when: now - 30 * 60e3, status: "reader_failed",
         caption: "Arsenal 2-1 Chelsea", readNote: "HTTP 403 from x.com via proxy 10.0.0.7", mode: "verify", fmState: "sent" },
    c: { cardId: "c", setId: "s1", channel: "telegram", language: "vietnamese", label: "Telegram VN", when: now - 30 * 60e3, status: "verified", lag: 2,
         caption: "Arsenal 2-1 Chelsea", mode: "verify", fmState: "sent" },
  } });
  const p2 = (await call(require("../api/pipeline.js"), {})).body, a2 = (await call(require("../api/pipeline.js"), { headers: H })).body;
  store.readLedger = realRead;
  const byId = (b, id) => b.deliveries.find(e => e.cardId === id);
  ok(/not on the channel 20 min/.test(byId(p2, "a").why || ""), "a missing post says why", byId(p2, "a").why);
  ok(/on our side/.test(byId(p2, "b").why || "") && !/403|proxy|10\.0/.test(JSON.stringify(byId(p2, "b"))), "a channel we couldn't read is said as ours — no HTTP codes, hosts or proxies", byId(p2, "b").why);
  ok(!byId(p2, "c").why && byId(p2, "c").lag === 2, "a delivered post needs no why");
  ok(p2.deliveries.every(e => !("readNote" in e) && !("caption" in e) && !("sim" in e)), "no reader notes, full captions or match scores in the public view");
  ok(/403/.test(byId(a2, "b").why || "") && byId(a2, "a").readNote, "the admin sees the reader's own error", byId(a2, "b").why);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
