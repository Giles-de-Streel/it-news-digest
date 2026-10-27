// IT News Digest: show the day's stories, most widely reported first.
// All feed text is rendered with textContent; links are limited to http(s).
(() => {
  "use strict";

  const LS_VIEW = "ind.view";

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

  function card(it) {
    const also = it.also_covered_by || [];
    const n = coverage(it);
    return el("article", { class: `card${n > 1 ? " multi" : ""}` },
      el("div", { class: "meta" },
        n > 1 ? el("span", { class: "count", text: `${n} sources` }) : null,
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
    $("#sources-body").replaceChildren(...(d.sources || []).map((s) => el("tr", {},
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

  // ---------- events ----------
  function wire() {
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { state.view = b.dataset.view; store.set(LS_VIEW, state.view); render(); }));
    $("#search").addEventListener("input", (e) => { state.query = e.target.value; render(); });
    $("#source-filter").addEventListener("change", (e) => { state.source = e.target.value; render(); });
    $("#day").addEventListener("change", async (e) => { await loadDay(e.target.value); populateFilters(); render(); });
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
