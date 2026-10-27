"""Parsers for sources that have no usable RSS feed, read from their public listing pages.

Each parser takes the page HTML and returns raw items shaped like feed items:
  {"title", "url", "summary", "published"}  (published: ISO string or "")

Rules every parser follows:
- robots.txt is checked first (see robots_allows); a disallowed page is reported as an error, not fetched.
- The fetcher sends its own honest User-Agent; nothing here imitates a browser.
- Parsers are tied to each site's current markup. When a site changes, the parser returns
  nothing and the Sources tab shows "0 items", which is the cue to update the parser here.
"""
import html
import json
import re
from urllib.parse import urljoin, urlsplit
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


PARSERS = {
    "cisa_kev": parse_cisa_kev,
    "msrc_blog": parse_msrc_blog,
    "sans_newsbites": parse_sans_newsbites,
}
