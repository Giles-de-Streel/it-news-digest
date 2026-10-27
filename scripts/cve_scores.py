"""CVSS scores for CVE IDs mentioned in stories, from the CVE Program's record API (run by MITRE).

Each CVE record carries scores from the CNA that published it and from ADP enrichers such as
CISA. The highest base score across them is used. Results are cached in data/cve_scores.json so
each CVE is looked up once; CVEs that had no score yet are retried after a week, since scores
are often added after publication.
"""
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from urllib.error import HTTPError
from urllib.request import Request, urlopen

API = "https://cveawg.mitre.org/api/cve/{}"
CVE_RE = re.compile(r"\bCVE-\d{4}-\d{4,7}\b", re.I)
RETRY_UNSCORED_DAYS = 7
VERSIONS = {"cvssV4_0": "4.0", "cvssV3_1": "3.1", "cvssV3_0": "3.0", "cvssV2_0": "2.0"}


def find_cves(*texts):
    return sorted({m.upper() for t in texts if t for m in CVE_RE.findall(t)})


def _lookup(cve_id, user_agent):
    """Best CVSS for one CVE, or None if the record has no score (or doesn't exist)."""
    try:
        with urlopen(Request(API.format(cve_id), headers={"User-Agent": user_agent}), timeout=30) as resp:
            record = json.load(resp)
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    containers = record.get("containers", {})
    best = None
    for container in [containers.get("cna", {})] + containers.get("adp", []):
        scorer = container.get("providerMetadata", {}).get("shortName", "")
        for metric in container.get("metrics", []):
            for key, version in VERSIONS.items():
                data = metric.get(key)
                if not data or data.get("baseScore") is None:
                    continue
                score = float(data["baseScore"])
                if best is None or score > best["score"]:
                    best = {"score": score, "severity": (data.get("baseSeverity") or "").title(),
                            "version": version, "scored_by": scorer}
    return best


def scores_for(cve_ids, cache_path, user_agent):
    """Return {cve_id: score dict or None}, using and updating the cache file."""
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        cache = {}
    today = date.today()
    retry_before = (today - timedelta(days=RETRY_UNSCORED_DAYS)).isoformat()

    def stale(cve):
        entry = cache.get(cve)
        return entry is None or (entry.get("cvss") is None and entry.get("checked", "") < retry_before)

    todo = [c for c in cve_ids if stale(c)]
    errors = 0

    def fetch(cve):
        try:
            return cve, _lookup(cve, user_agent), None
        except Exception as exc:  # leave it uncached; the next run tries again
            return cve, None, exc

    with ThreadPoolExecutor(max_workers=6) as pool:
        for cve, cvss, err in pool.map(fetch, todo):
            if err:
                errors += 1
                continue
            cache[cve] = {"cvss": cvss, "checked": today.isoformat()}

    if todo:
        cache_path.write_text(json.dumps(dict(sorted(cache.items())), indent=1) + "\n", encoding="utf-8")
    return {c: cache.get(c, {}).get("cvss") for c in cve_ids}, len(todo), errors
