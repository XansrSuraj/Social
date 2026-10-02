# free-scraper-lab

Experiments: can a **free** tool replace the paid Apify reads in the SportsFC daily check
(Facebook ×2, Instagram ×2, TikTok, X)? Kept completely apart from production — this folder is not
part of the `org-hub` repo, has its own packages, and its branch never deploys anywhere
(`vercel.json` turns deployments off).

**Findings so far: [FINDINGS.md](FINDINGS.md)**

| | |
|---|---|
| `ground-truth.json` | what each channel really had on 2026-10-02 (read by Apify) — every experiment is scored against it |
| `node/validate.mjs` | the scoring: recall of the last 24 h of true posts, exact times, captions |
| `node/extract.mjs` | shared extraction: the page's own API answers (JSON), then the DOM; X and TikTok post ids decoded into exact times |
| `node/exp1-crawlee.mjs` | Crawlee — `CheerioCrawler` (HTTP) and `PlaywrightCrawler` (browser + fingerprints) |
| `node/exp2-playwright.mjs` | raw Playwright — plain, stealth, and the real installed Chrome |
| `python/exp3_selenium.py` | Selenium — headless real Chrome, network capture through CDP |
| `python/exp4_scrapy.py` | Scrapy — plain HTTP |
| `.github/workflows/lab.yml` | runs all four on a GitHub runner (datacenter IP, TikTok reachable) and commits `results/gha-*` |

Run locally (from this folder):

```bash
cd node && npm install && node exp1-crawlee.mjs both && node exp2-playwright.mjs all
cd ../python && python -m venv .venv && .venv/Scripts/pip install selenium scrapy
.venv/Scripts/python exp3_selenium.py && .venv/Scripts/python exp4_scrapy.py
```

`sessions/` (gitignored) is where a logged-in browser session would go — account credentials,
never committed.
