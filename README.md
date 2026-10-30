# IT News

A daily list of IT and security news from 206 sources, refreshed every hour, with the same story from different outlets merged into one entry. Stories reported by the most sources appear at the top.

Live page: https://giles-de-streel.github.io/it-news-digest/

## How it works

1. `scripts/fetch_news.py` reads every source in `sources.json`, keeps stories from the last 36 hours that no earlier day already lists, merges the same story reported by several outlets, tags topics with keyword rules, and writes `data/days/YYYY-MM-DD.json` plus `data/index.json`. It uses only the Python standard library. A feed that times out, returns 429/5xx, or returns a web page instead of XML is retried once after 15 seconds; the Sources tab then says "Got a web page instead of the feed" (with the page title) rather than a raw XML parse error.
2. The **Fetch news** GitHub Actions workflow runs that script and commits the result. A Windmill job on the team automation host starts it at the top of every hour. GitHub's own schedule in the workflow is the backup at 5 minutes past: it fetches only if no other run has started since the top of the hour (GitHub sometimes starts scheduled runs late or skips them, so it isn't the primary). Each run adds new stories to the current day (US Eastern date) and keeps the ones already there. To fetch on demand, use Actions → Fetch news → Run workflow on GitHub.
3. The page (`index.html`, `app.js`, `style.css`, served by GitHub Pages) shows the day's stories:
   - **Most reported:** stories covered by more than one source, ranked by how many. The "N sources" button on each story opens a list of every outlet that covered it, each linked to that outlet's article (in card view the same links appear under "Also reported by").
   - **Current vulnerabilities:** every story with a CVSS badge (a CVE scored High 7.0+ or Critical 9.0+), highest score first. Single-source stories move here from Other stories; multi-source ones also stay in Most reported.
   - **Other stories:** single-source stories without a CVSS badge, newest first.
   - Each of these three sections shows its first 7 stories (`SECTION_CAP` in app.js); the rest fold under "N more stories". The limit is off while searching or when one source is picked.
   - **List view** (one line per story) is the default; the **Cards** button switches to cards with summaries. The choice is saved in the browser.
   - **CVEs tab** (direct link: `#cves`): CVEs published to NIST's NVD in the window with a CVSS base score of 9.0 or higher (set by `min_cvss` in `sources.json`), highest first, each linked to NVD and to its MITRE-run cve.org record. They have their own tab and search, and are never merged into news stories.
   - Stories that mention a CVE scored High (7.0+) or Critical (9.0+) get a **CVSS badge** linking to NVD. Scores come from the CVE Program's record API (cveawg.mitre.org), using the highest of the CNA's and enrichers' (e.g. CISA's) scores, and are cached in `data/cve_scores.json`.
   - **Exploitation signals** for every CVE a story or CVE record mentions, scored by CVSS or not:
     - **EPSS** badge: FIRST.org's estimated chance the CVE is exploited in the next 30 days (red at 10% or more, amber at 1% or more). Scores come from api.first.org in batches of 100, one request at a time, and are cached in `data/epss.json`, refreshed once a day. A brand-new CVE usually gets its first EPSS score the next day.
     - **Exploited** badge: the CVE is in CISA's Known Exploited Vulnerabilities catalog ("· ransomware" when CISA records ransomware use). The catalog is downloaded each run and cached in `data/kev.json`; if CISA can't be reached, the last good copy is used.

     Signals are attached when a day's file is written, so older days keep the scores they had then.
   - **Other stories** shows at most 8 single-source stories per source; the rest fold under "N more from …". Choosing that source or searching shows all of them.
   - **Last 7 days** in the day picker combines the last seven day files. Stories are ranked across the whole week and each card shows its date. The Sources tab then shows the latest day's fetch.
   - Filter by topic, source or search text. Topics are listed A-Z in a sticky left sidebar: every topic in `TOPIC_INFO` (app.js) plus any other topic found in the data, with zero-count topics dimmed. Below 900px wide the sidebar becomes a drop-down sheet opened by the **Topics** button; on phones the header scrolls away and only the filter bar stays pinned. The topic, source and search are kept in the address (`?topic=AI&source=...&q=...`), so views can be bookmarked or shared and Back steps through topic changes. Press `/` to jump to the search box. The search also covers the critical CVE records: matches appear in a **Matching CVEs** section (first when the search looks like a CVE ID, otherwise after the stories; more than 10 fold under "more"). Picking a topic shows a banner above the stories with the topic's full name (e.g. AI is "Artificial intelligence"), a one-line description, the story count, any source/search filter, and a button to clear it. The names live in `TOPIC_INFO` in app.js; keep them in step with `TOPICS` in fetch_news.py. The **Sources** tab shows what each source returned and any errors.
   - A small CSS-only stick figure runs back and forth in the header between the logo and the controls: it shakes the "Updated" text at the right end and jabs the logo at the left (on phones it uses the rest of the logo row, and the controls wrap below).
   - The browser tab and shortcut icon is the header's newspaper outline: `favicon.svg` (switches to a light stroke in dark mode) plus `icon-192.png` for shortcuts and home-screen icons. When changing an icon, give the new file a new name or `?v=` value; Firefox in particular keeps a page's old icons cached alongside new ones until they expire.

Summaries come from each source's own text, shortened. No AI service is involved.

## Run locally

```bash
python -I scripts/fetch_news.py            # today's stories, US Eastern date
python -I scripts/fetch_news.py --hours 48 # wider window
python -m http.server 8000                 # then open http://localhost:8000
```

Running the fetch again on the same day adds new stories and keeps existing ones.

## Sources

`sources.json` lists each source (`name`, `site` for the outlet's home page, `url` for the feed or data endpoint, `category`). Most are RSS or Atom feeds; the fetcher reads RSS 2.0, RSS 1.0 (RDF, used by Slashdot) and Atom.

Sources without a usable feed have `"type": "page"` and a `parser` from `scripts/page_sources.py`:

| Source | What's read | Notes |
|---|---|---|
| CISA KEV | CISA's Known Exploited Vulnerabilities JSON feed | One story per newly added CVE, linked to NVD. CISA's advisory pages and RSS return 403 to scripts, so they aren't used. |
| MSRC Blog | microsoft.com/en-us/msrc/blog | The full post list loads with JavaScript; the page's HTML only carries the newest featured post. |
| SANS NewsBites | sans.org/newsletters/newsbites | One story per issue (semiweekly), titled with the issue's headlines. |
| NVD new CVEs | NVD CVE API 2.0 (`"type": "api"`) | CVEs published in the fetch window. Score = highest CVSS v4.0/v3.1/v3.0 base score, from NVD or the reporting CNA. About 900 CVEs a day are published, around 50 of them critical. No API key; public rate limit respected. |

Page sources check the site's robots.txt (fetched with the fetcher's own User-Agent) and send that honest User-Agent; nothing imitates a browser. Page parsers depend on each site's current layout. If a site changes, its row on the Sources tab shows "no items found", which means the parser needs updating.

MITRE sources are the ATT&CK blog and the CVE Program blog (Medium feeds). mitre.org's own news pages return 403 to scripts, so they aren't used.

Hardware sources (Tom's Hardware, ServeTheHome, The Next Platform, Data Center Dynamics, StorageReview, Phoronix) feed a **Hardware** topic.

Development sources (GitHub Blog, Stack Overflow Blog, Hacker News (its own front-page feed, news.ycombinator.com/rss), Lobsters, InfoQ, The New Stack, LWN.net, PowerShell Team Blog, .NET Blog, VS Code Blog, Python Insider, Go Blog, Rust Blog, JetBrains Blog, Simon Willison) feed a **Development** topic. Python Insider moved from Blogger to blog.python.org in March 2026; the old feed is frozen.

Database sources (SQL Server Tech Community, Microsoft SQL Server Blog, Azure SQL Blog, Brent Ozar, Erik Darling, SQLServerCentral, Oracle Security Alerts, Mike Dietrich, Oracle-Base, dbi services, Pythian, PostgreSQL News, Planet PostgreSQL, Percona Blog, Redis blog, MongoDB blog) feed a **Databases** topic. Oracle's own blogs (Database Insider, MySQL) return 403 to scripts, so they aren't used. Sources aren't limited to products the team is known to run.

ICS / OT sources (Industrial Cyber, Siemens ProductCERT advisories, Waterfall Security) feed an **ICS / OT** topic; ICS stories from SecurityWeek already come through its main feed. Embedded sources (Embedded.com, Embedded Computing Design, Electronic Design, EE Times, CNX Software, Hackaday, Zephyr Project) feed an **Embedded & IoT** topic. Checked and left out: CISA ICS advisories, Armis and Eclypsium (403 to scripts; ICS KEV entries still arrive through the CISA KEV source), Dragos, Claroty, Nozomi, Control Global, Automation World and SANS ICS (no working feed found), Memfault Interrupt (no posts in 30 days).

Wider IT coverage (Oct 2026), with new topics **Higher education**, **Endpoint management**, **Backup & recovery**, **Supply chain security** and **Accessibility**:
- Higher ed: Campus Technology, Inside Higher Ed.
- Endpoint management: Microsoft Intune Blog, Intune Customer Success, Jamf Blog, Patch My PC.
- Virtualization: Virtualization Review, William Lam, Yellow Bricks, Nutanix.dev.
- Cloud: AWS What's New, AWS News Blog, Azure Updates, Azure Blog, Google Cloud Blog.
- Identity: Okta Security. Backup & recovery: Veeam, Commvault.
- DevOps & automation: Red Hat Ansible blog, HashiCorp, Kubernetes, Windmill.
- Java & web servers: Inside Java, NGINX, IIS Support Blog (Oracle security alerts were already listed).
- Networking: Packet Pushers, APNIC, Cloudflare. Privacy & compliance: HIPAA Journal, NIST News.
- Supply chain: OpenSSF, Socket, Snyk. Also Deque (accessibility), ITSM.tools, Power BI Blog.
- System administration (new **System administration** topic):
  - Windows & M365 admin: 4sysops, Petri, Office 365 for IT Pros, Microsoft 365 Roadmap, Exchange Team Blog, Core Infrastructure and Security Blog, Windows Blog, Windows Insider Blog, Sysinternals, Windows Admin Center, AskWoody.
  - Linux admin: Red Hat Enable Sysadmin, RHEL Blog, 9to5Linux, Linuxiac, It's FOSS, Ubuntu Blog, Linux kernel releases, Rocky Linux news, Jeff Geerling.
  - Ubuntu security notices and Debian security advisories (Vendor advisories).
  - Left out: PowerShell.org, SUSE, Admin Magazine (no working feed); Windows Server Blog (empty feed); Practical 365, nixCraft, Ask the Directory Services Team, Thomas Maurer (little or nothing in 30 days).
- DevOps & SRE (new **DevOps & SRE** topic): CNCF, Docker, GitLab, OpenTelemetry, Container Journal, SRE Weekly, Octopus Deploy, Honeycomb, Charity Majors, PlatformEngineering.org, Pulumi, Datadog, Last Week in Kubernetes Development, Istio, Martin Fowler, Azure DevOps Blog, GitHub Changelog, Terraform releases, Ansible community news; Chainguard under Supply chain security. Left out: Argo, OpenTofu, Podman, Helm, Prometheus, Last Week in AWS, Kubernetes Podcast (nothing in 30 days), Cloud Native Now (republishes Container Journal), Jenkins and Google Cloud DevOps/SRE (no working feed). DevOps.com and Grafana Labs were dropped on 2026-10-29: they return 403 to GitHub's runners.

Checked and left out: EDUCAUSE, ServiceNow, ThousandEyes (403 to scripts); IAPP, Microsoft Entra blog, Semperis, Tomcat (no working feed); Configuration Manager blog, ADSecurity, WebAIM, AADInternals (no posts in 30 days). Blocks & Files was dropped on 2026-10-29: it started serving GitHub's runners an "Are we human?" bot-check page instead of its feed.

Security research sources feed three extra topics, **Reverse engineering**, **Forensics & IR** and **Pen testing & red team**:
- Threat research: Cisco Talos, Unit 42, Microsoft Security Blog, Check Point Research, ESET WeLiveSecurity, Securelist, Sophos X-Ops, Huntress, Malwarebytes Labs, Volexity, Schneier on Security.
- Reverse engineering: Google Project Zero, Hex-Rays (IDA), Binary Ninja, Objective-See, Elastic Security Labs, Trail of Bits, Zero Day Initiative.
- Forensics & IR: The DFIR Report, This Week in 4n6, Forensic Focus, Magnet Forensics.
- Pen testing: PortSwigger Research, SpecterOps, Horizon3.ai, Bishop Fox, TrustedSec, Black Hills InfoSec, watchTowr Labs, Exploit-DB.

Vendor advisories: Cisco PSIRT, Fortinet PSIRT, Palo Alto Networks, Ivanti, CERT-EU, NCSC UK, Red Hat security advisories and Adobe ColdFusion bulletins. More security news: Infosecurity Magazine, Cybersecurity Dive, Risky Business News, Troy Hunt, Wiz Research.

- **Red Hat** uses the RHSA feed with `"title_include": ": (Important|Critical):"`. Any source can set `title_include`, a regex an item's title must match to be kept.
- **Adobe ColdFusion bulletins** are read by the `adobe_product_bulletins` page parser from helpx.adobe.com/security/products/coldfusion.html, dated by "Originally posted". Adobe's all-products bulletin list loads with JavaScript, so it isn't used. The same parser should work for other helpx product pages.
- Checked and left out in Oct 2026: Microsoft Security Update Guide RSS (about 300 CVE entries a day), Broadcom/VMware, Citrix and SC Media feeds (malformed XML).

Checked and left out: Google Threat Intelligence and Rapid7 (feeds don't parse), NCC Group (no feed found), Reddit r/ReverseEngineering and r/netsec (Reddit rate-limits feed readers), Red Canary and Binarly (no posts in 30 days).

The **Sources** tab lists every source in `sources.json`, one row each in name order, with its category and that day's fetch status. Each source name links to the outlet's website (the `site` field), not its feed. Each source has an on/off switch that hides or shows its stories on the News and CVEs tabs. Switches are saved in the browser (localStorage `ind.sourcesOff`) and don't change what the workflow fetches. A story stays visible while any source that covered it is on.

Checked and left out in Oct 2026: Windows release health RSS (404), Neowin and ZDNET (too consumer-focused), TechPowerUp and HotHardware (mostly consumer/gaming hardware), Notebookcheck (feed full of deals). SANS is also covered by the Internet Storm Center diaries feed. Real Python (mostly quizzes and courses) and the Ansible blog (feed doesn't parse; Red Hat Blog covers it) were checked for Development and left out.
