/**
 * Alerts into a Microsoft Teams channel, through the Teams **Workflows** app — the official
 * replacement for the retired Office 365 "Incoming Webhook" connector (disabled May 2026).
 *
 * One-time setup (by someone in the team — the URL is a secret, never paste it in chat):
 *   1. Teams → the channel → ⋯ → Workflows → template "Send webhook alerts to a channel" → pick
 *      the team and channel → Save → copy the webhook URL it shows.
 *   2. Vercel → Settings → Environment Variables:  TEAMS_WEBHOOK_URL = that URL. Redeploy.
 *
 * Each tick's alerts go out as ONE Adaptive Card: a coloured section per alert (red for a problem,
 * green for a drop that was fully delivered), the drop's per-channel lines, and a link to the Live
 * page. Workflows does not render buttons, so the link is a markdown link. Limits: 28 KB per
 * message, 4 requests a second — one card per tick stays far inside both.
 */
const URL_ = () => String(process.env.TEAMS_WEBHOOK_URL || "").trim();
const configured = () => /^https:\/\//.test(URL_());

const STYLE = { missing: "attention", fm_failed: "attention", fm_down: "attention", pipeline: "attention", reader_down: "warning",
                reader_failed: "warning", caption: "warning", fm_stuck: "warning", fm_unconfirmed: "warning", late: "emphasis",
                reader_up: "good", digest: "emphasis", test: "good" };
/* WhatsApp's *bold* is Teams markdown's **bold** */
const md = s => String(s).replace(/\*([^*\n]+)\*/g, "**$1**");

function card(alerts, { title = "SportsFC · FM ↔ channels", link = "" } = {}) {
  const bad = alerts.some(a => STYLE[a.kind] === "attention" || /problem/.test(a.text) && a.kind === "slot");
  const body = [
    { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", color: bad ? "Attention" : "Good", wrap: true },
    { type: "TextBlock", text: `${alerts.length} update${alerts.length === 1 ? "" : "s"} · ${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 16).replace("T", " ")} IST`,
      isSubtle: true, spacing: "None", size: "Small" },
  ];
  for (const a of alerts) {
    const [head, ...rest] = String(a.text).split("\n");
    const style = a.kind === "slot" ? (/problem/.test(head) ? "attention" : "good") : (STYLE[a.kind] || "default");
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
  const r = await fetch(URL_(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  if (r.status >= 300) throw new Error(`Teams ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

/* Send each queued card; a failed one stays queued (6 tries, then dropped) — same rule as WhatsApp. */
async function flush(queue, { send = post } = {}) {
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
