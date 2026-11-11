# IT News

A daily list of IT and security news from 287 sources, refreshed every 30 minutes, with the same story from different outlets merged into one entry. Stories reported by the most sources appear at the top.

Live page: https://giles-de-streel.github.io/it-news-digest/

## How it works

1. `scripts/fetch_news.py` reads every source in `sources.json`, keeps stories from the last 36 hours that no earlier day already lists, merges the same story reported by several outlets, tags topics with keyword rules, and writes `data/days/YYYY-MM-DD.json` plus `data/index.json`. It uses only the Python standard library. A feed that times out, returns 429/5xx, or returns a web page instead of XML is retried once after 15 seconds; the Sources tab then says "Got a web page instead of the feed" (with the page title) rather than a raw XML parse error.
2. The **Fetch news** GitHub Actions workflow runs that script and commits the result. A Windmill job on the team automation host starts it every 30 minutes, at :00 and :30. GitHub's own schedule in the workflow is the backup 5 minutes later (:05 and :35): it fetches only if no other run has started since the current half hour (GitHub sometimes starts scheduled runs late or skips them, so it isn't the primary). Each run adds new stories to the current day (US Eastern date) and keeps the ones already there. To fetch on demand, use Actions → Fetch news → Run workflow on GitHub.
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
   - A small CSS-only stick figure runs back and forth in the header between the logo and the controls, with a dog following it: the figure shakes the "Updated" text at the right end and jabs the logo at the left, and the dog stops at a tree in the middle to sniff and pee (on phones it uses the rest of the logo row, the controls wrap below, and it waves at the right end instead).
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

`sources.json` lists each source (`name`, `site` for the outlet's home page, `url` for the feed or data endpoint, `category`). Most are RSS or Atom feeds; the fetcher reads RSS 2.0, RSS 1.0 (RDF, used by Slashdot) and Atom. When a feed fails a strict XML parse, the fetcher tries common repairs one at a time and then together: whitespace or a BOM before the XML declaration, a script appended after the closing root tag, HTML entities such as `&nbsp;` or a bare `&`, and control characters XML forbids. A feed that still doesn't parse is reported as an error; a well-formed feed is never altered. Atom entries with no `alternate` link use their `<id>` as the link when it is an http(s) URL (php.net lists only download enclosures).

Sources without a usable feed have `"type": "page"` and a `parser` from `scripts/page_sources.py`:

| Source | What's read | Notes |
|---|---|---|
| CISA KEV | CISA's Known Exploited Vulnerabilities JSON feed | One story per newly added CVE, linked to NVD. CISA's advisory pages and RSS return 403 to scripts, so they aren't used. |
| MSRC Blog | microsoft.com/en-us/msrc/blog | The full post list loads with JavaScript; the page's HTML only carries the newest featured post. |
| SANS NewsBites | sans.org/newsletters/newsbites | One story per issue (semiweekly), titled with the issue's headlines. |
| Mozilla Security Advisories | mozilla.org/en-US/security/advisories | One story per MFSA advisory with its impact level, dated by the page's day headings. The RSS feed linked from older pages returns 404. |
| Anthropic News | anthropic.com/news | One story per post (top tiles and the full listing), dated by each entry's date. anthropic.com has no RSS feed. |
| Apple security releases | support.apple.com/en-us/100100 | One story per release with a published CVE list, dated by the table's release date. Releases with no published CVE entries are skipped. |
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

Checked and left out: EDUCAUSE, ServiceNow, ThousandEyes (403 to scripts); IAPP, Microsoft Entra blog, Semperis, Tomcat (no working feed); Configuration Manager blog, ADSecurity, AADInternals (no posts in 30 days). Blocks & Files was dropped on 2026-10-29: it started serving GitHub's runners an "Are we human?" bot-check page instead of its feed.

More sources (Nov 2026), each checked from both a workstation and the automation host before adding:
- Security news: CyberScoop, Security Affairs, Graham Cluley, Have I Been Pwned (new breaches).
- Threat research: CrowdStrike, SentinelLabs, Proofpoint Threat Insight, Qualys, GreyNoise, Arctic Wolf, Rapid7 (its feed parses once stray control characters are removed).
- Vendor advisories: Chrome Releases, Mozilla and Apple (page parsers), Jenkins, GitLab security releases, AWS security bulletins, Node.js vulnerability posts, PHP releases, OpenSSL news, Canadian Centre for Cyber Security. Vulnerabilities: CERT/CC vulnerability notes.
- Higher ed: Higher Ed Dive, EdTech Magazine (Higher Ed). Identity: Duo, Auth0, Palo Alto Networks identity security (formerly CyberArk).
- Internet infrastructure: Internet Society, RIPE Labs, Fastly. Networking: ipSpace.net.
- Linux admin: Fedora Magazine, OMG! Ubuntu, AlmaLinux. Virtualization: Proxmox announcements. Backup & recovery: Backblaze.
- Endpoint management: HTMD (Anoop C Nair), Prajwal Desai. Windows & M365 admin: Microsoft 365 Blog, Neowin.
- Privacy & compliance: EFF Deeplinks, NIST Cybersecurity Insights. Accessibility: WebAIM, Adrian Roselli.
- IT industry: ZDNet, TechTarget News, GeekWire, BBC Technology, Guardian Technology; added through the Add button: CNBC Technology, OpenAI News, NASA News Releases (Science & space).
- From the Suggested sources list (Nov 11 2026), each feed test-fetched with the fetcher's own code first: 9to5Mac, NBC News Tech (its tech feed, not the all-news one), Nieman Lab, Resilience Media, Variety Digital (the digital section; its technology feed stopped in 2020), Kagi Blog, Anthropic News (page parser), Semafor (only its Technology and Security items, via `category_include`), Google Blog (Vendor), Smithsonian Magazine (Science & space); Development blogs: Kevin Boone, Terence Eden, David Bushell, Entropic Thoughts, Maurycy's Blog, null program. Calcalist Tech was left out: no feed, and its front page carries no dates.
- Left out: Wired and The Verge (paywalled), 404 Media (many articles need a sign-up), Windows Central (mostly gaming and consumer), Grafana Labs and Blocks & Files (block GitHub's runners); CISA advisories, EDUCAUSE, Akamai and Rubrik (403 to scripts); Packet Storm (TLS failure); JPCERT/CC English feed (monthly Microsoft/Adobe roundups already covered first-hand); Ars Technica security tag, Red Canary, TPGi and Claroty disclosures (no recent posts); Dragos, SUSE, Citrix, Synacktiv and SonicWall (no feed that parses).

TLS & PKI sources (Nov 11 2026) feed a **TLS & PKI** topic (TLS and certificates, CAs and root programs, ACME, revocation, post-quantum crypto, crypto libraries; it also tags matching stories from every other source): Let's Encrypt, Feisty Duck Newsletter (Ivan Ristić), Mozilla Security Blog, Google Online Security Blog, DigiCert Blog (TLS & PKI posts only, via `title_include`; its UltraDNS and marketing posts are dropped, and `title_strip` removes the " | DigiCert" suffix), IETF Blog, Filippo Valsorda, Matthew Green, Soatok, Latacora, PQShield, and Sectigo (no feed of its own, so it is read from a Google News search for `site:sectigo.com when:7d`; links open through news.google.com, `title_strip` removes the " - Sectigo" suffix and `title_include` drops datasheet, tool and download pages). Checked and left out: CA/Browser Forum, GlobalSign, Keyfactor, Chrome Root Program and NIST CSRC (no working feed), Entrust (403), SSL.com, Chromium Blog and Hanno Böck (no recent posts), wolfSSL (mostly webinar announcements) and IACR News (academic paper firehose).

Security research sources feed three extra topics, **Reverse engineering**, **Forensics & IR** and **Pen testing & red team**:
- Threat research: Cisco Talos, Unit 42, Microsoft Security Blog, Check Point Research, ESET WeLiveSecurity, Securelist, Sophos X-Ops, Huntress, Malwarebytes Labs, Volexity, Schneier on Security.
- Reverse engineering: Google Project Zero, Hex-Rays (IDA), Binary Ninja, Objective-See, Elastic Security Labs, Trail of Bits, Zero Day Initiative.
- Forensics & IR: The DFIR Report, This Week in 4n6, Forensic Focus, Magnet Forensics.
- Pen testing: PortSwigger Research, SpecterOps, Horizon3.ai, Bishop Fox, TrustedSec, Black Hills InfoSec, watchTowr Labs, Exploit-DB.

Vendor advisories: Cisco PSIRT, Fortinet PSIRT, Palo Alto Networks, Ivanti, CERT-EU, NCSC UK, Red Hat security advisories and Adobe ColdFusion bulletins. More security news: Infosecurity Magazine, Cybersecurity Dive, Risky Business News, Troy Hunt, Wiz Research.

- **Red Hat** uses the RHSA feed with `"title_include": ": (Important|Critical):"`. Any source can set `title_include`, a regex an item's title must match to be kept.
- **Semafor** publishes one all-topics feed, so it uses `"category_include": "Technology|Security"`. Any feed source can set `category_include`, a regex that at least one of an item's RSS `<category>` (or Atom `term`) values must fully match to be kept.
- **Embedded Computing Design** put its whole site, feed and robots.txt included, behind a Cloudflare browser challenge on 2026-11-06 (403 to every script; its FeedBurner copy stopped the same day). It is read from a Google News search feed limited to the site instead, so its links open through news.google.com, and `"title_strip": " - Embedded Computing Design$"` removes the suffix Google adds. Any source can set `title_strip`, a regex removed from each title. Switch back to https://embeddedcomputing.com/rss if the challenge is lifted.
- **Adobe ColdFusion bulletins** are read by the `adobe_product_bulletins` page parser from helpx.adobe.com/security/products/coldfusion.html, dated by "Originally posted". Adobe's all-products bulletin list loads with JavaScript, so it isn't used. The same parser should work for other helpx product pages.
- Checked and left out in Oct 2026: Microsoft Security Update Guide RSS (about 300 CVE entries a day), Broadcom/VMware, Citrix and SC Media feeds (malformed XML).

Checked and left out: Google Threat Intelligence (its feed URL returns a web page), NCC Group (no feed found), Reddit r/ReverseEngineering and r/netsec (Reddit rate-limits feed readers), Red Canary and Binarly (no posts in 30 days).

**Suggested sources:** each run also records which outside sites the aggregator sources link to. In `sources.json`, `"discover": "item"` counts an item's own link (Hacker News, Lobsters), and `"discover": "summary_link"` counts the first outside link in its description (Techmeme, whose item link is its own permalink). `scripts/source_discovery.py` keeps 30 days of those links per site in `data/source_candidates.json`. It skips sites already in `sources.json` and platforms like GitHub, YouTube and Wikipedia, and treats each subdomain of shared hosts (Substack, Medium, github.io and so on) as its own site. Only free-to-read sites are suggested. Known paywalled outlets (`PAYWALLED` in the script: FT, WSJ, Bloomberg, NYT, Wired, Reuters and others) are never recorded. For up to 5 other sites per run that have 3+ links, it fetches the latest linked article and drops the site if the page carries the schema.org paywall marker (`"isAccessibleForFree": false`) that publishers add for search engines. Metered sites often don't set it (Wired and The New Yorker pass this check), which is why the fixed list is needed too. A site whose article can't be fetched isn't listed, and is checked again after 14 days. Free sites then get a feed lookup: the home page's `<link rel="alternate">`, then `/feed`, `/rss.xml`, `/feed.xml`, `/atom.xml` and `/index.xml`, checking robots.txt first. Sites with no feed found are tried again after 14 days. The Sources tab lists the top 30 under **Suggested sources** with link counts, the latest linked story and the feed if one was found. Nothing is added automatically. Each suggestion has an **Add** button that opens a pre-filled GitHub issue titled "Add source: <site>" with the source as a JSON block (name, site, feed url, category) to check before submitting; when no feed was found, put the site's feed in `url`. The **Add source** workflow (`.github/workflows/add-source.yml`, `scripts/add_source.py`) runs only for open issues the repository owner opened: it test-fetches the feed with the fetcher's own code, adds it to `sources.json` if it returns stories, comments and closes the issue. A rejected issue gets a comment saying why and is re-checked when edited. Several adds can run at once: each push re-applies its add on the latest `main`. Sources can still be added by editing `sources.json` directly. A failure here never fails the fetch. A site counts as covered when any source's `site` or `url` is on the same registrable domain; outlets that use several domains are mapped to one in `DOMAIN_ALIASES` in `scripts/source_discovery.py` (e.g. bbc.co.uk and bbci.co.uk count as bbc.com, so BBC Technology covers them).

The **Sources** tab lists every source in `sources.json`, one row each in name order, with its category and that day's fetch status. Each source name links to the outlet's website (the `site` field), not its feed. A search box at the top of the tab filters both tables (the sources and the suggested sites) by name, category or site; every word typed must match, and `/` jumps to it while the Sources tab is open. Each source has an on/off switch that hides or shows its stories on the News and CVEs tabs. Switches are saved in the browser (localStorage `ind.sourcesOff`) and don't change what the workflow fetches. A story stays visible while any source that covered it is on.

Checked and left out in Oct 2026: Windows release health RSS (404), Neowin and ZDNET (too consumer-focused), TechPowerUp and HotHardware (mostly consumer/gaming hardware), Notebookcheck (feed full of deals). SANS is also covered by the Internet Storm Center diaries feed. Real Python (mostly quizzes and courses) and the Ansible blog (feed doesn't parse; Red Hat Blog covers it) were checked for Development and left out.
