# IT News

A daily list of IT and security news from 32 sources, with the same story from different outlets merged into one card. Stories reported by the most sources appear at the top.

## How it works

1. `scripts/fetch_news.py` reads every source in `sources.json`, keeps stories from the last 36 hours that no earlier day already lists, merges the same story reported by several outlets, tags topics with keyword rules, and writes `data/days/YYYY-MM-DD.json` plus `data/index.json`. It uses only the Python standard library.
2. The **Fetch news** GitHub Actions workflow runs that script daily at 10:30 UTC (06:30 Eastern in summer, 05:30 in winter) and commits the result. To fetch on demand, use Actions → Fetch news → Run workflow on GitHub.
3. The page (`index.html`, `app.js`, `style.css`, served by GitHub Pages) shows the day's stories:
   - **Most reported:** stories covered by more than one source, ranked by how many, with links to every outlet's version.
   - **Other stories:** single-source stories, newest first.
   - **New critical CVEs:** CVEs published to NIST's NVD in the window with a CVSS base score of 9.0 or higher (set by `min_cvss` in `sources.json`), highest first, each linked to NVD and to its MITRE-run cve.org record. These are listed separately and never merged into news stories.
   - Stories that mention a CVE scored High (7.0+) or Critical (9.0+) get a **CVSS badge** linking to NVD. Scores come from the CVE Program's record API (cveawg.mitre.org), using the highest of the CNA's and enrichers' (e.g. CISA's) scores, and are cached in `data/cve_scores.json`.
   - Filter by topic, source or search text. The **Sources** tab shows what each source returned and any errors.

Summaries come from each source's own text, shortened. No AI service is involved.

## Run locally

```bash
python -I scripts/fetch_news.py            # today's stories, US Eastern date
python -I scripts/fetch_news.py --hours 48 # wider window
python -m http.server 8000                 # then open http://localhost:8000
```

Running the fetch again on the same day adds new stories and keeps existing ones.

## Sources

`sources.json` lists each source (`name`, `url`, `category`). Most are RSS or Atom feeds; the fetcher reads RSS 2.0, RSS 1.0 (RDF, used by Slashdot) and Atom.

Sources without a usable feed have `"type": "page"` and a `parser` from `scripts/page_sources.py`:

| Source | What's read | Notes |
|---|---|---|
| CISA KEV | CISA's Known Exploited Vulnerabilities JSON feed | One story per newly added CVE, linked to NVD. CISA's advisory pages and RSS return 403 to scripts, so they aren't used. |
| MSRC Blog | microsoft.com/en-us/msrc/blog | The full post list loads with JavaScript; the page's HTML only carries the newest featured post. |
| SANS NewsBites | sans.org/newsletters/newsbites | One story per issue (semiweekly), titled with the issue's headlines. |
| NVD new CVEs | NVD CVE API 2.0 (`"type": "api"`) | CVEs published in the fetch window. Score = highest CVSS v4.0/v3.1/v3.0 base score, from NVD or the reporting CNA. About 900 CVEs a day are published, around 50 of them critical. No API key; public rate limit respected. |

Page sources check the site's robots.txt (fetched with the fetcher's own User-Agent) and send that honest User-Agent; nothing imitates a browser. Page parsers depend on each site's current layout. If a site changes, its row on the Sources tab shows "no items found", which means the parser needs updating.

MITRE sources are the ATT&CK blog and the CVE Program blog (Medium feeds). mitre.org's own news pages return 403 to scripts, so they aren't used.

Hardware sources (Tom's Hardware, ServeTheHome, The Next Platform, Data Center Dynamics, Blocks & Files, StorageReview, Phoronix) feed a **Hardware** topic.

Checked and left out in Oct 2026: Windows release health RSS (404), Neowin and ZDNET (too consumer-focused), TechPowerUp and HotHardware (mostly consumer/gaming hardware), Notebookcheck (feed full of deals). SANS is also covered by the Internet Storm Center diaries feed.
