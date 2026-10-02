/* Score one experiment's output against ground-truth.json.
   A scraped post "matches" a true post when the ids agree, or when the timestamps are within 3
   minutes (ids differ between readers: a Facebook reel's video id vs its post id, and so on).
   The questions that matter for the daily check:
     · recall  — of the true posts from the 24 h before the truth was read, how many were found?
     · times   — does every found post carry an exact timestamp (not "2h ago")?
     · text    — does it carry the caption?
   Usage: import { score, saveResult } from "./validate.mjs" */
import fs from "fs";
import path from "path";

const LAB = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
export const GT = JSON.parse(fs.readFileSync(path.join(LAB, "ground-truth.json"), "utf8")).channels;

export function score(channelId, posts) {
  const gt = GT[channelId];
  if (!gt) return { channelId, error: "no ground truth" };
  const newest = Math.max(...gt.posts.map(p => new Date(p.ts).getTime()));
  const target = gt.posts.filter(p => new Date(p.ts).getTime() >= newest - 24 * 3600e3);
  const got = (posts || []).filter(p => p && (p.ts || p.id));
  const found = target.filter(t => got.some(p =>
    (p.id && String(p.id) === t.id) ||
    (p.ts && Math.abs(new Date(p.ts) - new Date(t.ts)) <= 3 * 60e3)));
  const timed = got.filter(p => p.ts && isFinite(new Date(p.ts).getTime()));
  return {
    channelId, platform: gt.platform,
    returned: got.length,
    recall: `${found.length}/${target.length}`,
    recallPct: target.length ? Math.round(100 * found.length / target.length) : 0,
    exactTimes: got.length ? Math.round(100 * timed.length / got.length) + "%" : "—",
    captions: got.length ? Math.round(100 * got.filter(p => String(p.text || "").trim()).length / got.length) + "%" : "—",
    newerThanTruth: timed.filter(p => new Date(p.ts).getTime() > newest + 60e3).length,
  };
}

export function saveResult(name, data) {
  const file = path.join(LAB, "results", `${process.env.LAB_PREFIX || ""}${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), ...data }, null, 1));
  return file;
}

export function table(rows) {
  for (const r of rows) {
    if (r.error) { console.log(`  ${String(r.channelId).padEnd(8)} ERROR ${r.error}`); continue; }
    console.log(`  ${r.channelId.padEnd(8)} ${r.platform.padEnd(10)} returned ${String(r.returned).padStart(2)}  ` +
      `recall ${r.recall.padEnd(5)} (${String(r.recallPct).padStart(3)}%)  times ${String(r.exactTimes).padEnd(4)}  ` +
      `captions ${String(r.captions).padEnd(4)}  newer ${r.newerThanTruth}`);
  }
}
