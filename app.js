// IT News Digest: show the day's stories, most widely reported first.
// All feed text is rendered with textContent; links are limited to http(s).
(() => {
  "use strict";

  const LS_VIEW = "ind.view";
  const LS_TOKEN = "ind.fetchToken";
  const WORKFLOW = "fetch-news.yml";
  const HIGH_CVSS = 7.0; // badge stories that mention a CVE scored High (7.0+) or Critical (9.0+)

  const state = {
    days: [],
    day: null,
    dayData: null,
    view: "news",
    topic: "",
    source: "",
    query: "",
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  };
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
  const link = (url, text) => el("a", { href: safeUrl(url), target: "_blank", rel: "noopener noreferrer", text });

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  // ---------- data ----------
  async function loadIndex() {
    const res = await fetch(`data/index.json?t=${Date.now()}`, { cache: "no-store" });
    state.days = res.ok ? (await res.json()).days || [] : [];
  }
  async function loadDay(day) {
    const res = await fetch(`data/days/${day}.json`, { cache: "no-store" });
    state.dayData = res.ok ? await res.json() : { items: [], sources: [] };
    state.day = day;
  }

  const sourcesOf = (it) => [it.source, ...(it.also_covered_by || []).map((c) => c.source)];
  const coverage = (it) => 1 + (it.also_covered_by || []).length;

  // Most-reported first; ties go to the most recent
  const rank = (a, b) => coverage(b) - coverage(a) || (b.published || "").localeCompare(a.published || "");

  const isCve = (it) => it.kind === "cve";
  const newsItems = () => (state.dayData?.items || []).filter((it) => !isCve(it));
  const cveItems = () => (state.dayData?.items || []).filter(isCve);

  // Search and source filters apply to both lists; topic filters apply to news only
  function matches(it, useTopic) {
    const q = state.query.toLowerCase();
    if (useTopic && state.topic && !it.topics.includes(state.topic)) return false;
    if (state.source && !sourcesOf(it).includes(state.source)) return false;
    if (q && !`${it.title} ${it.summary}`.toLowerCase().includes(q)) return false;
    return true;
  }

  function visibleItems() {
    return newsItems().filter((it) => matches(it, true)).sort(rank);
  }

  function visibleCves() {
    return cveItems().filter((it) => matches(it, false))
      .sort((a, b) => b.cvss.score - a.cvss.score || (b.published || "").localeCompare(a.published || ""));
  }

  // ---------- rendering ----------
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

  function render() {
    for (const tab of document.querySelectorAll(".tabs button")) tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
    $("#view-news").hidden = state.view !== "news";
    $("#view-sources").hidden = state.view !== "sources";
    if (state.view === "news") renderNews();
    else renderSources();
  }

  function renderNews() {
    const items = newsItems();
    const topicCounts = {};
    for (const it of items) for (const t of it.topics) topicCounts[t] = (topicCounts[t] || 0) + 1;
    $("#topic-filter").replaceChildren(
      el("button", { class: `chip${state.topic ? "" : " on"}`, text: `All topics ${items.length}`, onclick: () => { state.topic = ""; render(); } }),
      ...Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) =>
        el("button", { class: `chip${state.topic === t ? " on" : ""}`, text: `${t} ${n}`, onclick: () => { state.topic = state.topic === t ? "" : t; render(); } })),
      cveItems().length ? el("button", { class: "chip jump", text: `Critical CVEs ${cveItems().length} ↓`, onclick: () => $("#cves")?.scrollIntoView({ behavior: "smooth" }) }) : null,
    );

    const list = visibleItems();
    const cves = visibleCves();
    const box = $("#news");
    if (!list.length && !cves.length) {
      box.replaceChildren(el("p", { class: "empty", text: (state.dayData?.items || []).length ? "Nothing matches these filters." : "No stories for this day yet." }));
      return;
    }
    const top = list.filter((it) => coverage(it) > 1);
    const rest = list.filter((it) => coverage(it) === 1);
    box.replaceChildren(
      top.length ? section("Most reported", `${top.length} ${top.length === 1 ? "story" : "stories"} covered by more than one source`, top) : null,
      rest.length ? section(top.length ? "Other stories" : "Stories", `${rest.length} from a single source, newest first`, rest) : null,
      cves.length ? cveSection(cves) : null,
    );
  }

  function cveSection(cves) {
    const nvd = (state.dayData?.sources || []).find((s) => s.source === "NVD new CVEs");
    const hours = state.dayData?.window_hours || 36;
    return el("section", { class: "news-section", id: "cves" },
      el("div", { class: "section-head" },
        el("h2", { text: "New critical CVEs" }),
        el("span", { class: "muted", text: `${cves.length} published to NVD in the last ${hours} hours with a CVSS score of 9.0 or higher, highest first${nvd?.error ? " (NVD fetch failed, see Sources)" : ""}` }),
      ),
      el("ul", { class: "cve-list" }, ...cves.map(cveRow)),
    );
  }

  function cveRow(it) {
    const c = it.cvss || {};
    return el("li", { class: "cve" },
      el("span", { class: `score sev-${(c.severity || "").toLowerCase()}`, title: `CVSS ${c.version} base score, scored by ${c.scored_by}`, text: Number(c.score).toFixed(1) }),
      el("div", { class: "cve-body" },
        el("div", { class: "meta" },
          link(it.url, it.cve),
          link(it.cve_org_url, "cve.org"),
          el("span", { text: `CVSS ${c.version} · ${c.severity} · scored by ${c.scored_by}` }),
          el("span", { text: fmtTime(it.published) }),
        ),
        el("p", { class: "summary", text: it.summary }),
      ),
    );
  }

  function section(title, note, items) {
    return el("section", { class: "news-section" },
      el("div", { class: "section-head" }, el("h2", { text: title }), el("span", { class: "muted", text: note })),
      el("div", { class: "cards" }, ...items.map(card)),
    );
  }

  function cvssBadge(it) {
    const top = (it.cves || [])[0];
    if (!top || top.score < HIGH_CVSS) return null;
    const detail = it.cves.map((c) => `${c.id}: CVSS ${c.version} ${c.score.toFixed(1)} ${c.severity}, scored by ${c.scored_by}`).join("\n");
    return el("a", {
      class: `cvss sev-${top.score >= 9 ? "critical" : "high"}`,
      href: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(top.id)}`,
      target: "_blank", rel: "noopener noreferrer", title: detail,
      text: `CVSS ${top.score.toFixed(1)}${it.cves.length > 1 ? ` · ${it.cves.length} CVEs` : ""}`,
    });
  }

  function card(it) {
    const also = it.also_covered_by || [];
    const n = coverage(it);
    return el("article", { class: `card${n > 1 ? " multi" : ""}` },
      el("div", { class: "meta" },
        n > 1 ? el("span", { class: "count", text: `${n} sources` }) : null,
        cvssBadge(it),
        el("span", { class: "source", text: it.source }),
        el("span", { text: fmtTime(it.published) }),
      ),
      el("h3", {}, link(it.url, it.title)),
      it.summary ? el("p", { class: "summary", text: it.summary }) : null,
      also.length ? el("ul", { class: "also-list" }, ...also.map((c) =>
        el("li", {}, el("span", { class: "source", text: `${c.source}: ` }), link(c.url, c.title)))) : null,
      el("div", { class: "tags" }, ...it.topics.map((t) => el("span", { class: "tag", text: t }))),
    );
  }

  function renderSources() {
    const d = state.dayData || {};
    $("#sources-meta").textContent = d.generated ? `Fetched ${fmtTime(d.generated)}, window ${d.window_hours} hours. ${(d.items || []).length} stories after merging duplicates.` : "";
    const sorted = [...(d.sources || [])].sort((a, b) => a.source.localeCompare(b.source, undefined, { sensitivity: "base" }));
    $("#sources-body").replaceChildren(...sorted.map((s) => el("tr", {},
      el("td", { text: s.source }),
      el("td", { text: String(s.fetched) }),
      el("td", { text: String(s.recent) }),
      el("td", { class: s.error ? "bad" : "good", text: s.error || "OK" }),
    )));
  }

  function populateFilters() {
    const daySel = $("#day");
    daySel.replaceChildren(...state.days.map((d) => el("option", { value: d.date, text: `${d.date} (${d.count})` })));
    daySel.value = state.day || "";
    const sources = [...new Set((state.dayData?.items || []).flatMap(sourcesOf))].sort();
    const srcSel = $("#source-filter");
    srcSel.replaceChildren(el("option", { value: "", text: "All sources" }), ...sources.map((s) => el("option", { value: s, text: s })));
    srcSel.value = sources.includes(state.source) ? state.source : "";
    state.source = srcSel.value;
  }

  // ---------- manual fetch (dispatches the GitHub Actions workflow) ----------
  function repo() {
    const host = location.hostname.match(/^([^.]+)\.github\.io$/i);
    const seg = location.pathname.split("/").filter(Boolean)[0];
    return host && seg ? `${host[1]}/${seg}` : "Giles-de-Streel/it-news-digest";
  }
  const token = () => store.get(LS_TOKEN, "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const todayEastern = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

  async function gh(path, opts = {}) {
    return fetch(`https://api.github.com/repos/${repo()}${path}`, {
      ...opts,
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token()}`, ...(opts.headers || {}) },
    });
  }

  function fetchStatus(text, href) {
    const box = $("#fetch-status");
    box.hidden = !text;
    box.replaceChildren(el("div", { class: "wrap" }, el("span", { text: text || "" }), href ? link(href, "View run on GitHub") : null));
  }

  function openFetchSetup(message) {
    $("#fetch-token").value = token();
    $("#fetch-gh-link").href = `https://github.com/${repo()}/actions/workflows/${WORKFLOW}`;
    $("#fetch-setup-status").textContent = message || "";
    $("#fetch-setup").showModal();
  }

  let fetching = false;
  async function runFetch() {
    if (fetching) return;
    if (!token()) { openFetchSetup(); return; }
    fetching = true;
    $("#fetch-btn").disabled = true;
    const started = new Date(Date.now() - 60_000); // allow for clock skew when matching the run
    try {
      fetchStatus("Starting the fetch…");
      const res = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: "main" }),
      });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        fetchStatus("");
        openFetchSetup(`GitHub refused the request (${res.status}). Check the token has Actions: Read and write on this repository.`);
        return;
      }
      if (!res.ok) throw new Error(`GitHub ${res.status}`);

      // Find the run we just started and follow it
      let run = null;
      for (let i = 0; i < 90; i++) {
        await sleep(i ? 10_000 : 4_000);
        const r = await gh(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`);
        if (!r.ok) continue;
        run = (await r.json()).workflow_runs.find((x) => new Date(x.created_at) >= started) || null;
        if (!run) { fetchStatus("Waiting for GitHub to start the fetch…"); continue; }
        if (run.status === "completed") break;
        fetchStatus(`Fetching news (${run.status.replace("_", " ")})…`, run.html_url);
      }
      if (!run || run.status !== "completed") throw new Error("the fetch is taking longer than expected");
      if (run.conclusion !== "success") { fetchStatus(`The fetch ${run.conclusion}.`, run.html_url); return; }

      // The run committed new data; wait for GitHub Pages to publish it
      fetchStatus("Fetched. Waiting for the site to publish the update…", run.html_url);
      const day = todayEastern();
      for (let i = 0; i < 30; i++) {
        await sleep(10_000);
        const d = await fetch(`data/days/${day}.json?t=${Date.now()}`, { cache: "no-store" }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        if (d && new Date(d.generated) >= new Date(run.created_at)) {
          await loadIndex();
          await loadDay(day);
          populateFilters();
          render();
          fetchStatus(`Updated at ${fmtTime(d.generated)}.`);
          setTimeout(() => fetchStatus(""), 8000);
          return;
        }
      }
      fetchStatus("Fetched, but the site hasn't published it yet. Reload the page in a minute.", run.html_url);
    } catch (e) {
      fetchStatus(`Fetch failed: ${e.message}`);
    } finally {
      fetching = false;
      $("#fetch-btn").disabled = false;
    }
  }

  // ---------- events ----------
  function wire() {
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { state.view = b.dataset.view; store.set(LS_VIEW, state.view); render(); }));
    $("#search").addEventListener("input", (e) => { state.query = e.target.value; render(); });
    $("#source-filter").addEventListener("change", (e) => { state.source = e.target.value; render(); });
    $("#day").addEventListener("change", async (e) => { await loadDay(e.target.value); populateFilters(); render(); });
    $("#fetch-btn").addEventListener("click", runFetch);
    $("#fetch-forget").addEventListener("click", () => { store.set(LS_TOKEN, ""); $("#fetch-token").value = ""; $("#fetch-setup-status").textContent = "Token removed from this browser."; });
    $("#fetch-save-run").addEventListener("click", () => {
      const value = $("#fetch-token").value.trim();
      if (!value) { $("#fetch-setup-status").textContent = "Paste a token first."; return; }
      store.set(LS_TOKEN, value);
      $("#fetch-setup").close();
      runFetch();
    });
  }

  async function init() {
    wire();
    const saved = store.get(LS_VIEW, "news");
    state.view = saved === "sources" ? "sources" : "news";
    await loadIndex();
    if (state.days.length) await loadDay(state.days[0].date);
    populateFilters();
    render();
  }

  init().catch((e) => { $("#news").replaceChildren(el("p", { class: "empty", text: `Couldn't load data: ${e.message}` })); });
})();
