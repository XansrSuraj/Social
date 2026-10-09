/**
 * The reports the pipeline sends, each in two forms from the same data:
 *   text  — for the phone (ntfy) and WhatsApp
 *   card  — Adaptive Card items for the Teams channel (pipeline/teams.js)
 *
 *   drop report   one drop (a card going out on every channel in every language), in full — what went
 *                 out, who sent it, where it landed, how fast, what didn't, and why. Sent when a drop
 *                 settles (pipeline/tick.js), or on request (/api/pipeline?op=report&at=16:30).
 *   daily summary the whole day at 23:00 IST — how many posts reached their channels, per language, and
 *                 the short list of what needs attention.
 */
const { xPostedLength } = require("./rules.js");
const { FM_CHANNELS } = require("./channels.js");

const SHORT = { youtube: "YouTube", telegram: "Telegram", telegram_direct: "Telegram bot", x: "X", facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", viber: "Viber" };
const LANGS = [["vietnamese", "🇻🇳", "Vietnamese"], ["english", "🇬🇧", "English"], ["portuguese", "🇧🇷", "Portuguese"], ["hindi", "🇮🇳", "Hindi"]];
/* what needs attention: a problem (❌) — or, on Instagram, a post to check by hand (⚠️): Instagram puts an 18+
   wall on single posts by itself and nothing logged-out can see those, so "not found" there may be either */
const BAD = ["missing", "not_visible", "reader_failed", "fm_failed", "fm_unconfirmed"];
const istT = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 19);
const istHM = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16);
const istDate = ms => new Date(ms + 5.5 * 3600e3).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const mins = x => (x == null ? "—" : `+${Math.max(0, x).toFixed(1)} min`);
const plural = (n, w, pl) => `${n} ${n === 1 ? w : (pl || w + "s")}`;
const ok = e => e.status === "verified" || e.status === "late";
const checkedOf = list => list.filter(e => e.mode === "verify" && e.fmState === "sent" && e.status !== "unverifiable");
/* the card's headline in words: the English caption's first line, else any — links and emoji dropped */
const headline = list => {
  const pick = list.find(e => e.language === "english" && e.caption) || list.find(e => e.caption) || {};
  return String(pick.caption || "").split("\n").map(l => l.replace(/https?:\/\/\S+/g, "").replace(/[\p{Extended_Pictographic}️⃣]/gu, "").trim())
    .find(l => l.length > 8) || "";
};
/* why one delivery needs attention, in a few words */
function reason(e) {
  if (e.status === "missing") {
    const n = e.channel === "x" && e.caption ? xPostedLength(e.caption) : null;
    return n != null && n > 280 ? `not on X — caption ${n}/280 as X counts it, so X refused it` : "not on the channel 20 min after FM sent it" +
      (e.capProblem ? ` (likely why: ${e.capProblem})` : "");
  }
  if (e.status === "not_visible") return "not on the public profile — maybe 18+ restricted by Instagram (we can't see those) or not posted; check in the app";
  if (e.status === "fm_failed") return `not sent — ${e.failureStage === "cms" ? "the CMS skipped it" : "FM failed"}` + (e.fmError ? ` (${e.fmError.replace(/\s*—.*$/, "")})` : "");
  if (e.status === "reader_failed") return "couldn't be checked — the channel couldn't be read" + (e.readNote ? ` (${String(e.readNote).slice(0, 120)})` : "");
  if (e.status === "fm_unconfirmed") return "FM can't confirm it went out";
  return e.status;
}
const RESULT = { verified: "✓ Delivered", late: "✓ Late", missing: "✗ Missing", not_visible: "⚠ Not found — maybe 18+, check the app",
                 reader_failed: "! Couldn't check", fm_failed: "✗ Not sent (FM/CMS)", fm_unconfirmed: "? FM can't confirm", waiting: "⏳ Checking",
                 unverifiable: "⚠ Can't be read right now" };

/* `retried`: a failed first attempt of this card the content team sent again (pipeline/tick.js —
   superseded) — not a problem, but the report says it happened */
function dropData(list, { retried = [] } = {}) {
  const first = Math.min(...list.map(e => e.when));
  const sentTimes = list.filter(e => e.sentAt).map(e => Date.parse(e.sentAt));
  const checked = checkedOf(list);
  const good = checked.filter(ok);
  const bad = list.filter(e => BAD.includes(e.status));
  const lags = good.map(e => e.lag).filter(x => x != null);
  const now = list.some(e => e.deliveryMode === "now");
  const languages = LANGS.filter(([lg]) => list.some(e => e.language === lg)).map(([lg, flag, name]) => {
    const mine = list.filter(e => e.language === lg);
    const configured = Object.entries(FM_CHANNELS).filter(([k, v]) => k.endsWith("/" + lg) && v.mode === "verify").map(([k]) => k.split("/")[0]);
    const chans = [...new Set([...configured, ...mine.filter(e => e.mode === "verify").map(e => e.channel)])].sort();
    const rows = chans.map(ch => {
      const e = mine.find(x => x.channel === ch);
      if (!e) return { channel: SHORT[ch] || ch, status: "not_sent", result: "○ Not sent by content team", posted: "—", lag: null, match: "—", url: "" };
      return {
        channel: SHORT[ch] || ch, status: e.status, result: RESULT[e.status] || e.status,
        posted: e.postAt ? istT(Date.parse(e.postAt)) : "—", lag: e.lag, match: e.sim != null ? `${e.sim}%` : "—", url: e.postUrl || "",
      };
    });
    const viberConfigured = !!FM_CHANNELS["viber/" + lg];
    const x = mine.find(e => e.channel === "x" && e.caption);
    return { lg, flag, name, rows, ok: rows.filter(r => r.status === "verified" || r.status === "late").length,
             checkable: rows.filter(r => !["not_sent", "unverifiable"].includes(r.status)).length,
             notSent: rows.filter(r => r.status === "not_sent").length,
             viber: mine.filter(e => e.status === "assumed").length, viberNotSent: viberConfigured && !mine.some(e => e.channel === "viber"),
             xLen: x ? xPostedLength(x.caption) : null };
  });
  /* nothing went out at all: every delivery of the drop failed in FM / the CMS */
  const notSent = list.length > 0 && list.every(e => e.status === "fm_failed");
  const retriedAt = retried.map(e => Date.parse(e.queuedAt)).filter(isFinite);
  return {
    notSent,
    retried: retried.length ? `A first attempt at ${istHM(Math.min(...retriedAt))} was ${retried[0].fmState} by ${retried[0].failureStage === "cms" ? "the CMS" : "FM"}` +
      `${retried[0].fmError ? ` (${retried[0].fmError.replace(/\s*—.*$/, "")})` : ""} on ${retried.length} channel${retried.length === 1 ? "" : "s"}; the content team sent it again` +
      `${retried[0].resentAt ? ` at ${istHM(retried[0].resentAt)}` : ""} — that send is this report.` : "",
    when: first, card: [...new Set(list.map(e => e.card))].join(" + "), headline: headline(list),
    mode: now ? "sent right away by an editor" : `scheduled${list[0].scheduledAt ? " for " + istHM(Date.parse(list[0].scheduledAt)) : ""} (sent by the scheduler)`,
    fmFrom: sentTimes.length ? Math.min(...sentTimes) : null, fmTo: sentTimes.length ? Math.max(...sentTimes) : null,
    checked: checked.length, ok: good.length, viber: list.filter(e => e.status === "assumed").length,
    lagMin: lags.length ? Math.min(...lags) : null, lagMax: lags.length ? Math.max(...lags) : null,
    lagAvg: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : null,
    problems: bad.map(e => ({ label: e.label, check: e.status === "not_visible", why: reason(e) })),
    captionWarnings: list.filter(e => e.capProblem && !BAD.includes(e.status)).map(e => `${e.label}: ${e.capProblem}`),
    languages,
  };
}

/* the result in one line: all delivered · N problems / N to check by hand · or nothing went out at all */
function headLine(d, b = "") {
  const checks = d.problems.filter(p => p.check).length, probs = d.problems.length - checks;
  if (d.notSent) return `🛑 ${b}Not sent${b} — FM/CMS failed on ${plural(d.problems.length, "channel")}, nothing went out`;
  const what = [probs ? plural(probs, "problem") : "", checks ? `${checks} to check by hand` : ""].filter(Boolean).join(" · ");
  return what ? `⚠️ ${b}${what}${b} · ${d.ok}/${d.checked} channels confirmed`
              : `✅ ${b}All delivered${b} · ${d.ok}/${d.checked} channels confirmed`;
}

function dropText(d, link) {
  const L = [];
  L.push(`📊 *DROP REPORT — ${istHM(d.when)} IST · ${istDate(d.when)}*`);
  L.push(headLine(d, "*"));
  L.push("");
  L.push(`*Card:* ${d.card}`);
  if (d.headline) L.push(`*Post:* ${d.headline.slice(0, 120)}`);
  L.push(`*Sent:* ${d.mode}`);
  if (d.fmFrom) L.push(`*FM sent:* ${istT(d.fmFrom)}${d.fmTo !== d.fmFrom ? "–" + istT(d.fmTo) : ""} IST`);
  if (d.lagMin != null) L.push(`*Arrived:* ${d.lagMin.toFixed(1)}–${d.lagMax.toFixed(1)} min after FM (average ${d.lagAvg.toFixed(1)} min)`);
  if (d.retried) L.push(`*Note:* ${d.retried}`);
  for (const g of d.languages) {
    L.push("");
    L.push(`${g.flag} *${g.name.toUpperCase()}* — ${g.ok}/${g.checkable} delivered${g.notSent ? ` · ${g.notSent} not sent by content team` : ""}`);
    for (const r of g.rows) L.push(`• ${r.channel} — ${r.result}${r.posted !== "—" ? ` at ${r.posted} (${mins(r.lag)})` : ""}${r.match !== "—" ? ` · caption ${r.match}` : ""}`);
    if (g.viber) L.push(`• Viber — ≈ taken on FM's word`);
    else if (g.viberNotSent) L.push(`• Viber — ○ Not sent by content team`);
    if (g.xLen != null) L.push(`• X caption: ${g.xLen}/280 ${g.xLen > 280 ? "✗ too long" : g.xLen >= 270 ? "⚠ at the limit" : "✓"}`);
  }
  L.push("");
  if (d.problems.length) { L.push("*Needs attention:*"); for (const p of d.problems) L.push(`${p.check ? "⚠️" : "❌"} ${p.label} — ${p.why}`); }
  else L.push("*Needs attention:* nothing");
  if (d.captionWarnings.length) { L.push("*Caption warnings:*"); for (const w of d.captionWarnings) L.push(`⚠️ ${w}`); }
  if (link) { L.push(""); L.push(link); }
  return L.join("\n");
}

/* Adaptive Card items for one drop — a header, an overview, then a table per language */
const cell = (text, w, opts = {}) => ({ type: "Column", width: w, items: [{ type: "TextBlock", text, wrap: true, size: "Small", ...opts }] });
function dropCardItems(d, link) {
  const bad = d.problems.length > 0;
  const items = [
    { type: "Container", style: bad ? (d.problems.every(p => p.check) ? "warning" : "attention") : "good", bleed: true, items: [
      { type: "TextBlock", text: `📊 Drop report — ${istHM(d.when)} IST · ${istDate(d.when)}`, weight: "Bolder", size: "Large", wrap: true },
      { type: "TextBlock", text: headLine(d), weight: "Bolder", wrap: true, spacing: "Small" },
    ] },
    { type: "FactSet", spacing: "Medium", facts: [
      { title: "Card", value: d.card },
      ...(d.headline ? [{ title: "Post", value: d.headline.slice(0, 140) }] : []),
      { title: "Sent", value: d.mode },
      ...(d.fmFrom ? [{ title: "FM sent", value: `${istT(d.fmFrom)}${d.fmTo !== d.fmFrom ? " – " + istT(d.fmTo) : ""} IST` }] : []),
      ...(d.lagMin != null ? [{ title: "Arrived", value: `${d.lagMin.toFixed(1)} – ${d.lagMax.toFixed(1)} min after FM (avg ${d.lagAvg.toFixed(1)} min)` }] : []),
      ...(d.retried ? [{ title: "Note", value: d.retried }] : []),
    ] },
  ];
  for (const g of d.languages) {
    items.push({ type: "TextBlock", text: `${g.flag} **${g.name}** — ${g.ok}/${g.checkable} delivered${g.notSent ? ` · ${g.notSent} not sent by content team` : ""}`, weight: "Bolder", spacing: "Large", separator: true, wrap: true });
    items.push({ type: "ColumnSet", spacing: "Small", columns: [cell("**Channel**", 3), cell("**Result**", 3), cell("**Posted (IST)**", 3), cell("**After FM**", 2), cell("**Caption**", 2), cell("**Post**", 2)] });
    for (const r of g.rows)
      items.push({ type: "ColumnSet", spacing: "None", columns: [cell(r.channel, 3), cell(r.result, 3, { color: /✗|!/.test(r.result) ? "Attention" : /✓/.test(r.result) ? "Good" : /⚠|\?/.test(r.result) ? "Warning" : "Default", isSubtle: r.status === "not_sent" }),
        cell(r.posted, 3), cell(r.lag == null ? "—" : mins(r.lag), 2), cell(r.match, 2), cell(r.url ? `[open](${r.url})` : "—", 2)] });
    const notes = [g.viber ? "Viber ≈ taken on FM's word" : g.viberNotSent ? "Viber — not sent by content team" : "",
                   g.xLen != null ? `X caption ${g.xLen}/280 ${g.xLen > 280 ? "✗ too long" : g.xLen >= 270 ? "⚠ at the limit" : "✓"}` : ""].filter(Boolean);
    if (notes.length) items.push({ type: "TextBlock", text: notes.join(" · "), isSubtle: true, size: "Small", wrap: true, spacing: "Small" });
  }
  items.push({ type: "TextBlock", text: d.problems.length ? "**Needs attention**" : "**Needs attention:** nothing", spacing: "Large", separator: true, wrap: true });
  for (const p of d.problems) items.push({ type: "TextBlock", text: `${p.check ? "⚠️" : "❌"} **${p.label}** — ${p.why}`, wrap: true, color: p.check ? "Warning" : "Attention", spacing: "Small" });
  for (const w of d.captionWarnings) items.push({ type: "TextBlock", text: `⚠️ ${w}`, wrap: true, color: "Warning", spacing: "Small" });
  if (link) items.push({ type: "TextBlock", text: `[Open the Live page](${link}) · checked automatically by the SportsFC pipeline`, isSubtle: true, size: "Small", wrap: true, spacing: "Medium" });
  return items;
}

/* ── the daily summary ─────────────────────────────────────────────────────────────────────────────
   `all`: every ledger entry of the day (IST). A superseded first attempt is not a delivery of its own —
   only counted as a card the content team re-sent. */
function dayData(all, day) {
  const list = all.filter(e => e.status !== "superseded");
  const resent = new Set(all.filter(e => e.status === "superseded").map(e => e.setId));
  const checked = checkedOf(list), good = checked.filter(ok);
  const attention = list.filter(e => BAD.includes(e.status)).sort((a, b) => a.when - b.when)
    .map(e => ({ at: e.when, label: e.label, card: e.card, check: e.status === "not_visible", why: reason(e) }));
  const languages = LANGS.filter(([lg]) => list.some(e => e.language === lg)).map(([lg, flag, name]) => {
    const c = checkedOf(list.filter(e => e.language === lg));
    return { flag, name, ok: c.filter(ok).length, checked: c.length, attention: list.filter(e => e.language === lg && BAD.includes(e.status)).length };
  });
  const capWarn = list.filter(e => e.capProblem && !BAD.includes(e.status));
  const unwatched = list.filter(e => e.status === "unwatched");
  return {
    day, date: istDate(Date.parse(day + "T12:00:00+05:30")),
    drops: new Set(list.map(e => e.dropKey || e.setId)).size, deliveries: list.length,
    checked: checked.length, ok: good.length, late: checked.filter(e => e.status === "late").length,
    pct: checked.length ? Math.round(100 * good.length / checked.length) : null,
    viber: list.filter(e => e.status === "assumed").length,
    unwatched: unwatched.length, unwatchedWhat: [...new Set(unwatched.map(e => e.label))].join(", "),
    stillChecking: list.filter(e => ["waiting", "new", "fm_pending", "fm_failing"].includes(e.status)).length,
    resent: resent.size,
    captionWarnings: capWarn.map(e => `${e.label} ${istHM(e.when)} — ${e.capProblem}`),
    attention, languages,
  };
}

const dayHead = (s, b = "") => !s.checked ? `${b}No posts to check today${b}`
  : !s.attention.length ? `✅ ${b}All ${s.checked} posts confirmed on their channels${b}`
  : `⚠️ ${b}${s.ok} of ${s.checked} posts confirmed on their channels${b} · ${s.attention.length} need${s.attention.length === 1 ? "s" : ""} attention`;
const dayNotes = s => [
  s.late ? `${plural(s.late, "post")} arrived late (after 20 min)` : "",
  s.stillChecking ? `${plural(s.stillChecking, "delivery", "deliveries")} still being checked — in tomorrow's reports` : "",
  s.resent ? `${plural(s.resent, "card")} re-sent by the content team after a failed first attempt — counted once` : "",
  s.viber ? `Viber: ${s.viber} taken on FM's word (Viber can't be read)` : "",
  s.unwatched ? `${s.unwatched} to channels not set up here (${s.unwatchedWhat})` : "",
].filter(Boolean);

function dayText(s, link) {
  const L = [`📊 *DAILY SUMMARY — ${s.date}*`, dayHead(s, "*"), "",
    `*Today:* ${plural(s.drops, "drop")} · ${s.deliveries} deliveries from FM${s.pct != null ? ` · ${s.pct}% confirmed` : ""}`,
    `*By language:* ${s.languages.map(g => `${g.flag} ${g.name} ${g.ok}/${g.checked}`).join(" · ")}`];
  L.push("");
  if (s.attention.length) {
    L.push(`*Needs attention (${s.attention.length}):*`);
    for (const a of s.attention) L.push(`${a.check ? "⚠️" : "❌"} ${istHM(a.at)} ${a.label} — ${a.card}: ${a.why}`);
  } else L.push("*Needs attention:* nothing");
  if (s.captionWarnings.length) { L.push(""); L.push("*Caption warnings:*"); for (const w of s.captionWarnings) L.push(`⚠️ ${w}`); }
  const notes = dayNotes(s);
  if (notes.length) { L.push(""); L.push("*Notes:*"); for (const n of notes) L.push(`• ${n}`); }
  if (link) { L.push(""); L.push(link); }
  return L.join("\n");
}

function dayCardItems(s) {
  const items = [
    { type: "Container", style: s.attention.length ? (s.attention.every(a => a.check) ? "warning" : "attention") : "good", bleed: true, items: [
      { type: "TextBlock", text: `📊 Daily summary — ${s.date}`, weight: "Bolder", size: "Large", wrap: true },
      { type: "TextBlock", text: dayHead(s), weight: "Bolder", wrap: true, spacing: "Small" },
    ] },
    { type: "FactSet", spacing: "Medium", facts: [
      { title: "Drops", value: String(s.drops) },
      { title: "Deliveries from FM", value: String(s.deliveries) },
      { title: "Confirmed on the channel", value: `${s.ok} of ${s.checked}${s.pct != null ? ` (${s.pct}%)` : ""}` },
      ...(s.late ? [{ title: "Arrived late", value: String(s.late) }] : []),
      ...(s.viber ? [{ title: "Viber (FM's word)", value: String(s.viber) }] : []),
    ] },
    { type: "ColumnSet", spacing: "Large", separator: true, columns: [cell("**Language**", 4), cell("**Confirmed**", 3), cell("**Needs attention**", 3)] },
    ...s.languages.map(g => ({ type: "ColumnSet", spacing: "None", columns: [cell(`${g.flag} ${g.name}`, 4), cell(`${g.ok}/${g.checked}`, 3, { color: g.ok === g.checked ? "Good" : "Default" }),
      cell(g.attention ? String(g.attention) : "—", 3, { color: g.attention ? "Attention" : "Default" })] })),
    { type: "TextBlock", text: s.attention.length ? `**Needs attention (${s.attention.length})**` : "**Needs attention:** nothing", spacing: "Large", separator: true, wrap: true },
    ...s.attention.map(a => ({ type: "TextBlock", text: `${a.check ? "⚠️" : "❌"} **${istHM(a.at)} ${a.label}** — ${a.card}: ${a.why}`, wrap: true, color: a.check ? "Warning" : "Attention", spacing: "Small" })),
    ...s.captionWarnings.map(w => ({ type: "TextBlock", text: `⚠️ ${w}`, wrap: true, color: "Warning", spacing: "Small" })),
  ];
  const notes = dayNotes(s);
  if (notes.length) items.push({ type: "TextBlock", text: notes.map(n => "• " + n).join("\n\n"), isSubtle: true, size: "Small", wrap: true, spacing: "Medium" });
  return items;
}

module.exports = { dropData, dropText, dropCardItems, dayData, dayText, dayCardItems };
