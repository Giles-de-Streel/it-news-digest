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
import html.entities
import json
import math
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

# python -I (used in the workflow) leaves the script's folder off sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import page_sources  # noqa: E402
import cve_scores  # noqa: E402
import exploit_signals  # noqa: E402
import source_discovery  # noqa: E402

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
    "Microsoft & Windows": r"microsoft|(?<!maintenance )(?<!patch )(?<!time )(?<!change )\bwindows\b(?! of\b)|azure|\bentra\b|intune|exchange (online|servers?|se|admin|mailbox(es)?|mail|e-?mail|hybrid|web services|20(13|16|19))\b|on-prem(ises)? exchange|sharepoint|office 365|microsoft 365|\bdefender\b(?! of\b)|\bteams (meetings?|chats?|channels?|app|client|rooms?|phone|premium|webhooks?|admins?|administrators?|calls?|outages?)\b|sql server",
    "Linux & open source": r"linux|red hat|rhel|ubuntu|debian|open source|kernel|ansible|openssl",
    "Cloud & infrastructure": r"\baws\b|amazon web services|google cloud|\bgcp\b|cloud|kubernetes|vmware|broadcom|data center|datacenter|virtuali",
    "AI": r"\bai\b|artificial intelligence|llm|chatgpt|openai|copilot|gemini|claude|machine learning|genai",
    "Hardware": r"\bcpus?\b|\bgpus?\b|(?<!pre)(?<!payment )(?<!data )processor|semiconductor|\bchips?\b|chipmaker|nvidia|\bamd\b|\bintel\b|ryzen|epyc|xeon|\barm\b|qualcomm|tsmc|\bssds?\b|nvme|\bhdds?\b|hard drive|\bdram\b|\bddr\d|\bhbm\d?\b|flash storage|storage array|firmware|\bbios\b|uefi|motherboard|laptop|workstation|\brack\b|data cent(er|re)|datacenter|liquid cooling|power supply",
    "Development": r"programming|developer|\bcoding\b|source code|\bgit(hub|lab)?\b|python|powershell|javascript|typescript|\brust\b|golang|\bjava\b|\.net\b|c\+\+|compiler|\bsdks?\b|\bides?\b|vs code|visual studio|\bnpm\b|pypi|crates\.io|ci/cd|devops|refactor|open-source (library|project)",
    "Databases": r"database|\bsql\b|sql server|\bmssql\b|t-sql|postgres|mysql|mariadb|oracle (database|db|rac)|\brac\b|\brman\b|data ?guard|mongodb|redis|sqlite|\bdbas?\b|always ?on availability",
    "Reverse engineering": r"reverse[- ]engineer|reversing|decompil|disassembl|\bida pro\b|\bida \d|ghidra|binary ninja|radare|\bfuzz|malware analysis|unpack(ing|er)\b|deobfuscat|firmware analysis",
    "Forensics & IR": r"forensic|\bdfir\b|incident response|memory (dump|image|analysis)|disk image|timeline analysis|volatility\b|\bkape\b|velociraptor|data recovery|file recovery|deleted (files?|data)|chain of custody",
    "Pen testing & red team": r"pen(etration)?[- ]?test|red team|offensive security|\bc2\b|command[- ]and[- ]control|bug bounty|proof[- ]of[- ]concept|\bpoc\b|privilege escalation|lateral movement|kerberoast|ntlm relay|bloodhound|burp suite|exploit (chain|development)",
    "ICS / OT": r"\bics\b|\bscada\b|\bplcs?\b|\bhmis?\b|industrial control|operational technology|\bot (security|network|environment|asset)|\bot/ics\b|\bics/ot\b|industrial (cyber|automation|iot)|\biiot\b|modbus|\bdnp3\b|profinet|\bopc[- ]ua\b|rockwell|schneider electric|siemens|honeywell|\babb\b|mitsubishi electric|yokogawa|emerson|critical infrastructure|water utilit|power grid|substation",
    "Embedded & IoT": r"embedded|microcontroller|\bmcus?\b|\bfpgas?\b|\brtos\b|zephyr|freertos|\biot\b|internet of things|single[- ]board|raspberry pi|arduino|esp32|\briscv\b|risc-v|\bsoc\b|system[- ]on[- ](a[- ])?chip|firmware|\bbootloader|yocto|embedded linux",
    "Higher education": r"higher ed|universit|college|campus|\bedtech\b|educause|student data|\bferpa\b|\blms\b|canvas lms|blackboard|faculty",
    "Endpoint management": r"\bintune\b|configuration manager|\bsccm\b|\bmecm\b|autopilot|\bjamf\b|\bmdm\b|endpoint management|device management|patch management|windows update|release health",
    "Backup & recovery": r"backup|disaster recovery|\bdr\b plan|restore|recovery point|immutable (storage|backup)|veeam|commvault|rubrik|cohesity|business continuity",
    "Supply chain security": r"supply[- ]chain|\bsbom\b|\bnpm\b|\bpypi\b|malicious package|typosquat|dependency|openssf|sigstore|\bslsa\b",
    "Accessibility": r"accessibility(?! (services?|permissions?)\b)|\ba11y\b|\bwcag\b|screen ?readers?|assistive tech|\bada\b (title|compliance|lawsuits?|websites?|accessib)|title ii (of the ada|rule|deadline|compliance)|section 508|\bvpats?\b|european accessibility act|\ben 301 549\b|closed caption|live caption|captioning|\balt text\b|sign language|\baria[- ](labels?|attributes?|roles?|live)\b|inclusive design|disabilit(y|ies)|\bdeaf (users?|people|community|and hard)|hard of hearing|low vision|colou?r ?blind|dyslexi|braille|voiceover (screen reader|users?)|keyboard (navigation|accessib|only users?)",
    "System administration": r"sysadmin|system administrat|\badmins?\b|administrators?\b|group policy|\bgpos?\b|active directory|\bad ds\b|domain controller|\bkerberos\b|\bntlm\b|exchange (online|server)|powershell|\bwsus\b|windows server|server 20\d\d|patch tuesday|cumulative update|\brhel\b|\bsystemd\b|\bselinux\b|\bdnf\b|apt-get|\bapt (install|update|upgrade)\b|package manager|kernel \d|\bcron\b|\bbash\b|\bssh\b|sysinternals|admin center|microsoft 365 roadmap|message center|deprecat|end of (life|support)|\beol\b",
    "DevOps & SRE": r"devops|\bsre\b|site reliability|\bci/cd\b|continuous (integration|delivery|deployment)|gitops|infrastructure as code|\biac\b|terraform|opentofu|pulumi|ansible|kubernetes|\bk8s\b|\bhelm\b|docker|containeri[sz]|container (image|runtime|registr|security|orchestration|platform)|observability|opentelemetry|prometheus|grafana|platform engineering|postmortem|incident management|argo ?cd|jenkins|github actions|gitlab|service mesh|istio",
    "TLS & PKI": r"\btls\b|\bmtls\b|\bssl\b(?![- ]?vpn)|\bhsts\b|\bpki\b|x\.509|certificate authorit|ca/b forum|cab forum|root (store|program|certificates?|cas?)\b|certificate (transparency|lifetimes?|lifespans?|validity|revocation|pinning|management|automation|expir\w*|chain)|(tls|ssl|https|code[- ]signing|s/mime|server|web|wildcard|digital|x\.509) certificates?|\bacme (protocol|client|challenge|account)|let'?s encrypt|letsencrypt|\bocsp\b|\bcrls?\b|post-quantum|quantum[- ](safe|resistant)|\bpqc\b|ml-kem|ml-dsa|kyber|dilithium|cryptograph|openssl|boringssl|libressl|wolfssl|gnutls|mbed ?tls|\bciphers?\b|cipher suite|key exchange|\bhsms?\b|digicert|sectigo|globalsign|dnssec|end-to-end encrypt",
    "Game development": r"game ?dev|\bgames? (developers?|development|engines?|studios?|design(ers?)?|industry|publish(ers?|ing)|jams?|consoles?|pass|awards|programming|art|audio|tech|preservation|ratings?|modding)\b|video ?games?|\b(pc|console|mobile|cloud|indie|aaa) games?\b|\bgaming\b(?! (the|laptops?|pcs?|monitors?|mouse|mice|keyboards?|headsets?|chairs?|cpus?|desktops?|routers?|phones?|deals?)\b)|\bgamers?\b|unreal engine|\bue[56]\b|\bunity (engine|technologies|editor|6)\b|\bgodot\b|\bbevy (engine|\d)|\bdefold\b|\bo3de\b|steamworks|\bsteam (deck|machine|store|next fest|achievements?|controller|frame|client)\b|\bsteamos\b|playstation|\bps[45]\b|\bxbox\b|nintendo|switch 2|\besports?\b|\bvulkan\b|directx|\bdx12\b|\bfsr ?\d|\bdlss\b|ray[- ]trac|path[- ]trac|graphics programming|\bgdc\b|\bgpuopen\b",
    "Cloud status": r"\b(cloud|service|services|platform|global|worldwide|widespread|major|massive|internet|network|email|dns|cdn|login|sign-in|microsoft|microsoft 365|m365|office 365|azure|aws|google|gmail|cloudflare|akamai|fastly|github|zoom|slack|teams|outlook|exchange( online)?|canvas|okta|crowdstrike|oracle cloud|oci) outages?\b|\boutages? (hits|hit|takes down|took down|knocks|disrupts|disrupted|affects|affected|impacts|hits users)\b|service (disruption|degradation|incident)s?|degraded performance|elevated error rates?|status page|post-incident (report|review)|\brca\b for|\bdown for (users|thousands|millions|many)\b",
    "ITSM": r"\bitsm\b|\bitil\b|it service management|enterprise service management|service management|service ?desk|help ?desk|servicenow|jira service management|\bjsm\b|topdesk|freshservice|invgate|remedyforce|bmc helix|change (management|enablement|advisory board)|problem management|incident management|service catalog(ue)?|\bcmdb\b|configuration management database|it asset management|\bitam\b|service level (agreement|objective|management)|\bslas\b|peoplecert|axelos",
    "Agile & delivery": r"\bagile\b(?! robots?\b)|\bscrum\b|kanban|scrum@scale|product owners?|scrum masters?|sprint (planning|reviews?|goals?|retrospectives?|backlog)|team retrospectives?|product backlog|backlog refinement|user stor(y|ies)|story points|scaled agile|\bsafe (framework|agile)\b|\blean (thinking|management|manufacturing|startup|enterprise|principles|six sigma|portfolio|transformation|coffee)\b|toyota production system|value stream|\bwip limits?\b|flow metrics|dora metrics|project management|program management|product management|\bpmo\b|\bpmp\b|\bokrs?\b|extreme programming|pair programming|mob programming|socio-technical|team topologies",
    "Networking": r"(?<!neural )(?<!social )(?<!fork-)\bnetwork(?! of\b)|router|firewall|vpn|cisco|fortinet|palo alto|juniper|wi-?fi|\bdns\b|sd-wan|load[ -]?balanc|\bADCs?\b|big-ip|netscaler|haproxy|ingress controller",
    "Identity & access": r"identity|authenticat|passkey|\bmfa\b|password|sso\b|saml|oauth|credential",
    "Policy & regulation": r"regulat|\blaw\b|legislat|\bfcc\b|\bftc\b|\bsec\b filing|gdpr|cisa\b|government|congress|lawsuit|\bfined\b|\bfines\b|\b(a|record|eu|gdpr|million|billion|antitrust) fine\b",
}
TOPIC_RES = {name: re.compile(rx, re.I) for name, rx in TOPICS.items()}
# Stories from sources in these categories always get the topic, even when no keyword matches
# (e.g. a games-industry outlet's studio news that never says "game development").
CATEGORY_TOPICS = {"Game development": "Game development", "Accessibility": "Accessibility", "Cloud status": "Cloud status",
                   "ITSM": "ITSM", "Agile & delivery": "Agile & delivery"}
# Status-page posts for planned work (sources with "skip_maintenance": true). Statuspage.io feeds
# mark them "THIS IS A SCHEDULED EVENT" and start the update log with "Scheduled - "; real
# incidents start with "Investigating - "/"Identified - " instead.
# The bare word "maintenance" is only checked in titles: an incident's text may mention it.
MAINTENANCE_TITLE_RE = re.compile(r"\bmaintenance\b|\bplanned (work|upgrade)\b", re.I)
MAINTENANCE_TEXT_RE = re.compile(r"this is a scheduled event|^[^.]{0,40}\bscheduled\s*-\s|scheduled maintenance", re.I)
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


_XML_ENTITIES = {b"amp", b"lt", b"gt", b"quot", b"apos"}
_ENTITY_RE = re.compile(rb"&([A-Za-z][A-Za-z0-9]{0,31});")
_BARE_AMP_RE = re.compile(rb"&(?!#[0-9]{1,7};|#[xX][0-9A-Fa-f]{1,6};|[A-Za-z][A-Za-z0-9]{0,31};)")


def _fix_entities(data):
    """Make HTML-isms in a feed legal XML: named HTML entities (&nbsp;, &rsquo;, ...) become numeric
    references, unknown names and bare '&' (e.g. 'AT&T') become '&amp;'. Only used after a strict
    parse has failed, so well-formed feeds are never touched."""
    def named(m):
        name = m.group(1)
        if name in _XML_ENTITIES:
            return m.group(0)
        cp = html.entities.name2codepoint.get(name.decode("ascii"))
        return b"&#%d;" % cp if cp else b"&amp;" + name + b";"
    return _ENTITY_RE.sub(named, _BARE_AMP_RE.sub(b"&amp;", data))


def _trim_trailing(data):
    """Some CDNs append a <script> after the closing </rss> or </feed> tag: cut anything after the
    last closing root tag. None when there is nothing to cut."""
    end = max(data.rfind(b"</rss>") + 6 if b"</rss>" in data else -1,
              data.rfind(b"</feed>") + 7 if b"</feed>" in data else -1,
              data.rfind(b"</rdf:RDF>") + 10 if b"</rdf:RDF>" in data else -1)
    if end <= 0 or not data[end:].strip():
        return None
    return data[:end]


_XML_ILLEGAL_RE = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _strip_controls(data):
    """Drop control characters XML 1.0 forbids (e.g. vertical tabs pasted into a post body)."""
    return _XML_ILLEGAL_RE.sub(b"", data)


def _lstrip_prolog(data):
    """Whitespace or a BOM before <?xml ...?> is a fatal error ("XML declaration not at start")."""
    return data.lstrip(b"\xef\xbb\xbf \t\r\n")


_KNOWN_NS = {b"atom": b"http://www.w3.org/2005/Atom", b"dc": b"http://purl.org/dc/elements/1.1/",
             b"content": b"http://purl.org/rss/1.0/modules/content/", b"media": b"http://search.yahoo.com/mrss/"}
_PREFIX_USE_RE = re.compile(rb"</?([A-Za-z_][\w.-]*):[A-Za-z_]")
_ROOT_TAG_RE = re.compile(rb"<(rss|feed|rdf:RDF)\b")


def _declare_prefixes(data):
    """Some feeds use a namespace prefix they never declare (ManageEngine: <atom:link> with no
    xmlns:atom), which is fatal ("unbound prefix"). Declare each missing prefix on the root element.
    None when nothing is missing."""
    root = _ROOT_TAG_RE.search(data)
    if not root:
        return None
    used = {p for p in _PREFIX_USE_RE.findall(data) if p not in (b"xml", b"xmlns")}
    missing = sorted(p for p in used if not re.search(rb"xmlns:" + re.escape(p) + rb"\s*=", data))
    if not missing:
        return None
    decl = b"".join(b' xmlns:%s="%s"' % (p, _KNOWN_NS.get(p, b"urn:undeclared:" + p)) for p in missing)
    return data[:root.end()] + decl + data[root.end():]


_REPAIRS = (_lstrip_prolog, _trim_trailing, _fix_entities, _strip_controls, _declare_prefixes)


def parse_feed(data):
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        # Repair the usual breakages one at a time, then all together; if none parses, raise the
        # original error. Repairs run only after a strict parse has failed.
        def apply(fix, d):
            out = fix(d)
            return d if out is None else out
        combined = data
        for fix in _REPAIRS:
            combined = apply(fix, combined)
        root = None
        for attempt in [apply(fix, data) for fix in _REPAIRS] + [combined]:
            if attempt == data:
                continue
            try:
                root = ET.fromstring(attempt)
                break
            except ET.ParseError:
                pass
        if root is None:
            raise
    items = []
    for it in root.iter("item"):
        items.append({
            "title": _text(it, "title"),
            "url": _text(it, "link", "guid"),
            "guid": _text(it, "guid"),
            "summary": _text(it, "description", f"{CONTENT}encoded"),
            "published": _text(it, "pubDate", f"{DC}date"),
            "categories": [(c.text or "").strip() for c in it.findall("category")],
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
        if not link:
            # No alternate link (e.g. php.net lists only download enclosures): an http(s) <id>
            # is the entry's permalink.
            entry_id = (_text(it, f"{ATOM}id") or "").strip()
            if entry_id.startswith(("http://", "https://")):
                link = entry_id
        items.append({
            "title": _text(it, f"{ATOM}title"),
            "url": link,
            "guid": _text(it, f"{ATOM}id"),
            "summary": _text(it, f"{ATOM}summary", f"{ATOM}content"),
            "published": _text(it, f"{ATOM}published", f"{ATOM}updated"),
            "categories": [(c.get("term") or "").strip() for c in it.findall(f"{ATOM}category")],
        })
    return items


def build_items(items, source):
    """Turn raw {title, url, summary, published} entries into stored story items."""
    out = []
    fetched_at = datetime.now(timezone.utc).replace(microsecond=0)
    # Optional per-source title filter, e.g. only Important/Critical Red Hat advisories
    include = re.compile(source["title_include"]) if source.get("title_include") else None
    # Optional per-source feed-category filter, e.g. only Semafor's Technology/Security items:
    # a regex at least one of the item's <category> values must fully match
    cat_include = re.compile(source["category_include"]) if source.get("category_include") else None
    # Optional per-source regex removed from titles, e.g. the " - Outlet" suffix Google News appends
    strip = re.compile(source["title_strip"]) if source.get("title_strip") else None
    # Some status feeds give every entry the same link (AWS: the dashboard home page; Oracle Cloud:
    # links that differ only after "#"). Those entries are told apart by their guid instead.
    url_counts = {}
    for raw in items:
        key = normalize_url(raw["url"]) if (raw["url"] or "").startswith("http") else ""
        url_counts[key] = url_counts.get(key, 0) + 1
    for raw in items:
        title = clean_text(raw["title"])
        if strip:
            title = strip.sub("", title).strip()
        url = (raw["url"] or "").strip()
        if not title or not url.startswith("http"):
            continue
        if include and not include.search(title):
            continue
        if cat_include and not any(cat_include.fullmatch(c) for c in raw.get("categories") or []):
            continue
        if source.get("skip_maintenance") and (MAINTENANCE_TITLE_RE.search(title) or MAINTENANCE_TEXT_RE.search(clean_text(raw["summary"])[:300])):
            continue
        id_key = normalize_url(url)
        if url_counts.get(id_key, 0) > 1 and (raw.get("guid") or "").strip():
            id_key = raw["guid"].strip()
        published = parse_date(raw["published"])
        if published and published > fetched_at:
            published = fetched_at  # some feeds post-date entries (VS Code release notes); use when we saw it
        out.append({
            "id": hashlib.sha1(id_key.encode()).hexdigest()[:12],
            "title": title,
            "url": url,
            "source": source["name"],
            "source_category": source.get("category", ""),
            "published": published.isoformat() if published else None,
            "summary": shorten(clean_text(raw["summary"])),
            **raw.get("extra", {}),  # e.g. kind/cve/cvss for vulnerability records
        })
        if source.get("discover") == "summary_link":
            # Aggregators like Techmeme link their own permalink; the article is the first outside link.
            # source_discovery reads this and removes it before anything is written.
            out[-1]["_outlink"] = source_discovery.first_outside_link(raw["summary"], url)
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
        return source, build_items(fetch_feed(source["url"]), source), None
    except Exception as exc:  # one bad source must not sink the run
        return source, [], f"{type(exc).__name__}: {str(exc)[:200]}"


class NotAFeed(Exception):
    """The server answered 200 with a web page (error page, bot check) instead of a feed."""


RETRY_PAUSE_SECONDS = 15


def fetch_feed(url, attempts=2):
    """Download and parse one RSS/Atom feed, retrying once after a short pause on failures
    that are usually temporary: timeouts, 429/5xx, or an HTML page where the feed should be."""
    for attempt in range(1, attempts + 1):
        try:
            req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5"})
            with urlopen(req, timeout=30) as resp:
                data = resp.read()
            try:
                return parse_feed(data)
            except ET.ParseError as exc:
                head = data[:600].lstrip().lower()
                if head.startswith((b"<!doctype html", b"<html")) or b"<html" in head:
                    title = re.search(rb"<title[^>]*>(.*?)</title>", data[:5000], re.I | re.S)
                    hint = f' (page title "{clean_text(title.group(1).decode("utf-8", "replace"))[:80]}")' if title else ""
                    raise NotAFeed(f"Got a web page instead of the feed{hint}; likely a temporary error or bot-check page") from exc
                raise
        except (NotAFeed, TimeoutError, URLError) as exc:
            transient = not isinstance(exc, HTTPError) or exc.code == 429 or exc.code >= 500
            if attempt == attempts or not transient:
                raise
            time.sleep(RETRY_PAUSE_SECONDS)


def tag_topics(item, categories=()):
    text = f"{item['title']} {item['summary']}"
    forced = {CATEGORY_TOPICS[c] for c in categories if c in CATEGORY_TOPICS}
    return [name for name, rx in TOPIC_RES.items() if name in forced or rx.search(text)] or ["General IT"]


def _stem(word):
    for suffix in ("ing", "es", "ed", "s"):
        if len(word) > 4 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


# Words that say nothing about which story a headline is: weekdays, "what we know so far",
# "live", "reportedly" and other filler. Without this, "What we know so far about Nvidia's interim
# CEO" and "What we know so far about the Microsoft outage" counted as one story.
HEADLINE_FILLER = set((
    "monday tuesday wednesday thursday friday saturday sunday today tonight yesterday tomorrow "
    "know far everything need explained explainer here heres live latest breaking says said report reports "
    "reportedly according amid so about just now more than all not no has have had before could would might "
    "should one two their they you your we our will can get gets got make makes still also back off down "
    "first last next big must").split())
MONTHS = set("january february march april may june july august september october november december".split())


def title_tokens(title):
    """Distinctive words of a headline, stemmed. Day numbers and years are dropped too, so dated
    posts ("APOD: 2026 November 13", "Doomsday: Friday, 13 November") don't match each other."""
    out = set()
    for w in re.findall(r"[a-z0-9]+", title.lower()):
        if w in STOPWORDS or w in HEADLINE_FILLER or len(w) <= 1:
            continue
        if w.isdigit() and (len(w) <= 2 or re.fullmatch(r"(19|20)\d\d", w)):
            continue
        out.add(_stem(w))
    return out


# Headlines for the same story share few words, but the shared ones are rare that day
# ("Gheist", "DreamHost", "Brotli"). Weighting overlap by rarity separates them from
# unrelated stories that only share common words ("AI", "vulnerability"). 0.2 was tuned
# against a real day of feeds: all clear duplicates merged, no false merges.
SAME_STORY_THRESHOLD = 0.2


def same_story(a, b, idf):
    ta, tb = a["_tokens"], b["_tokens"]
    shared = ta & tb
    # A month name alone ("November") is not a shared subject
    if not shared - MONTHS:
        return False
    union = sum(idf[w] for w in ta | tb)
    overlap = sum(idf[w] for w in shared) / union if union else 0
    if overlap >= SAME_STORY_THRESHOLD:
        return True
    # Near-identical wording also counts, but only with some real word overlap: templated
    # headlines ("What we know so far about ...") look alike letter by letter
    return overlap >= 0.1 and SequenceMatcher(None, a["title"].lower(), b["title"].lower()).ratio() >= 0.85


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
            # Status pages reuse stock wording ("Elevated error rates", "Degraded performance"), so two
            # providers' status posts are never one story; a status post can still join a news story.
            if item.get("source_category") == "Cloud status" and any(other.get("source_category") == "Cloud status" for other in group):
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
        primary["topics"] = tag_topics(primary, {x.get("source_category", "") for x in group})
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


def _article_keys(m):
    """An article is the same article if its id or its normalized URL matches (feeds sometimes
    vary tracking parameters or ids between fetches)."""
    keys = {m.get("id") or ""}
    if (m.get("url") or "").startswith("http"):
        keys.add(normalize_url(m["url"]))
    return keys - {""}


def _member(m):
    return {k: m[k] for k in ("id", "source", "title", "url")}


def merge_day(existing, fresh):
    """Keep every item already on the day; add new ones. Each article belongs to one story only."""
    by_id = {it["id"]: it for it in existing}
    # Any article key (primary or merged) -> the story it belongs to
    owner = {}

    def claim(story, m):
        for k in _article_keys(m):
            owner.setdefault(k, story)

    for it in existing:
        for m in [it] + it.get("also_covered_by", []):
            claim(it, m)
    for it in fresh:
        members = [it] + it.get("also_covered_by", [])
        owners = [owner[k] for m in members for k in _article_keys(m) if k in owner]
        if not owners:
            by_id[it["id"]] = it
            for m in members:
                claim(it, m)
            continue
        # Same story as one already listed (the one holding most of these articles): fold in new
        # sources, keep the existing id. Articles another story already holds stay where they are.
        old = max(set(map(id, owners)), key=lambda i: sum(1 for o in owners if id(o) == i))
        old = next(o for o in owners if id(o) == old)
        known = {c["source"] for c in old.get("also_covered_by", [])} | {old["source"]}
        for m in members:
            if m["source"] in known or any(k in owner for k in _article_keys(m)):
                continue
            known.add(m["source"])
            old.setdefault("also_covered_by", []).append(_member(m))
            claim(old, m)
    return sorted(by_id.values(), key=lambda x: x["published"] or "", reverse=True)


def dedupe_articles(items):
    """Make sure no article appears in two stories (left over from older runs, or two stories
    that grew into each other). The story with more sources keeps the article. If the smaller
    story's lead article belongs to the bigger one, it's the same story: its other articles
    move over (one per source) and it's dropped. Returns the number of stories changed or dropped."""
    size = lambda s: 1 + len(s.get("also_covered_by", []))
    order = sorted(items, key=lambda s: (s.get("kind") == "cve", -size(s), s["published"] or ""))
    owner, keep, changed = {}, [], 0
    for s in order:
        if s.get("kind") == "cve":
            keep.append(s)
            continue
        lead_owner = next((owner[k] for k in _article_keys(s) if k in owner), None)
        if lead_owner is not None:
            known = {lead_owner["source"]} | {c["source"] for c in lead_owner.get("also_covered_by", [])}
            for m in s.get("also_covered_by", []):
                if m["source"] not in known and not any(k in owner for k in _article_keys(m)):
                    known.add(m["source"])
                    lead_owner.setdefault("also_covered_by", []).append(_member(m))
                    for k in _article_keys(m):
                        owner[k] = lead_owner
            changed += 1
            continue
        before = len(s.get("also_covered_by", []))
        s["also_covered_by"] = [m for m in s.get("also_covered_by", []) if not any(k in owner for k in _article_keys(m))]
        changed += before != len(s["also_covered_by"])
        for m in [s] + s["also_covered_by"]:
            for k in _article_keys(m):
                owner.setdefault(k, s)
        keep.append(s)
    keep.sort(key=lambda x: x["published"] or "", reverse=True)
    return keep, changed


def retag(items, sources):
    """Re-run topic tagging on every story of the day, so stories saved by earlier runs follow the
    current TOPICS/CATEGORY_TOPICS rules and pick up categories of sources merged in later.
    Returns the number of stories whose topics changed."""
    cat_of = {s["name"]: s.get("category", "") for s in sources}
    changed = 0
    for it in items:
        cats = {it.get("source_category") or cat_of.get(it["source"], "")}
        cats |= {cat_of.get(c.get("source", ""), "") for c in it.get("also_covered_by", [])}
        topics = tag_topics(it, cats)
        if topics != it.get("topics"):
            it["topics"] = topics
            changed += 1
    return changed


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

    try:
        discovery_note = source_discovery.update(ROOT / "data" / "source_candidates.json", sources, results,
                                                 USER_AGENT, page_sources.robots_allows, parse_feed)
    except Exception as exc:  # suggestions are a side feature; never fail the fetch over them
        discovery_note = f"source suggestions failed: {type(exc).__name__}: {exc}"
        for _source, found, _error in results:
            for it in found:
                it.pop("_outlink", None)

    items, status = [], []
    seen_ids = set()
    for source, found, error in results:
        # Undated items count as new only from sources that never give dates (e.g. the MSRC page parser);
        # a feed that dates its new posts but not its old ones (Objective-See) would otherwise flood the day
        dated = any(it["published"] for it in found)
        recent = [it for it in found
                  if (datetime.fromisoformat(it["published"]) >= cutoff if it["published"] else not dated)]
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
    merged, _ = dedupe_articles(merged)
    retag(merged, sources)
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
    print(f"{day}: {len(merged)} stories ({len(items)} recent articles from {len(sources) - len(failed)}/{len(sources)} sources); {cve_note}; {exploit_note}; {discovery_note}")
    for s in failed:
        print(f"  FAILED {s['source']}: {s['error']}", file=sys.stderr)
    # Fail the run only if every source failed
    return 1 if len(failed) == len(sources) else 0


if __name__ == "__main__":
    sys.exit(main())
