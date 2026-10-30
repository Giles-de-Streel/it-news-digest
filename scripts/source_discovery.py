"""Suggest outlets to add as sources: sites that link aggregators (Hacker News, Lobsters, Techmeme)
point to often but sources.json doesn't cover yet.

Sources opt in with "discover" in sources.json: "item" counts the item's own link (Hacker News,
Lobsters), "summary_link" counts the first outside link in the item's description (Techmeme, whose
item link is its own permalink). Each run records those links per site, keeps the last WINDOW_DAYS
days, and looks for an RSS/Atom feed on a few of the most-linked sites. Nothing is added to
sources.json automatically; the Sources tab lists the candidates for a person to review.

Output: data/source_candidates.json
"""
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

WINDOW_DAYS = 30
MIN_MENTIONS = 3          # links in the window before a site is listed and its feed looked up
FEED_CHECKS_PER_RUN = 5   # keeps each hourly run quick and light on the sites
RECHECK_DAYS = 14         # look again for a feed on sites where none was found
EXAMPLES = 3

# Platforms and link hosts rather than outlets
IGNORE = {
    "github.com", "githubusercontent.com", "gitlab.com", "codeberg.org", "sr.ht",
    "youtube.com", "youtu.be", "vimeo.com", "twitter.com", "x.com", "bsky.app", "threads.net",
    "facebook.com", "instagram.com", "linkedin.com", "reddit.com", "redd.it", "tiktok.com",
    "news.ycombinator.com", "ycombinator.com", "lobste.rs", "techmeme.com", "slashdot.org",
    "wikipedia.org", "archive.org", "archive.ph", "archive.is", "google.com", "goo.gl",
    "docs.google.com", "drive.google.com", "apple.com", "apps.apple.com", "play.google.com",
    "arxiv.org", "doi.org", "pdfs.semanticscholar.org", "mastodon.social", "t.co", "bit.ly",
    "feedburner.com", "imgur.com", "dropbox.com", "notion.site",
}
# Shared hosts where each subdomain is its own site
MULTI_TENANT = (
    "substack.com", "medium.com", "github.io", "gitlab.io", "blogspot.com", "wordpress.com",
    "bearblog.dev", "micro.blog", "tumblr.com", "ghost.io", "netlify.app", "vercel.app",
    "pages.dev", "neocities.org", "svbtle.com", "hashnode.dev", "dev.to",
)
SECOND_LEVEL = {"co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"}
FEED_PATHS = ("/feed", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml")


def site_key(url):
    """The site a link belongs to: its registrable domain, or the full host on shared hosts."""
    host = (urlsplit(url).hostname or "").lower().removeprefix("www.")
    if not host or re.fullmatch(r"[\d.]+|\[.*\]", host):
        return ""
    if host.endswith(MULTI_TENANT):
        return host
    labels = host.split(".")
    if len(labels) >= 3 and labels[-2] in SECOND_LEVEL and len(labels[-1]) == 2:
        return ".".join(labels[-3:])  # e.g. bbc.co.uk
    return ".".join(labels[-2:])


class _Links(HTMLParser):
    def __init__(self, want):
        super().__init__()
        self.want, self.found = want, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if self.want == "a" and tag == "a" and a.get("href"):
            self.found.append(a["href"])
        elif (self.want == "feed" and tag == "link" and "alternate" in (a.get("rel") or "").lower()
              and re.search(r"(rss|atom)\+xml", a.get("type") or "", re.I) and a.get("href")):
            self.found.append(a["href"])


def first_outside_link(summary_html, own_url):
    """The first link in an item's description that points away from the aggregator itself."""
    p = _Links("a")
    try:
        p.feed(summary_html or "")
    except Exception:
        return None
    own = site_key(own_url)
    return next((h for h in p.found if h.startswith("http") and site_key(h) != own), None)


def _get(url, user_agent, accept, limit=600_000):
    req = Request(url, headers={"User-Agent": user_agent, "Accept": accept})
    with urlopen(req, timeout=10) as resp:
        return resp.geturl(), resp.read(limit)


def find_feed(home, user_agent, robots_allows, parse_feed):
    """Look for a working RSS/Atom feed: the home page's <link rel="alternate">, then common paths.
    Returns {"url", "items"} or {"error"}."""
    tried = []
    try:
        if not robots_allows(home, user_agent):
            return {"error": "robots.txt disallows the home page"}
        final, page = _get(home, user_agent, "text/html")
        p = _Links("feed")
        p.feed(page.decode("utf-8", "replace"))
        tried = [urljoin(final, h) for h in p.found[:2]]
    except Exception as exc:
        return {"error": f"Home page: {type(exc).__name__}: {str(exc)[:120]}"}
    base = f"{urlsplit(final).scheme}://{urlsplit(final).netloc}"
    for url in tried + [base + path for path in FEED_PATHS if base + path not in tried]:
        try:
            if not robots_allows(url, user_agent):
                continue
            _, data = _get(url, user_agent, "application/rss+xml, application/atom+xml, application/xml;q=0.9")
            items = parse_feed(data)
            if items:
                return {"url": url, "items": len(items)}
        except Exception:
            continue
    return {"error": "No working RSS/Atom feed found"}


def update(path, sources, results, user_agent, robots_allows, parse_feed):
    """Record this run's aggregator links, prune old ones, look up feeds, write the candidates file.
    Returns a one-line note for the run log."""
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    cands = {c["key"]: c for c in state.get("candidates", [])}
    known = {site_key(u) for s in sources for u in (s.get("site", ""), s.get("url", "")) if u}
    today = date.today().isoformat()

    for source, found, _error in results:
        if not source.get("discover"):
            continue
        for it in found:
            link = it.pop("_outlink", None) if source["discover"] == "summary_link" else it["url"]
            key = site_key(link or "")
            if not key or key in IGNORE or key in known:
                continue
            c = cands.setdefault(key, {"key": key, "mentions": [], "examples": []})
            mid = hashlib.sha1(link.encode()).hexdigest()[:12]
            if any(m[0] == mid for m in c["mentions"]):
                continue
            c["mentions"].append([mid, today, source["name"]])
            c["home"] = f"{urlsplit(link).scheme}://{urlsplit(link).netloc}/"
            c["examples"] = ([{"title": it["title"], "url": link, "date": today, "via": source["name"]}]
                             + c["examples"])[:EXAMPLES]
    for source, found, _error in results:  # never store the helper field in day files
        for it in found:
            it.pop("_outlink", None)

    oldest = (date.today() - timedelta(days=WINDOW_DAYS)).isoformat()
    for key in list(cands):
        c = cands[key]
        c["mentions"] = [m for m in c["mentions"] if m[1] >= oldest]
        c["examples"] = [e for e in c["examples"] if e["date"] >= oldest]
        if not c["mentions"] or key in known:  # aged out, or since added to sources.json
            del cands[key]

    recheck = (date.today() - timedelta(days=RECHECK_DAYS)).isoformat()
    due = sorted((c for c in cands.values() if len(c["mentions"]) >= MIN_MENTIONS
                  and not (c.get("feed") or {}).get("url") and (c.get("feed_checked") or "") < recheck),
                 key=lambda c: -len(c["mentions"]))[:FEED_CHECKS_PER_RUN]
    with ThreadPoolExecutor(max_workers=FEED_CHECKS_PER_RUN) as pool:
        for c, feed in zip(due, pool.map(lambda c: find_feed(c["home"], user_agent, robots_allows, parse_feed), due)):
            c["feed"], c["feed_checked"] = feed, today

    ordered = sorted(cands.values(), key=lambda c: (-len(c["mentions"]), c["key"]))
    path.write_text(json.dumps({
        "generated": today, "window_days": WINDOW_DAYS, "min_mentions": MIN_MENTIONS,
        "candidates": ordered,
    }, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    listed = sum(len(c["mentions"]) >= MIN_MENTIONS for c in ordered)
    return f"source suggestions: {listed} {'site' if listed == 1 else 'sites'} at {MIN_MENTIONS}+ links ({len(due)} feed lookups)"
