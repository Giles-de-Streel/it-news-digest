// IT News Digest: show the day's stories, most widely reported first.
// All feed text is rendered with textContent; links are limited to http(s).
(() => {
  "use strict";

  const LS_VIEW = "ind.view";
  const LS_LAYOUT = "ind.layout"; // "cards" or "list" (compact, one row per story)
  const LS_OFF = "ind.sourcesOff"; // sources switched off on the Sources tab (hidden here, still fetched)
  const VIEWS = ["news", "cves", "sources"];
  const HIGH_CVSS = 7.0; // badge stories that mention a CVE scored High (7.0+) or Critical (9.0+)
  const SOURCE_CAP = 8; // single-source stories shown per source before the rest fold away
  const WEEK = "week"; // day-picker value for the combined last-7-days view
  const WEEK_DAYS = 7;

  const state = {
    days: [],
    day: null,
    dayData: null,
    view: "news",
    topic: "",
    source: "",
    query: "",
    cveQuery: "",
    layout: "cards",
    catalog: [], // every configured source, from sources.json
    off: new Set(),
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
  async function loadCatalog() {
    const res = await fetch(`sources.json?t=${Date.now()}`, { cache: "no-store" });
    state.catalog = res.ok ? await res.json() : [];
  }
  async function fetchDay(day) {
    const res = await fetch(`data/days/${day}.json`, { cache: "no-store" });
    return res.ok ? await res.json() : { date: day, items: [], sources: [] };
  }
  async function loadDay(day) {
    if (day === WEEK) {
      // Each day file only holds stories no earlier day listed, so the days combine without overlap
      const days = await Promise.all(state.days.slice(0, WEEK_DAYS).map((d) => fetchDay(d.date)));
      const seen = new Set();
      const items = days.flatMap((d) => d.items || []).filter((it) => !seen.has(it.id) && seen.add(it.id));
      const latest = days[0] || {};
      state.dayData = { ...latest, items, week: days.map((d) => d.date) };
    } else {
      state.dayData = await fetchDay(day);
    }
    state.day = day;
  }

  const sourcesOf = (it) => [it.source, ...(it.also_covered_by || []).map((c) => c.source)];
  const coverage = (it) => 1 + (it.also_covered_by || []).length;

  // Most-reported first; ties go to the most recent
  const rank = (a, b) => coverage(b) - coverage(a) || (b.published || "").localeCompare(a.published || "");

  const isCve = (it) => it.kind === "cve";
  // A story stays visible while at least one source that covered it is switched on
  const isOn = (it) => sourcesOf(it).some((s) => !state.off.has(s));
  const newsItems = () => (state.dayData?.items || []).filter((it) => !isCve(it) && isOn(it));
  const cveItems = () => (state.dayData?.items || []).filter((it) => isCve(it) && isOn(it));

  function visibleItems() {
    const q = state.query.toLowerCase();
    return newsItems().filter((it) => {
      if (state.topic && !it.topics.includes(state.topic)) return false;
      if (state.source && !sourcesOf(it).includes(state.source)) return false;
      if (q && !`${it.title} ${it.summary}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort(rank);
  }

  function visibleCves() {
    const q = state.cveQuery.toLowerCase();
    return cveItems().filter((it) => !q || `${it.title} ${it.summary}`.toLowerCase().includes(q))
      .sort((a, b) => b.cvss.score - a.cvss.score || (b.published || "").localeCompare(a.published || ""));
  }

  // ---------- rendering ----------
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

  function render() {
    for (const tab of document.querySelectorAll(".tabs button")) tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
    for (const v of VIEWS) $(`#view-${v}`).hidden = state.view !== v;
    for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(b.dataset.layout === state.layout));
    $("#cve-tab-count").textContent = cveItems().length ? String(cveItems().length) : "";
    const generated = state.dayData?.generated;
    $("#updated").textContent = generated ? `Updated ${fmtTime(generated)}` : "";
    $("#updated").title = generated ? `Last fetch for this day: ${new Date(generated).toLocaleString()}` : "";
    if (state.view === "news") renderNews();
    else if (state.view === "cves") renderCves();
    else renderSources();
  }

  // Topic name in front, story count quieter beside it
  const chipLabel = (label, n) => [el("span", { class: "chip-label", text: label }), el("span", { class: "chip-n", text: String(n) })];

  function renderNews() {
    const items = newsItems();
    const topicCounts = {};
    for (const it of items) for (const t of it.topics) topicCounts[t] = (topicCounts[t] || 0) + 1;
    $("#topic-filter").replaceChildren(
      el("button", { class: `chip${state.topic ? "" : " on"}`, onclick: () => { state.topic = ""; render(); } }, ...chipLabel("All topics", items.length)),
      ...Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) =>
        el("button", { class: `chip${state.topic === t ? " on" : ""}`, onclick: () => { state.topic = state.topic === t ? "" : t; render(); } }, ...chipLabel(t, n))),
    );

    const list = visibleItems();
    const box = $("#news");
    if (!list.length) {
      box.replaceChildren(el("p", { class: "empty", text: items.length ? "Nothing matches these filters." : "No stories for this day yet." }));
      return;
    }
    const top = list.filter((it) => coverage(it) > 1);
    const rest = list.filter((it) => coverage(it) === 1);
    // Keep busy sources from crowding the list: show each source's newest few, fold the rest.
    // Picking that source or searching shows everything.
    const capped = !state.source && !state.query;
    const shown = [], folded = new Map(), perSource = {};
    for (const it of rest) {
      perSource[it.source] = (perSource[it.source] || 0) + 1;
      if (!capped || perSource[it.source] <= SOURCE_CAP) shown.push(it);
      else folded.set(it.source, [...(folded.get(it.source) || []), it]);
    }
    const more = [...folded].map(([src, items]) => el("details", { class: "more", ontoggle: (e) => addMoreToggles(e.target) },
      el("summary", { text: `${items.length} more from ${src}` }),
      storyList(items)));
    // replaceChildren() turns a null argument into the text "null", so drop the empty section
    box.replaceChildren(...[
      top.length ? section("Most reported", `${top.length} ${top.length === 1 ? "story" : "stories"} covered by more than one source`, top) : null,
      rest.length ? section(top.length ? "Other stories" : "Stories",
        `${rest.length} from a single source, newest first${folded.size ? `; at most ${SOURCE_CAP} per source shown, the rest are folded below` : ""}`,
        shown, more) : null,
    ].filter(Boolean));
    addMoreToggles(box);
  }

  // Summaries are clamped to 3 lines by CSS; add a More/Less toggle only where text is cut off.
  // Hidden cards (inside a closed <details>) measure 0 and are checked when opened.
  function addMoreToggles(root) {
    for (const p of root.querySelectorAll(".summary.clamp:not([data-checked])")) {
      if (!p.clientHeight) continue;
      p.dataset.checked = "1";
      if (p.scrollHeight <= p.clientHeight + 2) continue;
      const btn = el("button", { class: "more-toggle", type: "button", text: "More", "aria-expanded": "false" });
      btn.addEventListener("click", () => {
        const open = p.classList.toggle("clamp") === false;
        btn.textContent = open ? "Less" : "More";
        btn.setAttribute("aria-expanded", String(open));
      });
      p.after(btn);
    }
  }

  function renderCves() {
    const all = cveItems();
    const cves = visibleCves();
    const nvd = (state.dayData?.sources || []).find((s) => s.source === "NVD new CVEs");
    const hours = state.dayData?.window_hours || 36;
    const span = state.dayData?.week ? `over the last ${state.dayData.week.length} days` : `in the ${hours} hours before this fetch`;
    $("#cves-meta").textContent = nvd?.error && !state.dayData?.week
      ? `The NVD fetch failed for this day: ${nvd.error}`
      : `${all.length} CVEs published to NIST's NVD ${span} with a CVSS score of 9.0 or higher, highest first. EPSS is the estimated chance of exploitation in the next 30 days; "Exploited" means CISA lists it as known exploited.`;
    $("#cves-list").replaceChildren(cves.length
      ? el("ul", { class: "cve-list" }, ...cves.map(cveRow))
      : el("p", { class: "empty", text: all.length ? "Nothing matches this search." : "No critical CVEs for this day." }));
    addMoreToggles($("#cves-list"));
  }

  function cveRow(it) {
    const c = it.cvss || {};
    return el("li", { class: "cve" },
      el("span", { class: `score sev-${(c.severity || "").toLowerCase()}`, title: `CVSS ${c.version} base score, scored by ${c.scored_by}`, text: Number(c.score).toFixed(1) }),
      el("div", { class: "cve-body" },
        el("div", { class: "meta" },
          link(it.url, it.cve),
          link(it.cve_org_url, "cve.org"),
          kevBadge(it),
          epssBadge(it),
          el("span", { text: `CVSS ${c.version} · ${c.severity} · scored by ${c.scored_by}` }),
          el("span", { text: fmtTime(it.published) }),
        ),
        el("p", { class: "summary clamp", text: it.summary }),
      ),
    );
  }

  function section(title, note, items, extra = []) {
    return el("section", { class: "news-section" },
      el("div", { class: "section-head" }, el("h2", { text: title }), el("span", { class: "muted", text: note })),
      storyList(items),
      ...extra,
    );
  }

  const storyList = (items) => (state.layout === "list"
    ? el("ul", { class: "rows" }, ...items.map(row))
    : el("div", { class: "cards" }, ...items.map(card)));

  // Compact layout: one line per story; the summary is in the headline's tooltip
  function row(it) {
    const also = it.also_covered_by || [];
    const n = coverage(it);
    const badges = [n > 1 ? el("span", { class: "count", text: `${n} sources` }) : null, kevBadge(it), cvssBadge(it), epssBadge(it)].filter(Boolean);
    return el("li", { class: `row${n > 1 ? " multi" : ""}` },
      el("div", { class: "row-main" },
        badges.length ? el("span", { class: "meta row-badges" }, ...badges) : null,
        el("a", { class: "row-title", href: safeUrl(it.url), target: "_blank", rel: "noopener noreferrer", title: it.summary || it.title, text: it.title }),
      ),
      el("span", {
        class: "row-meta",
        title: also.length ? `Also covered by: ${also.map((c) => c.source).join(", ")}` : "",
        text: `${it.source}${also.length ? ` +${also.length}` : ""} · ${fmtTime(it.published)}`,
      }),
    );
  }

  // EPSS: FIRST.org's estimated probability of exploitation in the next 30 days
  const fmtPct = (p) => (p >= 0.01 ? `${Math.round(p * 100)}%` : p >= 0.001 ? `${(p * 100).toFixed(1)}%` : "<0.1%");
  function epssBadge(it) {
    const e = it.exploit?.epss;
    if (!e) return null;
    const level = e.score >= 0.1 ? "high" : e.score >= 0.01 ? "mid" : "low";
    return el("a", {
      class: `epss epss-${level}`, href: "https://www.first.org/epss/", target: "_blank", rel: "noopener noreferrer",
      title: `${e.id}: EPSS ${fmtPct(e.score)} chance of exploitation in the next 30 days, higher than ${(e.percentile * 100).toFixed(1)}% of all CVEs (FIRST.org, ${e.date})`,
      text: `EPSS ${fmtPct(e.score)}`,
    });
  }

  // KEV: CISA's catalog of vulnerabilities known to be exploited
  function kevBadge(it) {
    const kev = it.exploit?.kev || [];
    if (!kev.length) return null;
    const ransomware = kev.some((k) => k.ransomware);
    return el("a", {
      class: "kev", target: "_blank", rel: "noopener noreferrer",
      href: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(kev[0].id)}`,
      title: kev.map((k) => `${k.id}: in CISA's Known Exploited Vulnerabilities catalog since ${k.added}${k.ransomware ? ", used in ransomware campaigns" : ""}`).join("\n"),
      text: `Exploited${ransomware ? " · ransomware" : ""}`,
    });
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
        kevBadge(it),
        cvssBadge(it),
        epssBadge(it),
        el("span", { class: "source", text: it.source }),
        el("span", { text: fmtTime(it.published) }),
      ),
      el("h3", {}, link(it.url, it.title)),
      it.summary ? el("p", { class: "summary clamp", text: it.summary }) : null,
      also.length ? el("ul", { class: "also-list" }, ...also.map((c) =>
        el("li", {}, el("span", { class: "source", text: `${c.source}: ` }), link(c.url, c.title)))) : null,
      el("div", { class: "tags" }, ...it.topics.map((t) => el("span", { class: "tag", text: t }))),
    );
  }

  function renderSources() {
    const d = state.dayData || {};
    $("#sources-meta").textContent = !d.generated ? ""
      : d.week ? `Showing the latest day's fetch (${d.date}, ${fmtTime(d.generated)}). Pick a single day to see its sources.`
      : `Fetched ${fmtTime(d.generated)}, window ${d.window_hours} hours. ${(d.items || []).length} stories after merging duplicates.`;
    // Every configured source, one row each; sources dropped from sources.json still show if this day fetched them
    const status = new Map((d.sources || []).map((s) => [s.source, s]));
    const all = [...state.catalog];
    for (const name of status.keys()) if (!all.some((c) => c.name === name)) all.push({ name, category: "Removed" });
    all.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    const onCount = all.filter((s) => !state.off.has(s.name)).length;
    $("#sources-switches").replaceChildren(
      el("span", { text: `${onCount} of ${all.length} sources shown on the News and CVEs tabs. Switched-off sources are still fetched; this only hides their stories in this browser.` }),
      ...(onCount < all.length ? [el("button", { class: "chip", text: "Show all", onclick: () => setOff(all.map((s) => s.name), false) })] : []),
    );

    $("#sources-body").replaceChildren(...all.map((s) => {
      const st = status.get(s.name);
      const on = !state.off.has(s.name);
      return el("tr", { class: on ? "" : "off" },
        el("td", { class: "sw" }, toggle(on, `Show ${s.name}`, (v) => setOff([s.name], !v))),
        el("td", {}, s.site ? link(s.site, s.name) : s.name), // the outlet's own site, not its feed
        el("td", { class: "muted", text: s.category || "" }),
        el("td", { text: st ? String(st.fetched) : "" }),
        el("td", { text: st ? String(st.recent) : "" }),
        st ? el("td", { class: st.error ? "bad" : "good", text: st.error || "OK" })
          : el("td", { class: "muted", text: "Not in this fetch" }),
      );
    }));
  }

  function toggle(checked, label, onchange) {
    const input = el("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": label, title: label });
    input.checked = checked;
    input.addEventListener("change", () => onchange(input.checked));
    return input;
  }

  function setOff(names, off) {
    for (const n of names) off ? state.off.add(n) : state.off.delete(n);
    store.set(LS_OFF, [...state.off]);
    populateFilters();
    render();
  }

  function populateFilters() {
    const daySel = $("#day");
    const weekCount = state.days.slice(0, WEEK_DAYS).reduce((n, d) => n + d.count, 0);
    daySel.replaceChildren(
      ...(state.days.length > 1 ? [el("option", { value: WEEK, text: `Last ${Math.min(WEEK_DAYS, state.days.length)} days (${weekCount})` })] : []),
      ...state.days.map((d) => el("option", { value: d.date, text: `${d.date} (${d.count})` })));
    daySel.value = state.day || "";
    const sources = [...new Set(newsItems().flatMap(sourcesOf))].filter((s) => !state.off.has(s)).sort();
    const srcSel = $("#source-filter");
    srcSel.replaceChildren(el("option", { value: "", text: "All sources" }), ...sources.map((s) => el("option", { value: s, text: s })));
    srcSel.value = sources.includes(state.source) ? state.source : "";
    state.source = srcSel.value;
  }

  function setView(view) {
    state.view = view;
    store.set(LS_VIEW, view);
    history.replaceState(null, "", view === "news" ? location.pathname + location.search : `#${view}`);
    render();
    window.scrollTo(0, 0);
  }

  // ---------- events ----------
  function wire() {
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
    window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEWS.includes(v) && v !== state.view) setView(v); });
    $("#cve-search").addEventListener("input", (e) => { state.cveQuery = e.target.value; render(); });
    $("#search").addEventListener("input", (e) => { state.query = e.target.value; render(); });
    $("#source-filter").addEventListener("change", (e) => { state.source = e.target.value; render(); });
    document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
      state.layout = b.dataset.layout;
      store.set(LS_LAYOUT, state.layout);
      render();
    }));
    $("#day").addEventListener("change", async (e) => { await loadDay(e.target.value); populateFilters(); render(); });
  }

  async function init() {
    wire();
    // A link like ...#cves opens that tab; otherwise reopen the last tab used
    const fromHash = location.hash.slice(1);
    const saved = store.get(LS_VIEW, "news");
    state.view = VIEWS.includes(fromHash) ? fromHash : VIEWS.includes(saved) ? saved : "news";
    state.layout = store.get(LS_LAYOUT, "cards") === "list" ? "list" : "cards";
    const off = store.get(LS_OFF, []);
    state.off = new Set(Array.isArray(off) ? off : []);
    await Promise.all([loadIndex(), loadCatalog()]);
    if (state.days.length) await loadDay(state.days[0].date);
    populateFilters();
    render();
  }

  init().catch((e) => { $("#news").replaceChildren(el("p", { class: "empty", text: `Couldn't load data: ${e.message}` })); });
})();
