# IT News Digest

A daily list of IT and security news pulled from 19 feeds, with duplicate stories merged across sources. You review each story, approve or reject it, and the approved ones make up the day's digest, ready to copy as Markdown or plain text.

## How it works

1. `scripts/fetch_news.py` reads every feed in `sources.json`, keeps stories from the last 36 hours that no earlier day already lists, merges the same story reported by several outlets, tags topics with keyword rules, and writes `data/days/YYYY-MM-DD.json` plus `data/index.json`. It uses only the Python standard library.
2. The **Fetch news** GitHub Actions workflow runs that script and commits the result. It's manual for now (Actions tab, Run workflow). The daily schedule is in the workflow file, commented out.
3. The page (`index.html`, `app.js`, `style.css`, served by GitHub Pages) shows the candidates. Approve or reject a story with the buttons or the keys `a` / `r` (`j` / `k` to move, `u` to undo, `o` to open). Decisions stay in your browser until you press **Save to GitHub**, which commits `data/vetting.json`.
4. The **Digest** tab lists that day's approved stories by topic. **Sources** shows what each feed returned and any fetch errors.

Summaries come from each source's own feed text, shortened. No AI service is involved.

## Saving decisions

Saving needs a fine-grained personal access token:

- Repository access: **only this repository**
- Permissions: **Contents: Read and write** (Metadata: Read is added automatically)

Paste it under ⚙ Settings. It's kept in that browser's local storage and sent only to `api.github.com`. Anyone can read the page, but without a token they can't change anything in the repo.

## Run locally

```bash
python -I scripts/fetch_news.py            # today's stories, US Eastern date
python -I scripts/fetch_news.py --hours 48 # wider window
python -m http.server 8000                 # then open http://localhost:8000
```

Running the fetch again on the same day adds new stories and keeps existing ones, so decisions already made still match.

## Sources

Edit `sources.json` to add or remove feeds (`name`, `url`, `category`). The Sources tab shows any feed that fails. Checked and left out in Oct 2026: CISA advisories (403 to scripted clients), MSRC blog (malformed XML), Windows release health RSS (404), SANS NewsBites (no feed, web page only). SANS is covered by the Internet Storm Center diaries. The fetcher reads RSS 2.0, RSS 1.0 (RDF, used by Slashdot) and Atom.
