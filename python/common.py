"""Shared by the Python experiments (Selenium, Scrapy): the same post finders as node/extract.mjs
and the same scoring as node/validate.mjs, so every tool is judged identically."""
import json, os, re
from datetime import datetime, timezone

LAB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GT = json.load(open(os.path.join(LAB, "ground-truth.json"), encoding="utf-8"))["channels"]

TARGETS = [
    {"channel": "ig-vn",   "platform": "instagram", "handle": "sportsfc.vn",   "url": "https://www.instagram.com/sportsfc.vn/"},
    {"channel": "ig-fans", "platform": "instagram", "handle": "sportsfc.fans", "url": "https://www.instagram.com/sportsfc.fans/"},
    {"channel": "fb-vn",   "platform": "facebook",  "handle": "sportsfc.vn",   "url": "https://www.facebook.com/sportsfc.vn/reels/"},
    {"channel": "fb-fans", "platform": "facebook",  "handle": "Sportsfc.fans", "url": "https://www.facebook.com/Sportsfc.fans/reels/"},
    {"channel": "x-vn",    "platform": "x",         "handle": "Sportsfcvn",    "url": "https://x.com/Sportsfcvn"},
    {"channel": "tt-vn",   "platform": "tiktok",    "handle": "sportsfc.vn",   "url": "https://www.tiktok.com/@sportsfc.vn"},
]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"


def iso(v):
    try:
        if isinstance(v, (int, float)):
            t = v / 1000 if v > 1e12 else v
            return datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")
        return datetime.strptime(v, "%a %b %d %H:%M:%S %z %Y").astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def walk(v, visit, depth=0):
    if depth > 60 or not isinstance(v, (dict, list)):
        return
    if isinstance(v, dict):
        visit(v)
        for x in v.values():
            walk(x, visit, depth + 1)
    else:
        for x in v:
            walk(x, visit, depth + 1)


def _ig(o, h):
    code, t = o.get("code") or o.get("shortcode"), o.get("taken_at") or o.get("taken_at_timestamp")
    if not isinstance(code, str) or not t:
        return None
    owner = ((o.get("user") or {}).get("username") or (o.get("owner") or {}).get("username") or "")
    if owner and owner.lower() != h.lower():
        return None
    cap = o.get("caption")
    cap = cap.get("text", "") if isinstance(cap, dict) else (cap if isinstance(cap, str) else "")
    return {"id": code, "ts": iso(t), "text": cap}


def _fb(o, h):
    t = o.get("creation_time") or o.get("publish_time")
    if not isinstance(t, (int, float)):
        return None
    pid = o.get("post_id") or o.get("id") or (o.get("video") or {}).get("id")
    if not pid:
        return None
    msg = o.get("message")
    return {"id": str(pid), "ts": iso(t), "text": msg.get("text", "") if isinstance(msg, dict) else ""}


def _x(o, h):
    lg = o.get("legacy")
    if not o.get("rest_id") or not isinstance(lg, dict) or not lg.get("created_at") or "full_text" not in lg:
        return None
    return {"id": o["rest_id"], "ts": iso(lg["created_at"]), "text": lg["full_text"]}


def _tt(o, h):
    if not o.get("id") or not o.get("createTime") or "desc" not in o:
        return None
    a = o.get("author")
    a = a.get("uniqueId") if isinstance(a, dict) else a
    if isinstance(a, str) and a.lower() != h.lower():
        return None
    return {"id": str(o["id"]), "ts": iso(int(o["createTime"])), "text": o["desc"]}


FIND = {"instagram": _ig, "facebook": _fb, "x": _x, "tiktok": _tt}


def posts_from_json(platform, handle, bodies):
    by = {}
    def visit(o):
        p = FIND[platform](o, handle)
        if p and p["ts"] and (p["id"] not in by or (not by[p["id"]]["text"] and p["text"])):
            by[p["id"]] = p
    for b in bodies:
        walk(b, visit)
    return sorted(by.values(), key=lambda p: p["ts"], reverse=True)


def parse_bodies(text):
    t = re.sub(r"^for \(;;\);", "", text or "").strip()
    if not t or t[0] not in "{[":
        return []
    try:
        return [json.loads(t)]
    except Exception:
        out = []
        for line in t.splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
        return out


def bodies_from_html(html):
    out = []
    for m in re.finditer(r'<script[^>]*type="application/(?:json|ld\+json)"[^>]*>(.*?)</script>', html or "", re.S):
        try:
            out.append(json.loads(m.group(1)))
        except Exception:
            pass
    return out


def snowflake_time(i):
    try:
        return iso(((int(i) >> 22) + 1288834974657))
    except Exception:
        return None


def score(channel, posts):
    gt = GT[channel]
    def ms(s):
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
    newest = max(ms(p["ts"]) for p in gt["posts"])
    target = [p for p in gt["posts"] if ms(p["ts"]) >= newest - 24 * 3600e3]
    got = [p for p in (posts or []) if p.get("ts") or p.get("id")]
    found = [t for t in target if any((p.get("id") and str(p["id"]) == t["id"]) or
                                      (p.get("ts") and abs(ms(p["ts"]) - ms(t["ts"])) <= 3 * 60e3) for p in got)]
    timed = [p for p in got if p.get("ts")]
    return {"channel": channel, "platform": gt["platform"], "returned": len(got),
            "recall": f"{len(found)}/{len(target)}", "pct": round(100 * len(found) / len(target)) if target else 0,
            "times": f"{round(100 * len(timed) / len(got))}%" if got else "-",
            "captions": f"{round(100 * len([p for p in got if (p.get('text') or '').strip()]) / len(got))}%" if got else "-"}


def table(rows):
    for r in rows:
        print(f"  {r['channel']:<8} {r['platform']:<10} returned {r['returned']:>2}  recall {r['recall']:<5} ({r['pct']:>3}%)"
              f"  times {r['times']:<4}  captions {r['captions']}")


def save(name, data):
    data = {"ranAt": datetime.now(timezone.utc).isoformat(), **data}
    path = os.path.join(LAB, "results", os.environ.get("LAB_PREFIX", "") + name + ".json")
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return path
