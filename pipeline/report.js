/**
 * The drop report: one drop (a card going out on every channel in every language), in full —
 * what went out, who sent it, where it landed, how fast, what didn't, and why.
 *
 * Built from the ledger's entries for that drop, in two forms from the same data:
 *   text  — for the phone (ntfy) and WhatsApp
 *   card  — Adaptive Card containers for the Teams channel (pipeline/teams.js)
 * Sent automatically when a drop settles (pipeline/tick.js), and on request for a past drop
 * (/api/pipeline?op=report&at=16:30).
 */
const { xLength } = require("./rules.js");

const SHORT = { youtube: "YouTube", telegram: "Telegram", telegram_direct: "Telegram bot", x: "X", facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", viber: "Viber" };
const LANGS = [["vietnamese", "🇻🇳", "Vietnamese"], ["english", "🇬🇧", "English"], ["portuguese", "🇧🇷", "Portuguese"], ["hindi", "🇮🇳", "Hindi"]];
const PROBLEM = { missing: "not on the channel 20 min after FM sent it", reader_failed: "couldn't be checked — the channel couldn't be read",
                  fm_failed: "FM failed to send it", fm_unconfirmed: "FM can't confirm it went out" };
const BAD = ["missing", "reader_failed", "fm_failed", "fm_unconfirmed"];
const istT = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 19);
const istHM = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16);
const istDate = ms => new Date(ms + 5.5 * 3600e3).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const mins = x => (x == null ? "—" : `+${Math.max(0, x).toFixed(1)} min`);
/* the card's headline in words: the English caption's first line, else any — links and emoji dropped */
const headline = list => {
  const pick = list.find(e => e.language === "english" && e.caption) || list.find(e => e.caption) || {};
  return String(pick.caption || "").split("\n").map(l => l.replace(/https?:\/\/\S+/g, "").replace(/[\p{Extended_Pictographic}️⃣]/gu, "").trim())
    .find(l => l.length > 8) || "";
};

function dropData(list) {
  const first = Math.min(...list.map(e => e.when));
  const sentTimes = list.filter(e => e.sentAt).map(e => Date.parse(e.sentAt));
  const checked = list.filter(e => e.mode === "verify" && e.fmState === "sent" && e.status !== "unverifiable");
  const ok = checked.filter(e => e.status === "verified" || e.status === "late");
  const bad = list.filter(e => BAD.includes(e.status));
  const lags = ok.map(e => e.lag).filter(x => x != null);
  const now = list.some(e => e.deliveryMode === "now");
  const languages = LANGS.filter(([lg]) => list.some(e => e.language === lg)).map(([lg, flag, name]) => {
    const mine = list.filter(e => e.language === lg);
    const rows = mine.filter(e => e.mode === "verify" && e.status !== "unverifiable").sort((a, b) => a.channel.localeCompare(b.channel)).map(e => ({
      channel: SHORT[e.channel] || e.channel, status: e.status,
      result: e.status === "verified" ? "✓ Delivered" : e.status === "late" ? "✓ Late" : e.status === "missing" ? "✗ Missing" :
              e.status === "reader_failed" ? "! Couldn't check" : e.status === "fm_failed" ? "✗ FM failed" : e.status === "waiting" ? "⏳ Checking" : e.status,
      posted: e.postAt ? istT(Date.parse(e.postAt)) : "—", lag: e.lag, match: e.sim != null ? `${e.sim}%` : "—", url: e.postUrl || "",
    }));
    const x = mine.find(e => e.channel === "x");
    return { lg, flag, name, rows, ok: rows.filter(r => r.status === "verified" || r.status === "late").length,
             viber: mine.filter(e => e.status === "assumed").length,
             cantCheck: mine.filter(e => e.status === "unverifiable").map(e => SHORT[e.channel] || e.channel),
             xLen: x ? xLength(x.caption) : null };
  });
  return {
    when: first, card: [...new Set(list.map(e => e.card))].join(" + "), headline: headline(list),
    mode: now ? "sent right away by an editor" : `scheduled${list[0].scheduledAt ? " for " + istHM(Date.parse(list[0].scheduledAt)) : ""} (sent by the scheduler)`,
    fmFrom: sentTimes.length ? Math.min(...sentTimes) : null, fmTo: sentTimes.length ? Math.max(...sentTimes) : null,
    checked: checked.length, ok: ok.length, viber: list.filter(e => e.status === "assumed").length,
    lagMin: lags.length ? Math.min(...lags) : null, lagMax: lags.length ? Math.max(...lags) : null,
    lagAvg: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : null,
    problems: bad.map(e => ({ label: e.label, why: PROBLEM[e.status] || e.status, extra: e.capProblem || (e.status === "reader_failed" ? e.readNote : "") || "" })),
    captionWarnings: list.filter(e => e.capProblem && !BAD.includes(e.status)).map(e => `${e.label}: ${e.capProblem}`),
    languages,
  };
}

function dropText(d, link) {
  const L = [];
  L.push(`📊 *DROP REPORT — ${istHM(d.when)} IST · ${istDate(d.when)}*`);
  L.push(d.problems.length ? `⚠️ *${d.problems.length} problem${d.problems.length === 1 ? "" : "s"}* · ${d.ok}/${d.checked} checked channels received it`
                           : `✅ *All delivered* · ${d.ok}/${d.checked} checked channels received it`);
  L.push("");
  L.push(`*Card:* ${d.card}`);
  if (d.headline) L.push(`*Post:* ${d.headline.slice(0, 120)}`);
  L.push(`*Sent:* ${d.mode}`);
  if (d.fmFrom) L.push(`*FM sent:* ${istT(d.fmFrom)}${d.fmTo !== d.fmFrom ? "–" + istT(d.fmTo) : ""} IST`);
  if (d.lagMin != null) L.push(`*Arrived:* ${d.lagMin.toFixed(1)}–${d.lagMax.toFixed(1)} min after FM (average ${d.lagAvg.toFixed(1)} min)`);
  for (const g of d.languages) {
    L.push("");
    L.push(`${g.flag} *${g.name.toUpperCase()}* — ${g.ok}/${g.rows.length} ✓`);
    for (const r of g.rows) L.push(`• ${r.channel} — ${r.result}${r.posted !== "—" ? ` at ${r.posted} (${mins(r.lag)})` : ""}${r.match !== "—" ? ` · caption ${r.match}` : ""}`);
    if (g.viber) L.push(`• Viber — ≈ taken on FM's word`);
    for (const c of g.cantCheck) L.push(`• ${c} — can't be checked (18+)`);
    if (g.xLen != null) L.push(`• X caption: ${g.xLen}/280 ${g.xLen > 280 ? "✗ too long" : g.xLen >= 270 ? "⚠ at the limit" : "✓"}`);
  }
  L.push("");
  if (d.problems.length) { L.push("*Problems:*"); for (const p of d.problems) L.push(`❌ ${p.label} — ${p.why}${p.extra ? ` (${p.extra})` : ""}`); }
  else L.push("*Problems:* none");
  if (d.captionWarnings.length) { L.push("*Caption warnings:*"); for (const w of d.captionWarnings) L.push(`⚠️ ${w}`); }
  if (link) { L.push(""); L.push(link); }
  return L.join("\n");
}

/* Adaptive Card items for one drop — a header, an overview, then a table per language */
function dropCardItems(d, link) {
  const bad = d.problems.length > 0;
  const cell = (text, w, opts = {}) => ({ type: "Column", width: w, items: [{ type: "TextBlock", text, wrap: true, size: "Small", ...opts }] });
  const items = [
    { type: "Container", style: bad ? "attention" : "good", bleed: true, items: [
      { type: "TextBlock", text: `📊 Drop report — ${istHM(d.when)} IST · ${istDate(d.when)}`, weight: "Bolder", size: "Large", wrap: true },
      { type: "TextBlock", text: bad ? `⚠️ ${d.problems.length} problem${d.problems.length === 1 ? "" : "s"} · ${d.ok}/${d.checked} checked channels received it`
                                     : `✅ All delivered · ${d.ok}/${d.checked} checked channels received it`, weight: "Bolder", wrap: true, spacing: "Small" },
    ] },
    { type: "FactSet", spacing: "Medium", facts: [
      { title: "Card", value: d.card },
      ...(d.headline ? [{ title: "Post", value: d.headline.slice(0, 140) }] : []),
      { title: "Sent", value: d.mode },
      ...(d.fmFrom ? [{ title: "FM sent", value: `${istT(d.fmFrom)}${d.fmTo !== d.fmFrom ? " – " + istT(d.fmTo) : ""} IST` }] : []),
      ...(d.lagMin != null ? [{ title: "Arrived", value: `${d.lagMin.toFixed(1)} – ${d.lagMax.toFixed(1)} min after FM (avg ${d.lagAvg.toFixed(1)} min)` }] : []),
    ] },
  ];
  for (const g of d.languages) {
    items.push({ type: "TextBlock", text: `${g.flag} **${g.name}** — ${g.ok}/${g.rows.length} delivered`, weight: "Bolder", spacing: "Large", separator: true, wrap: true });
    items.push({ type: "ColumnSet", spacing: "Small", columns: [cell("**Channel**", 3), cell("**Result**", 3), cell("**Posted (IST)**", 3), cell("**After FM**", 2), cell("**Caption**", 2), cell("**Post**", 2)] });
    for (const r of g.rows)
      items.push({ type: "ColumnSet", spacing: "None", columns: [cell(r.channel, 3), cell(r.result, 3, { color: /✗|!/.test(r.result) ? "Attention" : /✓/.test(r.result) ? "Good" : "Default" }),
        cell(r.posted, 3), cell(r.lag == null ? "—" : mins(r.lag), 2), cell(r.match, 2), cell(r.url ? `[open](${r.url})` : "—", 2)] });
    const notes = [g.viber ? "Viber ≈ taken on FM's word" : "", ...g.cantCheck.map(c => `${c} can't be checked (18+)`),
                   g.xLen != null ? `X caption ${g.xLen}/280 ${g.xLen > 280 ? "✗ too long" : g.xLen >= 270 ? "⚠ at the limit" : "✓"}` : ""].filter(Boolean);
    if (notes.length) items.push({ type: "TextBlock", text: notes.join(" · "), isSubtle: true, size: "Small", wrap: true, spacing: "Small" });
  }
  items.push({ type: "TextBlock", text: d.problems.length ? "**Problems**" : "**Problems:** none", spacing: "Large", separator: true, wrap: true });
  for (const p of d.problems) items.push({ type: "TextBlock", text: `❌ **${p.label}** — ${p.why}${p.extra ? ` (${p.extra})` : ""}`, wrap: true, color: "Attention", spacing: "Small" });
  for (const w of d.captionWarnings) items.push({ type: "TextBlock", text: `⚠️ ${w}`, wrap: true, color: "Warning", spacing: "Small" });
  if (link) items.push({ type: "TextBlock", text: `[Open the Live page](${link}) · checked automatically by the SportsFC pipeline`, isSubtle: true, size: "Small", wrap: true, spacing: "Medium" });
  return items;
}

module.exports = { dropData, dropText, dropCardItems };
