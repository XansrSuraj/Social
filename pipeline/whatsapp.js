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

module.exports = { configured, flush, chunks, sendOne };
