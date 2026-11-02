"""Add a source to sources.json from an "Add source" GitHub issue (the Add button on the Sources tab).

The issue body carries one ```json block: {"name", "site", "url", "category"}. The feed is test-fetched
with the fetcher's own code and added only if it returns at least one usable story. Nothing from the
issue reaches a shell: the workflow passes the event file path and this script reads it.

Usage: python -I scripts/add_source.py <event.json> <message-out.md>
Exit 0 = added, 2 = rejected (message explains why), anything else = error.
"""
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import fetch_news  # noqa: E402

SOURCES = ROOT / "sources.json"
FIELDS = ("name", "site", "url", "category")
BLOCK = re.compile(r"```json\s*(\{.*?\})\s*```", re.S)


def reject(out, msg):
    out.write_text(f"Not added: {msg}\n\nEdit the issue to fix it; the workflow runs again on every edit.\n",
                   encoding="utf-8")
    print("REJECTED:", msg)
    sys.exit(2)


def is_http(u):
    p = urlsplit(u or "")
    return p.scheme in ("http", "https") and bool(p.netloc)


def main(event_path, out_path):
    out = Path(out_path)
    issue = json.loads(Path(event_path).read_text(encoding="utf-8"))["issue"]
    m = BLOCK.search(issue.get("body") or "")
    if not m:
        reject(out, "no ```json block with the source in the issue body.")
    try:
        src = json.loads(m.group(1))
    except ValueError as exc:
        reject(out, f"the JSON block doesn't parse ({exc}).")
    if not isinstance(src, dict):
        reject(out, "the JSON block must be an object.")
    extra = sorted(set(src) - set(FIELDS))
    if extra:
        reject(out, f"unexpected keys {extra}; only {list(FIELDS)} are accepted here.")
    src = {k: str(src.get(k) or "").strip() for k in FIELDS}
    if not src["name"] or len(src["name"]) > 80:
        reject(out, "`name` is required (80 characters at most).")
    if not is_http(src["url"]):
        reject(out, "`url` must be the feed's http(s) address. The suggestion had no working feed, so find "
                    "the site's RSS/Atom feed and put it in `url`.")
    if not src["site"]:
        p = urlsplit(src["url"])
        src["site"] = f"{p.scheme}://{p.netloc}/"
    if not is_http(src["site"]):
        reject(out, "`site` must be an http(s) address.")
    if not src["category"] or len(src["category"]) > 40:
        reject(out, "`category` is required (40 characters at most).")

    sources = json.loads(SOURCES.read_text(encoding="utf-8"))
    for s in sources:
        if s["name"].lower() == src["name"].lower():
            reject(out, f"a source named \"{s['name']}\" already exists.")
        if s["url"] == src["url"]:
            reject(out, f"that feed is already in sources.json as \"{s['name']}\".")

    try:
        items = fetch_news.build_items(fetch_news.fetch_feed(src["url"]), src)
    except Exception as exc:  # report any fetch/parse failure to the issue
        reject(out, f"the feed couldn't be fetched or parsed: {type(exc).__name__}: {str(exc)[:200]}")
    if not items:
        reject(out, "the feed parsed but had no stories with a title and link.")

    sources.append(src)
    lines = ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in sources)
    SOURCES.write_text("[\n" + lines + "\n]\n", encoding="utf-8")
    newest = max((i["published"] for i in items if i.get("published")), default=None)
    out.write_text(
        f"Added **{src['name']}** ({src['category']}) to sources.json: {len(items)} stories in the feed"
        + (f", newest {newest[:10]}" if newest else "")
        + f". It is fetched from the next run on; {len(sources)} sources in total.\n",
        encoding="utf-8")
    print("ADDED:", src["name"], len(items), "items")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
