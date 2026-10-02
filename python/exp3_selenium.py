"""EXPERIMENT 3 — Selenium (Python), headless real Google Chrome (Selenium Manager fetches the
matching chromedriver by itself). The page's own API answers are captured through Chrome's
performance log + CDP Network.getResponseBody — the same jugaad as the Node experiments — then the
DOM: Instagram permalinks, X articles dated by their snowflake id.
Run:  .venv/Scripts/python exp3_selenium.py [channels]"""
import json, re, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from common import TARGETS, UA, iso, posts_from_json, parse_bodies, bodies_from_html, snowflake_time, score, table, save

only = [c for c in (sys.argv[1] if len(sys.argv) > 1 else "").split(",") if c]
targets = [t for t in TARGETS if not only or t["channel"] in only]

opts = webdriver.ChromeOptions()
opts.add_argument("--headless=new")
opts.add_argument("--window-size=1280,1600")
opts.add_argument("--disable-blink-features=AutomationControlled")
opts.add_argument(f"--user-agent={UA}")
opts.add_experimental_option("excludeSwitches", ["enable-automation"])
opts.set_capability("goog:loggingPrefs", {"performance": "ALL"})
driver = webdriver.Chrome(options=opts)
driver.set_page_load_timeout(45)
driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument",
                       {"source": "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"})


def captured_bodies():
    """JSON answers the page fetched, read back through CDP"""
    out = []
    for entry in driver.get_log("performance"):
        try:
            msg = json.loads(entry["message"])["message"]
        except Exception:
            continue
        if msg.get("method") != "Network.responseReceived":
            continue
        resp = msg["params"]["response"]
        if "json" not in (resp.get("mimeType") or "") and "graphql" not in resp.get("url", ""):
            continue
        try:
            body = driver.execute_cdp_cmd("Network.getResponseBody", {"requestId": msg["params"]["requestId"]})
            out += parse_bodies(body.get("body", ""))
        except Exception:
            pass
    return out


notes = {}
for t in targets:
    note = {"via": "network", "posts": []}
    try:
        driver.get_log("performance")            # drop what the previous page left
        driver.get(t["url"])
        time.sleep(5)
        for _ in range(4):
            driver.execute_script("window.scrollBy(0, 2500)")
            time.sleep(1.5)
        posts = posts_from_json(t["platform"], t["handle"], captured_bodies() + bodies_from_html(driver.page_source))
        if not posts and t["platform"] == "x":
            note["via"] = "dom + snowflake"
            seen = set()
            for a in driver.find_elements(By.TAG_NAME, "article"):
                for link in a.find_elements(By.TAG_NAME, "a"):
                    m = re.search(r"/%s/status/(\d{10,25})$" % re.escape(t["handle"]), link.get_attribute("href") or "", re.I)
                    if m and m.group(1) not in seen:
                        seen.add(m.group(1))
                        posts.append({"id": m.group(1), "ts": snowflake_time(m.group(1)), "text": a.text})
                        break
        if not posts and t["platform"] == "tiktok":
            note["via"] = "dom + video-id time"
            seen = set()
            for a in driver.find_elements(By.CSS_SELECTOR, 'a[href*="/video/"]'):
                m = re.search(r"/@%s/video/(\d{15,25})" % re.escape(t["handle"]), a.get_attribute("href") or "", re.I)
                if m and m.group(1) not in seen:
                    seen.add(m.group(1))
                    secs = int(m.group(1)) >> 32          # a TikTok id's top 32 bits are unix seconds
                    posts.append({"id": m.group(1), "ts": iso(secs), "text": a.get_attribute("title") or ""})
        if not posts and t["platform"] == "instagram":
            hrefs = []
            for e in driver.find_elements(By.CSS_SELECTOR, 'a[href*="/p/"], a[href*="/reel/"]'):
                h = (e.get_attribute("href") or "").split("?")[0]
                if h and h not in hrefs:
                    hrefs.append(h)
            note["via"] = f"permalinks ({len(hrefs[:6])})"
            for h in hrefs[:6]:
                try:
                    driver.get(h); time.sleep(2)
                    ts = driver.find_element(By.TAG_NAME, "time").get_attribute("datetime")
                    desc = driver.find_element(By.CSS_SELECTOR, 'meta[property="og:description"]').get_attribute("content")
                    posts.append({"id": re.search(r"/(?:p|reel)/([^/]+)", h).group(1), "ts": ts, "text": desc})
                except Exception:
                    pass
        note["posts"] = posts[:12]
        if not posts:
            note["pageSaid"] = re.sub(r"\s+", " ", driver.find_element(By.TAG_NAME, "body").text)[:160]
    except Exception as e:
        note["error"] = str(e).split("\n")[0][:160]
    notes[t["channel"]] = note

driver.quit()
print("\n── 3 Selenium · headless real Chrome · this machine")
table([score(t["channel"], notes[t["channel"]]["posts"]) for t in targets])
for t in targets:
    n = notes[t["channel"]]
    print(f"     {t['channel']}: {n.get('error') or 'via ' + n['via']}" + (f" — page said \"{n['pageSaid']}\"" if n.get("pageSaid") else ""))
print("\nsaved", save("exp3-selenium", {"selenium": notes}))
