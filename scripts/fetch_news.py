"""Fetch IT news feeds, de-duplicate across sources, and write the day's candidate list.

Output:
  data/days/YYYY-MM-DD.json   candidate items for that day (merged if the script runs again)
  data/index.json             list of available days, newest first

Vetting decisions live in data/vetting.json and are written by the web page, never by this script.
Standard library only, so it runs the same locally and in GitHub Actions.
"""
import argparse
import hashlib
import html
import json
import math
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

# python -I (used in the workflow) leaves the script's folder off sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import page_sources  # noqa: E402
import cve_scores  # noqa: E402
import exploit_signals  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
USER_AGENT = "it-news-digest/1.0 (+https://github.com/Giles-de-Streel/it-news-digest)"
ATOM = "{http://www.w3.org/2005/Atom}"
CONTENT = "{http://purl.org/rss/1.0/modules/content/}"
RSS1 = "{http://purl.org/rss/1.0/}"
DC = "{http://purl.org/dc/elements/1.1/}"
SUMMARY_CHARS = 320

# Keyword rules for topic tags. A story can carry several tags.
TOPICS = {
    "Vulnerabilities & patches": r"\bcve-\d|vulnerab|zero-day|0-day|patch(es|ed)?\b|exploit|security update|hotfix|advisory|kev\b",
    "Ransomware & breaches": r"ransomware|breach|leak(ed)?\b|stolen|extortion|data theft|hacked|compromise",
    "Threats & malware": r"malware|phishing|botnet|trojan|backdoor|apt\d*\b|threat actor|infostealer|campaign|spyware",
    "Microsoft & Windows": r"microsoft|windows|azure|entra|intune|exchange|sharepoint|office 365|microsoft 365|defender|teams\b|sql server",
    "Linux & open source": r"linux|red hat|rhel|ubuntu|debian|open source|kernel|ansible|openssl",
    "Cloud & infrastructure": r"\baws\b|amazon web services|google cloud|\bgcp\b|cloud|kubernetes|vmware|broadcom|data center|datacenter|virtuali",
    "AI": r"\bai\b|artificial intelligence|llm|chatgpt|openai|copilot|gemini|claude|machine learning|genai",
    "Hardware": r"\bcpus?\b|\bgpus?\b|processor|semiconductor|\bchips?\b|chipmaker|nvidia|\bamd\b|\bintel\b|ryzen|epyc|xeon|\barm\b|qualcomm|tsmc|\bssds?\b|nvme|\bhdds?\b|hard drive|\bdram\b|\bddr\d|\bhbm\d?\b|flash storage|storage array|firmware|\bbios\b|uefi|motherboard|laptop|workstation|\brack\b|data cent(er|re)|datacenter|liquid cooling|power supply",
    "Development": r"programming|developer|\bcoding\b|source code|\bgit(hub|lab)?\b|python|powershell|javascript|typescript|\brust\b|golang|\bjava\b|\.net\b|c\+\+|compiler|\bsdks?\b|\bides?\b|vs code|visual studio|\bnpm\b|pypi|crates\.io|ci/cd|devops|refactor|open-source (library|project)",
    "Databases": r"database|\bsql\b|sql server|\bmssql\b|t-sql|postgres|mysql|mariadb|oracle (database|db|rac)|\brac\b|\brman\b|data ?guard|mongodb|redis|sqlite|\bdbas?\b|always ?on availability",
    "Networking": r"network|router|firewall|vpn|cisco|fortinet|palo alto|juniper|wi-?fi|\bdns\b|sd-wan",
    "Identity & access": r"identity|authenticat|passkey|\bmfa\b|password|sso\b|saml|oauth|credential",
    "Policy & regulation": r"regulat|\blaw\b|legislat|\bfcc\b|\bftc\b|\bsec\b filing|gdpr|cisa\b|government|congress|lawsuit|fine[ds]?\b",
}
TOPIC_RES = {name: re.compile(rx, re.I) for name, rx in TOPICS.items()}
STOPWORDS = set("a an the and or of to in on for with by from at as is are was be it its this that new how why what after over into via up out".split())


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def clean_text(raw):
    if not raw:
        return ""
    parser = _TextExtractor()
    try:
        parser.feed(raw)
        text = " ".join(parser.parts)
    except Exception:
        text = re.sub(r"<[^>]+>", " ", raw)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    # Common feed boilerplate
    text = re.sub(r"(The post .* appeared first on .*|Continue reading.*|Read more.*)$", "", text).strip()
    return text


def shorten(text, limit=SUMMARY_CHARS):
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    if end > limit * 0.5:
        return cut[: end + 1]
    return cut.rsplit(" ", 1)[0] + "…"


def normalize_url(url):
    parts = urlsplit(url.strip())
    query = [(k, v) for k, v in parse_qsl(parts.query) if not k.lower().startswith(("utm_", "mc_", "fbclid", "gclid"))]
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower() or "https", parts.netloc.lower(), path, urlencode(query), ""))


def parse_date(value):
    if not value:
        return None
    value = value.strip()
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _text(el, *tags):
    for tag in tags:
        found = el.find(tag)
        if found is not None and (found.text or "").strip():
            return found.text
    return ""


def parse_feed(data):
    root = ET.fromstring(data)
    items = []
    for it in root.iter("item"):
        items.append({
            "title": _text(it, "title"),
            "url": _text(it, "link", "guid"),
            "summary": _text(it, "description", f"{CONTENT}encoded"),
            "published": _text(it, "pubDate", f"{DC}date"),
        })
    for it in root.iter(f"{RSS1}item"):  # RSS 1.0 / RDF (e.g. Slashdot)
        items.append({
            "title": _text(it, f"{RSS1}title"),
            "url": _text(it, f"{RSS1}link"),
            "summary": _text(it, f"{RSS1}description", f"{CONTENT}encoded"),
            "published": _text(it, f"{DC}date"),
        })
    for it in root.iter(f"{ATOM}entry"):
        link = ""
        for ln in it.findall(f"{ATOM}link"):
            if ln.get("rel", "alternate") == "alternate" and ln.get("href"):
                link = ln.get("href")
                break
        items.append({
            "title": _text(it, f"{ATOM}title"),
            "url": link,
            "summary": _text(it, f"{ATOM}summary", f"{ATOM}content"),
            "published": _text(it, f"{ATOM}published", f"{ATOM}updated"),
        })
    return items


def build_items(items, source):
    """Turn raw {title, url, summary, published} entries into stored story items."""
    out = []
    for raw in items:
        title = clean_text(raw["title"])
        url = (raw["url"] or "").strip()
        if not title or not url.startswith("http"):
            continue
        published = parse_date(raw["published"])
        out.append({
            "id": hashlib.sha1(normalize_url(url).encode()).hexdigest()[:12],
            "title": title,
            "url": url,
            "source": source["name"],
            "source_category": source.get("category", ""),
            "published": published.isoformat() if published else None,
            "summary": shorten(clean_text(raw["summary"])),
            **raw.get("extra", {}),  # e.g. kind/cve/cvss for vulnerability records
        })
    return out


def fetch_source(source, hours):
    """Fetch one source: an RSS/Atom feed (default), a listing page read by a parser in
    page_sources ("page"), or a data API queried for the fetch window ("api")."""
    try:
        if source.get("type") == "api":
            raw = page_sources.API_FETCHERS[source["fetcher"]](source, USER_AGENT, hours)
            return source, build_items(raw, source), None
        if source.get("type") == "page":
            parser = page_sources.PARSERS[source["parser"]]
            if not page_sources.robots_allows(source["url"], USER_AGENT):
                return source, [], "Blocked by the site's robots.txt, not fetched"
            req = Request(source["url"], headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
            with urlopen(req, timeout=30) as resp:
                page = resp.read().decode(resp.headers.get_content_charset() or "utf-8", "replace")
                raw = parser(page, resp.geturl())
            if not raw:
                return source, [], "Page fetched but no items found; the site's layout may have changed"
            return source, build_items(raw, source), None
        req = Request(source["url"], headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5"})
        with urlopen(req, timeout=30) as resp:
            return source, build_items(parse_feed(resp.read()), source), None
    except Exception as exc:  # one bad source must not sink the run
        return source, [], f"{type(exc).__name__}: {str(exc)[:200]}"


def tag_topics(item):
    text = f"{item['title']} {item['summary']}"
    return [name for name, rx in TOPIC_RES.items() if rx.search(text)] or ["General IT"]


def _stem(word):
    for suffix in ("ing", "es", "ed", "s"):
        if len(word) > 4 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def title_tokens(title):
    words = re.findall(r"[a-z0-9]+", title.lower())
    return {_stem(w) for w in words if w not in STOPWORDS and len(w) > 1}


# Headlines for the same story share few words, but the shared ones are rare that day
# ("Gheist", "DreamHost", "Brotli"). Weighting overlap by rarity separates them from
# unrelated stories that only share common words ("AI", "vulnerability"). 0.2 was tuned
# against a real day of feeds: all clear duplicates merged, no false merges.
SAME_STORY_THRESHOLD = 0.2


def same_story(a, b, idf):
    ta, tb = a["_tokens"], b["_tokens"]
    union = sum(idf[w] for w in ta | tb)
    if union and sum(idf[w] for w in ta & tb) / union >= SAME_STORY_THRESHOLD:
        return True
    return SequenceMatcher(None, a["title"].lower(), b["title"].lower()).ratio() >= 0.85


def cluster(items):
    """Group the same story reported by several sources; keep the richest version as primary."""
    doc_freq = {}
    for item in items:
        item["_tokens"] = title_tokens(item["title"])
        for word in item["_tokens"]:
            doc_freq[word] = doc_freq.get(word, 0) + 1
    idf = {w: math.log((len(items) + 1) / n) for w, n in doc_freq.items()}
    groups = []
    for item in items:
        # Raw CVE records (NVD) are listed on their own, never merged into news stories
        if item.get("kind") == "cve":
            groups.append([item])
            continue
        for group in groups:
            # A source reports a story once; two items from one source are different stories
            # (e.g. two CISA KEV entries whose titles share a template)
            if group[0].get("kind") == "cve" or any(other["source"] == item["source"] for other in group):
                continue
            if any(same_story(item, other, idf) for other in group):
                group.append(item)
                break
        else:
            groups.append([item])
    result = []
    for group in groups:
        group.sort(key=lambda x: (-len(x["summary"]), x["published"] or ""))
        primary = dict(group[0])
        seen_sources = {primary["source"]}
        primary["also_covered_by"] = []
        for other in group[1:]:
            if other["source"] in seen_sources:
                continue
            seen_sources.add(other["source"])
            primary["also_covered_by"].append({"id": other["id"], "source": other["source"], "title": other["title"], "url": other["url"]})
        primary.pop("_tokens", None)
        primary["topics"] = tag_topics(primary)
        result.append(primary)
    return result


def add_cve_scores(items):
    """Attach CVSS scores for every CVE a news story mentions (title, summary, other outlets' titles).

    Sets item["cves"] = [{"id", "score", "severity", "version", "scored_by"}], highest first.
    NVD CVE records (kind "cve") already carry their own score and are skipped.
    """
    mentions = {}
    for it in items:
        if it.get("kind") == "cve":
            continue
        ids = cve_scores.find_cves(it["title"], it["summary"], *(c["title"] for c in it.get("also_covered_by", [])))
        if ids:
            mentions[it["id"]] = ids
    all_ids = sorted({c for ids in mentions.values() for c in ids})
    if not all_ids:
        return "no CVEs mentioned"
    scores, looked_up, errors = cve_scores.scores_for(all_ids, ROOT / "data" / "cve_scores.json", USER_AGENT)
    for it in items:
        if it["id"] in mentions:
            found = [{"id": c, **scores[c]} for c in mentions[it["id"]] if scores.get(c)]
            it["cves"] = sorted(found, key=lambda x: -x["score"])
    scored = sum(1 for c in all_ids if scores.get(c))
    note = f"{len(all_ids)} CVEs mentioned, {scored} with a CVSS score ({looked_up} looked up"
    return note + (f", {errors} lookups failed)" if errors else ")")


def add_exploit_signals(items, sources):
    """Attach EPSS and CISA KEV status for every CVE an item mentions, scored by CVSS or not.

    Sets item["exploit"] = {"kev": [{"id", "added", "ransomware"}], "epss": {"id", "score",
    "percentile", "date"}} with the highest-EPSS CVE, or leaves it out when neither applies.
    """
    mentions = {}
    for it in items:
        if it.get("kind") == "cve":
            mentions[it["id"]] = [it["cve"]]
        else:
            ids = cve_scores.find_cves(it["title"], it["summary"], *(c["title"] for c in it.get("also_covered_by", [])))
            if ids:
                mentions[it["id"]] = ids
    all_ids = sorted({c for ids in mentions.values() for c in ids})
    if not all_ids:
        return "no CVEs for EPSS/KEV"
    kev_url = next((s["url"] for s in sources if s.get("parser") == "cisa_kev"), None)
    kev, kev_note = exploit_signals.kev_catalog(kev_url, ROOT / "data" / "kev.json", USER_AGENT) if kev_url else ({}, "no KEV source")
    epss, looked_up, errors = exploit_signals.epss_for(all_ids, ROOT / "data" / "epss.json", USER_AGENT)
    for it in items:
        ids = mentions.get(it["id"])
        if not ids:
            continue
        signal = {}
        listed = [{"id": c, **kev[c]} for c in ids if c in kev]
        if listed:
            signal["kev"] = listed
        scored = [(c, epss[c]) for c in ids if epss.get(c)]
        if scored:
            cve, e = max(scored, key=lambda x: x[1]["score"])
            signal["epss"] = {"id": cve, **e}
        if signal:
            it["exploit"] = signal
        else:
            it.pop("exploit", None)
    with_epss = sum(1 for c in all_ids if epss.get(c))
    in_kev = sum(1 for c in all_ids if c in kev)
    note = f"EPSS for {with_epss}/{len(all_ids)} CVEs ({looked_up} looked up{f', {errors} batches failed' if errors else ''}), {in_kev} in KEV; {kev_note}"
    return note


def local_today():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/New_York")).date()
    except Exception:  # Windows without tzdata
        return datetime.now().astimezone().date()


def merge_day(existing, fresh):
    """Keep every item already on the day (vetting refers to them by id); add new ones."""
    by_id = {it["id"]: it for it in existing}
    # Any article id (primary or merged) -> the existing story it belongs to
    owner = {}
    for it in existing:
        owner[it["id"]] = it
        for c in it.get("also_covered_by", []):
            owner[c.get("id", "")] = it
    for it in fresh:
        members = [it] + it.get("also_covered_by", [])
        old = next((owner[m["id"]] for m in members if m.get("id") in owner), None)
        if old is None:
            by_id[it["id"]] = it
            continue
        # Same story as one already listed: fold in any new sources, keep the existing id
        known = {c["source"] for c in old.get("also_covered_by", [])} | {old["source"]}
        for m in members:
            if m["source"] not in known:
                known.add(m["source"])
                old.setdefault("also_covered_by", []).append({k: m[k] for k in ("id", "source", "title", "url")})
    return sorted(by_id.values(), key=lambda x: x["published"] or "", reverse=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hours", type=int, default=36, help="only keep stories published in the last N hours (default 36)")
    ap.add_argument("--date", help="day file to write, YYYY-MM-DD (default: today, US Eastern)")
    args = ap.parse_args()

    sources = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))
    day = args.date or local_today().isoformat()
    cutoff = datetime.now(timezone.utc) - timedelta(hours=args.hours)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda s: fetch_source(s, args.hours), sources))

    items, status = [], []
    seen_ids = set()
    for source, found, error in results:
        recent = [it for it in found if not it["published"] or datetime.fromisoformat(it["published"]) >= cutoff]
        status.append({"source": source["name"], "fetched": len(found), "recent": len(recent), "error": error})
        for it in recent:
            if it["id"] not in seen_ids:
                seen_ids.add(it["id"])
                items.append(it)

    days_dir = ROOT / "data" / "days"
    days_dir.mkdir(parents=True, exist_ok=True)
    day_path = days_dir / f"{day}.json"

    # The fetch window overlaps the previous day, so drop anything an earlier day already lists
    week_before = (datetime.fromisoformat(day) - timedelta(days=7)).date().isoformat()
    earlier_ids = set()
    for path in days_dir.glob("*.json"):
        if week_before <= path.stem < day:
            for it in json.loads(path.read_text(encoding="utf-8")).get("items", []):
                earlier_ids.add(it["id"])
                earlier_ids.update(c.get("id", "") for c in it.get("also_covered_by", []))
    items = [it for it in items if it["id"] not in earlier_ids]

    # Earlier-published items first, so the first report of a story is clustered against later ones
    items.sort(key=lambda x: x["published"] or "")
    clustered = cluster(items)

    existing = json.loads(day_path.read_text(encoding="utf-8")).get("items", []) if day_path.exists() else []
    merged = merge_day(existing, clustered)
    cve_note = add_cve_scores(merged)
    exploit_note = add_exploit_signals(merged, sources)

    payload = {
        "date": day,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window_hours": args.hours,
        "sources": status,
        "items": merged,
    }
    day_path.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    index = []
    for path in sorted(days_dir.glob("*.json"), reverse=True):
        count = len(json.loads(path.read_text(encoding="utf-8")).get("items", []))
        index.append({"date": path.stem, "count": count})
    (ROOT / "data" / "index.json").write_text(json.dumps({"days": index}, indent=1) + "\n", encoding="utf-8")

    failed = [s for s in status if s["error"]]
    print(f"{day}: {len(merged)} stories ({len(items)} recent articles from {len(sources) - len(failed)}/{len(sources)} sources); {cve_note}; {exploit_note}")
    for s in failed:
        print(f"  FAILED {s['source']}: {s['error']}", file=sys.stderr)
    # Fail the run only if every source failed
    return 1 if len(failed) == len(sources) else 0


if __name__ == "__main__":
    sys.exit(main())
