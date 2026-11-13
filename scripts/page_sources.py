"""Sources that have no usable RSS feed: listing pages (PARSERS) and data APIs (API_FETCHERS).

Each one returns raw items shaped like feed items:
  {"title", "url", "summary", "published", "extra"?}  (published: ISO string or "")
"extra" holds fields copied onto the stored item as-is, e.g. kind/cve/cvss for CVE records.

Rules every parser follows:
- robots.txt is checked first (see robots_allows); a disallowed page is reported as an error, not fetched.
- The fetcher sends its own honest User-Agent; nothing here imitates a browser.
- Parsers are tied to each site's current markup. When a site changes, the parser returns
  nothing and the Sources tab shows "0 items", which is the cue to update the parser here.
"""
import hashlib
import html
import json
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.robotparser import RobotFileParser

_robots_cache = {}


def robots_allows(url, user_agent):
    """Check robots.txt, fetched with our own User-Agent.

    urllib's RobotFileParser.read() uses Python's default User-Agent, which some sites refuse,
    and it then treats the whole site as disallowed. Fetch the file ourselves instead.
    Per RFC 9309: a 4xx robots.txt means no restrictions; 5xx or a network error means stay out.
    """
    parts = urlsplit(url)
    base = f"{parts.scheme}://{parts.netloc}"
    if base not in _robots_cache:
        parser = RobotFileParser()
        try:
            with urlopen(Request(f"{base}/robots.txt", headers={"User-Agent": user_agent}), timeout=20) as resp:
                parser.parse(resp.read().decode("utf-8", "replace").splitlines())
        except HTTPError as exc:
            if 400 <= exc.code < 500:
                parser.parse([])
            else:
                parser.disallow_all = True
        except Exception:
            parser.disallow_all = True
        _robots_cache[base] = parser
    return _robots_cache[base].can_fetch(user_agent, url)


def _strip(fragment):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def parse_msrc_blog(page, base_url):
    """Microsoft Security Response Center blog landing page.

    The full post list loads with JavaScript, so the static HTML only carries the featured
    (newest) post: a heading, a one-line description and a dated /YYYY/MM/ link.
    """
    items = []
    pattern = re.compile(
        r'<p[^>]*class="c-heading-3"[^>]*>(.*?)</p>\s*<p[^>]*class="c-paragraph-4"[^>]*>(.*?)</p>\s*'
        r'<a[^>]+href="([^"]*/msrc/blog/\d{4}/\d{2}/[^"]+)"', re.S)
    for title, desc, href in pattern.findall(page):
        items.append({"title": _strip(title), "url": urljoin(base_url, href), "summary": _strip(desc), "published": ""})
    return items


def parse_sans_newsbites(page, base_url):
    """SANS NewsBites issue list. Issue data is embedded as JSON in the Next.js page payload.

    Each issue becomes one item; its title is the issue's headlines joined by semicolons.
    """
    text = page.replace('\\"', '"')
    pattern = re.compile(
        r'"createdAt":"([^"]+)"[^{}]*?"title":"((?:[^"\\]|\\.)*)"[^{}]*?"url":"(/newsletters/newsbites/[^"]+)"')
    items, seen = [], set()
    for created, title, path in pattern.findall(text):
        if path in seen:
            continue
        seen.add(path)
        try:
            title = json.loads(f'"{title}"')  # decode & and similar escapes
        except ValueError:
            pass
        issue = path.rsplit("/", 1)[-1].upper()
        items.append({
            "title": f"SANS NewsBites {issue}: {html.unescape(title)}",
            "url": urljoin(base_url, path),
            "summary": "Semiweekly SANS summary of the most important security news, with expert commentary.",
            "published": created,
        })
    return items


def parse_cisa_kev(page, base_url):
    """CISA Known Exploited Vulnerabilities catalog (official JSON data feed).

    One item per CVE. dateAdded is a date only; noon UTC places it on the right day for the
    fetch window. Used because CISA's advisory pages and RSS refuse scripted clients (403).
    """
    data = json.loads(page)
    items = []
    for v in data.get("vulnerabilities", []):
        cve = v.get("cveID", "")
        if not cve:
            continue
        ransomware = " Known use in ransomware campaigns." if v.get("knownRansomwareCampaignUse") == "Known" else ""
        due = f" Federal agencies must fix by {v['dueDate']}." if v.get("dueDate") else ""
        items.append({
            "title": f"CISA KEV adds {cve}: {v.get('vulnerabilityName') or (v.get('vendorProject', '') + ' ' + v.get('product', '')).strip()}",
            "url": f"https://nvd.nist.gov/vuln/detail/{cve}",
            "summary": f"{v.get('shortDescription', '').strip()}{ransomware}{due}".strip(),
            "published": f"{v['dateAdded']}T12:00:00+00:00" if v.get("dateAdded") else "",
        })
    return items


def parse_adobe_product_bulletins(page, base_url):
    """One product's security bulletin table on helpx.adobe.com (e.g. /security/products/coldfusion.html).

    Each row is "APSByy-nn : title" with Originally posted and Last updated dates (MM/DD/YYYY).
    The original posting date is used, at noon UTC like the KEV dates; an update to an old
    bulletin is not treated as new. Adobe's all-products bulletin list loads with JavaScript.
    """
    row = re.compile(
        r'<a[^>]+href="([^"]*/(apsb\d{2}-\d+)\.html)"[^>]*>(.*?)</a>.*?<p>\s*(\d{2})/(\d{2})/(\d{4})\s*</p>'
        r'(?:.*?<p>\s*(\d{2}/\d{2}/\d{4})\s*</p>)?', re.S | re.I)
    items, seen = [], set()
    for href, bid, label, mm, dd, yyyy, updated in row.findall(page):
        bid = bid.upper()
        if bid in seen:
            continue
        seen.add(bid)
        title = _strip(label)
        if not title.upper().startswith(bid):
            title = f"{bid}: {title}"
        title = re.sub(r"^(APSB\d{2}-\d+)\s*:\s*", r"\1: ", title, flags=re.I)
        items.append({
            "title": title,
            "url": urljoin(base_url, href),
            "summary": f"Adobe security bulletin {bid}, originally posted {mm}/{dd}/{yyyy}"
                       + (f", last updated {updated}." if updated else "."),
            "published": f"{yyyy}-{mm}-{dd}T12:00:00+00:00",
        })
    return items


_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def _noon_utc(day, month_name, year):
    """'26', 'Oct' or 'October', '2026' -> ISO noon UTC (same convention as the KEV dates); '' if unknown."""
    month = _MONTHS.get(month_name[:3].lower())
    if not month:
        return ""
    return f"{int(year):04d}-{month:02d}-{int(day):02d}T12:00:00+00:00"


def parse_mozilla_advisories(page, base_url):
    """Mozilla Foundation Security Advisories: <h2>Month D, YYYY</h2> followed by a list of
    MFSA links, each carrying its impact level (critical/high/moderate/low)."""
    items, seen = [], set()
    for block in re.split(r"<h2>", page)[1:]:
        date = re.match(r"\s*([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})\s*</h2>", block)
        if not date:
            continue
        published = _noon_utc(date.group(2), date.group(1), date.group(3))
        for href, level, mfsa, title in re.findall(
                r'<a href="([^"]*/advisories/mfsa[^"]+)"><span class="level (\w+)">([^<]+)</span>\s*(.*?)</a>', block, re.S):
            if href in seen:
                continue
            seen.add(href)
            items.append({
                "title": f"{_strip(mfsa)}: {_strip(title)}",
                "url": urljoin(base_url, href),
                "summary": f"Mozilla security advisory, impact {level}.",
                "published": published,
            })
    return items


def parse_apple_security_releases(page, base_url):
    """Apple security releases table (support.apple.com/en-us/100100): name and link, the
    platforms it is available for, and the release date ("26 Oct 2026"). Rows without a link
    are releases with no published CVE entries and are skipped."""
    items, seen = [], set()
    for row in re.findall(r"<tr>(.*?)</tr>", page, re.S):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        if len(cells) < 3:
            continue
        link = re.search(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', cells[0], re.S)
        date = re.search(r"(\d{1,2})\s+([A-Z][a-z]{2,8})\s+(\d{4})", _strip(cells[2]))
        if not link or not date:
            continue
        url = urljoin(base_url, link.group(1))
        if url in seen:
            continue
        seen.add(url)
        available = _strip(cells[1])
        items.append({
            "title": f"Apple security release: {_strip(link.group(2))}",
            "url": url,
            "summary": f"Available for {available}." if available else "",
            "published": _noon_utc(date.group(1), date.group(2), date.group(3)),
        })
    return items


def parse_anthropic_news(page, base_url):
    """Anthropic newsroom (www.anthropic.com/news). Two layouts carry stories: <article> tiles at the
    top and <li class="..._row"> rows in the full listing. Each block has a <time>Mon D, YYYY</time>
    and a link to /news/<slug> wrapping an <h3> headline (possibly inside spans), followed by a <p>
    summary. Category links (/news/policy etc.) hold no headline, so they never match. Blocks without
    a date (e.g. a featured hero) are skipped; a story listed twice is kept once."""
    items, seen = [], set()
    for block in re.split(r"<article\b|<li\b[^>]*class=\"[^\"]*_row\b", page)[1:]:
        block = re.split(r"</article>|</li>", block, maxsplit=1)[0]
        date = re.search(r"<time[^>]*>\s*([A-Z][a-z]{2,8})\s+(\d{1,2}),\s*(\d{4})\s*</time>", block)
        link = re.search(r'<a[^>]+href="(/news/[a-z0-9][a-z0-9-]*)"[^>]*>(?:(?!</a>).)*?<h\d[^>]*>(.*?)</h\d>', block, re.S)
        if not date or not link:
            continue
        url = urljoin(base_url, link.group(1))
        if url in seen:
            continue
        seen.add(url)
        summary = re.search(r"<p[^>]*>(.*?)</p>", block[link.end():], re.S)
        items.append({
            "title": _strip(link.group(2)),
            "url": url,
            "summary": _strip(summary.group(1)) if summary else "",
            "published": _noon_utc(date.group(2), date.group(1), date.group(3)),
        })
    return items


NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0"
NVD_PAGE_SIZE = 2000
NVD_MAX_PAGES = 5
NVD_PAUSE_SECONDS = 7  # public rate limit without an API key is 5 requests per 30 seconds


def _best_cvss(cve):
    """Highest base score across CVSS v4.0/v3.1/v3.0 metrics (NVD's own or the CNA's)."""
    best = None
    for key, version in (("cvssMetricV40", "4.0"), ("cvssMetricV31", "3.1"), ("cvssMetricV30", "3.0")):
        for metric in cve.get("metrics", {}).get(key, []):
            data = metric.get("cvssData", {})
            score = data.get("baseScore")
            if score is not None and (best is None or score > best["score"]):
                best = {"score": score, "severity": (data.get("baseSeverity") or "").title(), "version": version,
                        "scored_by": "NVD" if metric.get("type") == "Primary" else "CNA"}
    return best


def _first_sentence(text, limit=110):
    sentence = re.split(r"(?<=[.!?])\s", text.strip(), maxsplit=1)[0]
    return sentence if len(sentence) <= limit else sentence[:limit].rsplit(" ", 1)[0] + "…"


def fetch_nvd_cves(source, user_agent, hours):
    """CVEs published to NIST's NVD in the fetch window with a CVSS base score >= source["min_cvss"]."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    stamp = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    min_score = float(source.get("min_cvss", 9.0))
    items, start_index = [], 0
    for page in range(NVD_MAX_PAGES):
        if page:
            time.sleep(NVD_PAUSE_SECONDS)
        query = urlencode({"pubStartDate": stamp(start), "pubEndDate": stamp(end),
                           "resultsPerPage": NVD_PAGE_SIZE, "startIndex": start_index})
        with urlopen(Request(f"{NVD_API}?{query}", headers={"User-Agent": user_agent}), timeout=90) as resp:
            data = json.load(resp)
        for vuln in data.get("vulnerabilities", []):
            cve = vuln.get("cve", {})
            cvss = _best_cvss(cve)
            if not cvss or cvss["score"] < min_score or cve.get("vulnStatus") == "Rejected":
                continue
            cve_id = cve.get("id", "")
            desc = next((d["value"] for d in cve.get("descriptions", []) if d.get("lang") == "en"), "")
            items.append({
                "title": f"{cve_id}: {_first_sentence(desc)}",
                "url": f"https://nvd.nist.gov/vuln/detail/{cve_id}",
                "summary": desc,
                "published": cve.get("published", "") + ("" if cve.get("published", "").endswith("Z") else "Z"),
                "extra": {"kind": "cve", "cve": cve_id, "cvss": cvss,
                          "cve_org_url": f"https://www.cve.org/CVERecord?id={cve_id}"},
            })
        start_index += NVD_PAGE_SIZE
        if start_index >= data.get("totalResults", 0):
            break
    return items


MS_STATUS_API = "https://status.cloud.microsoft/api/posts/"
MS_STATUS_PAGE = "https://status.cloud.microsoft/"


def fetch_microsoft_status(source, user_agent, hours):
    """The current post for each service on status.cloud.microsoft (source["services"], e.g.
    "mac" = Microsoft 365, "ppac" = Power Platform). The page's own RSS feeds title every post
    with the service name and share one link, so this reads the JSON the page itself uses.

    Each service shows one post at a time; "Status": "Available" with no title means no incident.
    Every update to an incident gets a new post Id, so the stored id is built from the service and
    the incident title instead: one story per incident, not one per hourly update."""
    items = []
    for service in source.get("services", ["mac"]):
        with urlopen(Request(MS_STATUS_API + service, headers={"User-Agent": user_agent, "Accept": "application/json"}), timeout=30) as resp:
            post = json.load(resp)
        posts = post if isinstance(post, list) else [post]
        for p in posts:
            title = (p.get("Title") or "").strip()
            if not title or p.get("Status") == "Available":
                continue
            message = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", p.get("Message") or ""))).strip()
            current = re.search(r"Current status:\s*(.*?)(?:Scope of impact:|Next update by:|$)", message, re.S)
            status = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", p.get("Status") or "").capitalize()
            summary = (f"{status}. " if status else "") + (current.group(1).strip() if current else message)
            key = f"{MS_STATUS_PAGE}|{service}|{title.lower()}"
            items.append({
                "title": title,
                "url": MS_STATUS_PAGE,
                "summary": summary,
                "published": p.get("AuthoredDateTime") or p.get("LastUpdatedTime") or "",
                # Overrides the url-based id (all posts share the page URL), see docstring
                "extra": {"id": hashlib.sha1(key.encode()).hexdigest()[:12]},
            })
    return items


API_FETCHERS = {
    "microsoft_status": fetch_microsoft_status,
    "nvd_cves": fetch_nvd_cves,
}


PARSERS = {
    "adobe_product_bulletins": parse_adobe_product_bulletins,
    "anthropic_news": parse_anthropic_news,
    "apple_security_releases": parse_apple_security_releases,
    "cisa_kev": parse_cisa_kev,
    "mozilla_advisories": parse_mozilla_advisories,
    "msrc_blog": parse_msrc_blog,
    "sans_newsbites": parse_sans_newsbites,
}
