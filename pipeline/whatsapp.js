/**
 * WhatsApp alerts through CallMeBot — free for personal notifications to your own number.
 *
 * One-time setup (by the phone's owner, never in chat):
 *   1. In WhatsApp, send  I allow callmebot to send me messages  to +34 644 05 92 17
 *      (the number listed on callmebot.com/blog/free-api-whatsapp-messages); the reply has an apikey.
 *   2. Vercel → Settings → Environment Variables:  WHATSAPP_PHONE = +91…   CALLMEBOT_APIKEY = <apikey>
 *      then redeploy.
 *
 * CallMeBot publishes no rate limit and is a free service, so the pipeline is gentle with it: alerts
 * are batched into one message per tick, long ones are split at line breaks, messages are spaced a
 * few seconds apart, and anything that fails stays in the outbox and is retried on the next tick.
 */
const PHONE = () => String(process.env.WHATSAPP_PHONE || "").trim();
const KEY = () => String(process.env.CALLMEBOT_APIKEY || "").trim();
const configured = () => !!(PHONE() && KEY());
const MAX_CHARS = 1500;

/* split a long text at line breaks into pieces CallMeBot will take in one GET */
function chunks(text) {
  const out = [];
  let cur = "";
  for (const line of String(text).split("\n")) {
    if ((cur + "\n" + line).length > MAX_CHARS && cur) { out.push(cur); cur = line; }
    else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out.map(c => c.slice(0, MAX_CHARS + 200));
}

async function sendOne(text) {
  const url = "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(PHONE()) +
              "&text=" + encodeURIComponent(text) + "&apikey=" + encodeURIComponent(KEY());
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const body = (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  /* CallMeBot answers 200 with an HTML page either way; its text says whether it queued the message */
  if (!r.ok || /error|invalid|not activated|limit|blocked/i.test(body) && !/queued|sent/i.test(body))
    throw new Error(`CallMeBot ${r.status}: ${body.slice(0, 160)}`);
  return body.slice(0, 120);
}

/* Send every message in the outbox, oldest first; returns what is left (failed ones, with a try
   count — a message that has failed 6 times is dropped so one bad message cannot block the rest). */
async function flush(outbox, { send = sendOne, gapMs = 3000, now = Date.now() } = {}) {
  const left = [], log = [];
  if (!configured() && send === sendOne) return { left: outbox, log: [{ at: now, ok: false, error: "WhatsApp is not configured (WHATSAPP_PHONE / CALLMEBOT_APIKEY)" }] };
  let first = true;
  for (const m of outbox) {
    try {
      for (const part of chunks(m.text)) {
        if (!first) await new Promise(r => setTimeout(r, gapMs));
        first = false;
        await send(part);
      }
      log.push({ at: now, ok: true, kind: m.kind, text: m.text.slice(0, 140) });
    } catch (e) {
      const tries = (m.tries || 0) + 1;
      log.push({ at: now, ok: false, kind: m.kind, error: String(e.message || e).slice(0, 200) });
      if (tries < 6) left.push({ ...m, tries });
    }
  }
  return { left, log };
}

/* ── phone push through ntfy (ntfy.sh) — a second, instant, free channel ──────────────────────
   No account, no signup: install the ntfy app, subscribe to your topic, and set NTFY_TOPIC (a long
   random name — whoever knows it can read the alerts) on Vercel. Sent once per message, alongside
   WhatsApp, so an alert still reaches the phone if CallMeBot is slow or down. */
const NTFY_TOPIC = () => String(process.env.NTFY_TOPIC || "").trim();
const pushConfigured = () => !!NTFY_TOPIC();
async function push(text, { problem = false, click = "", title = "" } = {}) {
  const r = await fetch((process.env.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "") + "/" + encodeURIComponent(NTFY_TOPIC()), {
    method: "POST", body: String(text).replace(/\*/g, "").slice(0, 3900), signal: AbortSignal.timeout(15000),
    /* HTTP headers must be Latin-1: ntfy decodes an RFC 2047 "=?UTF-8?B?…?=" title, so emoji survive */
    headers: { Title: "=?UTF-8?B?" + Buffer.from(title || (problem ? "SportsFC: problem found" : "SportsFC pipeline")).toString("base64") + "?=", Priority: problem ? "high" : "default",
               Tags: problem ? "warning" : "white_check_mark", ...(click ? { Click: click } : {}) } });
  if (!r.ok) throw new Error("ntfy " + r.status + ": " + (await r.text()).slice(0, 120));
}

module.exports = { configured, flush, chunks, sendOne, push, pushConfigured };
