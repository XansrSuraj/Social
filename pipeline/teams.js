/**
 * Alerts into a Microsoft Teams channel, through the Teams **Workflows** app — the official
 * replacement for the retired Office 365 "Incoming Webhook" connector (disabled May 2026).
 *
 * One-time setup (by someone in the team — the URL is a secret, never paste it in chat):
 *   1. Teams → the channel → ⋯ → Workflows → template "Send webhook alerts to a channel" → pick
 *      the team and channel → Save → copy the webhook URL it shows.
 *   2. Vercel → Settings → Environment Variables:  TEAMS_WEBHOOK_URL = that URL. Redeploy.
 *
 * One Adaptive Card per message: the problems of a tick together (a coloured section each — red for a
 * problem, amber for something to check), every drop report and the day's summary as a card of its
 * own, and a link to the Live page. Workflows does not render buttons, so the link is a markdown link.
 * Limits: 28 KB per message, 4 requests a second — far inside both.
 */
const { dropCardItems, dayCardItems } = require("./report.js");
const URL_ = () => String(process.env.TEAMS_WEBHOOK_URL || "").trim();
/* KILL SWITCH (14 Oct 2026, at the user's request): nothing goes to Teams — no new card, and nothing
   already queued is sent. Set TEAMS_OFF to false to turn Teams alerts on again. */
const TEAMS_OFF = true;
const configured = () => !TEAMS_OFF && /^https:\/\//.test(URL_());

const STYLE = { missing: "attention", fm_failed: "attention", fm_down: "attention", pipeline: "attention", not_visible: "warning", reader_down: "warning",
                reader_failed: "warning", caption: "warning", fm_stuck: "warning", fm_unconfirmed: "warning", late: "emphasis",
                reader_up: "good", digest: "emphasis", test: "good" };
/* WhatsApp's *bold* is Teams markdown's **bold** */
const md = s => String(s).replace(/\*([^*\n]+)\*/g, "**$1**");
/* how serious one alert is: a problem, something to check by hand, or fine */
const level = a => a.report ? (a.report.problems.some(p => !p.check) ? "bad" : a.report.problems.length ? "warn" : "ok")
  : a.digest ? (a.digest.attention.some(x => !x.check) ? "bad" : a.digest.attention.length ? "warn" : "ok")
  : STYLE[a.kind] === "attention" ? "bad" : STYLE[a.kind] === "warning" ? "warn" : "ok";

function card(alerts, { title = "SportsFC · FM ↔ channels", link = "" } = {}) {
  const levels = alerts.map(level);
  const color = levels.includes("bad") ? "Attention" : levels.includes("warn") ? "Warning" : "Good";
  const body = [
    { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", color, wrap: true },
    { type: "TextBlock", text: `${alerts.length} update${alerts.length === 1 ? "" : "s"} · ${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 16).replace("T", " ")} IST`,
      isSubtle: true, spacing: "None", size: "Small" },
  ];
  for (const a of alerts) {
    /* a drop that settled: its full report — overview, a table per language, problems */
    if (a.report) { body.push({ type: "Container", spacing: "Large", separator: true, items: dropCardItems(a.report) }); continue; }
    /* the day's summary: totals, a table per language, what needs attention */
    if (a.digest) { body.push({ type: "Container", spacing: "Large", separator: true, items: dayCardItems(a.digest) }); continue; }
    const [head, ...rest] = String(a.text).split("\n");
    const style = STYLE[a.kind] || "default";
    body.push({ type: "Container", style, bleed: false, spacing: "Medium", items: [
      { type: "TextBlock", text: md(head), wrap: true, weight: "Bolder" },
      ...(rest.length ? [{ type: "TextBlock", text: rest.map(md).join("\n\n"), wrap: true, spacing: "Small" }] : []),
    ] });
  }
  if (link) body.push({ type: "TextBlock", text: `[Open the Live page](${link})`, wrap: true, spacing: "Medium" });
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null,
    content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", msteams: { width: "Full" }, body } }] };
}

async function post(payload) {
  if (TEAMS_OFF) return;
  const r = await fetch(URL_(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  if (r.status >= 300) throw new Error(`Teams ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

/* Send each queued card; a failed one stays queued (6 tries, then dropped) — same rule as WhatsApp. */
async function flush(queue, { send = post } = {}) {
  if (TEAMS_OFF) return { left: [], log: [] };            // switched off: the queue is dropped, nothing sent
  const left = [], log = [];
  for (const m of queue) {
    try { await send(m.payload); log.push({ at: Date.now(), ok: true, via: "teams", kind: m.kind }); }
    catch (e) {
      log.push({ at: Date.now(), ok: false, via: "teams", kind: m.kind, error: String(e.message || e).slice(0, 200) });
      if ((m.tries || 0) + 1 < 6) left.push({ ...m, tries: (m.tries || 0) + 1 });
    }
  }
  return { left, log };
}

module.exports = { configured, card, flush, post };
