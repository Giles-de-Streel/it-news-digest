// IT News Digest: show the day's stories, most widely reported first.
// All feed text is rendered with textContent; links are limited to http(s).
(() => {
  "use strict";

  const LS_VIEW = "ind.view";
  const LS_LAYOUT = "ind.layout"; // "cards" or "list" (compact, one row per story)
  const LS_SCENE = "ind.scene"; // true = header animation turned on by lighting the match; off until then
  const LS_THEME = "ind.theme"; // "dark", "medium" or "light"; unset = follow the system setting
  const THEMES = ["dark", "medium", "light"]; // the colour-mode match steps through these in order
  const LS_OFF = "ind.sourcesOff"; // sources switched off on the Sources tab (hidden here, still fetched)
  const VIEWS = ["news", "cves", "sources", "history"];
  const HIGH_CVSS = 7.0; // badge stories that mention a CVE scored High (7.0+) or Critical (9.0+)
  const SOURCE_CAP = 8; // single-source stories shown per source before the rest fold away
  const SECTION_CAP = 7; // stories shown per News section before the rest fold into "N more stories"
  // History tab: "week" and "all" combine several day files; any other value is one date
  const WEEK = "week";
  const ALL = "all";
  const WEEK_DAYS = 7;
  const HIST_CAP_RANGE = 15; // per-day rows shown when several days are listed; the rest fold away
  const HIST_CAP_DAY = 60; // rows shown for a single day, or for any day while searching

  const state = {
    days: [],
    day: null, // the latest day: the News, CVEs and Sources tabs always show it
    dayData: null,
    hist: { range: WEEK, query: "", topic: "", kind: "news" }, // History tab picks
    view: "news",
    topic: "",
    source: "",
    query: "",
    cveQuery: "",
    srcQuery: "", // Sources tab search: filters the sources and suggested-sources tables
    layout: "list",
    catalog: [], // every configured source, from sources.json
    suggest: null, // data/source_candidates.json, loaded the first time the Sources tab opens
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
  async function loadSuggestions() {
    try {
      const res = await fetch(`data/source_candidates.json?t=${Date.now()}`, { cache: "no-store" });
      state.suggest = res.ok ? await res.json() : { candidates: [] };
    } catch { state.suggest = { candidates: [] }; }
    renderSuggestions();
  }
  async function fetchDay(day) {
    const res = await fetch(`data/days/${day}.json`, { cache: "no-store" });
    return res.ok ? await res.json() : { date: day, items: [], sources: [] };
  }
  async function loadDay(day) {
    state.dayData = await fetchDay(day);
    state.day = day;
  }

  // Past day files for the History tab, fetched once per page load. The latest day reuses the
  // News tab's copy. A failed fetch is dropped from the cache so the next visit retries it.
  const dayCache = new Map();
  function historyDay(date) {
    if (date === state.day && state.dayData) return Promise.resolve(state.dayData);
    if (!dayCache.has(date)) {
      dayCache.set(date, fetchDay(date).catch((e) => { dayCache.delete(date); throw e; }));
    }
    return dayCache.get(date);
  }
  const histDates = (range) => (range === WEEK ? state.days.slice(0, WEEK_DAYS)
    : range === ALL ? state.days
    : state.days.filter((d) => d.date === range)).map((d) => d.date);

  const sourcesOf = (it) => [it.source, ...(it.also_covered_by || []).map((c) => c.source)];
  const coverage = (it) => 1 + (it.also_covered_by || []).length;

  // Most-reported first; ties go to the most recent
  const rank = (a, b) => coverage(b) - coverage(a) || (b.published || "").localeCompare(a.published || "");

  const isCve = (it) => it.kind === "cve";
  // A story stays visible while at least one source that covered it is switched on
  const isOn = (it) => sourcesOf(it).some((s) => !state.off.has(s));
  const newsItems = () => (state.dayData?.items || []).filter((it) => !isCve(it) && isOn(it));
  const cveItems = () => (state.dayData?.items || []).filter((it) => isCve(it) && isOn(it));

  // The News tab's topic, source and search filters, shared by stories and CVE records
  function matchesFilters(it) {
    const q = state.query.toLowerCase();
    if (state.topic && !(it.topics || []).includes(state.topic)) return false;
    if (state.source && !sourcesOf(it).includes(state.source)) return false;
    if (q && !`${it.title} ${it.summary} ${it.cve || ""}`.toLowerCase().includes(q)) return false;
    return true;
  }

  function visibleItems() {
    return newsItems().filter(matchesFilters).sort(rank);
  }

  // CVE records matching a News-tab search (only while searching), highest score first
  const byScore = (a, b) => b.cvss.score - a.cvss.score || (b.published || "").localeCompare(a.published || "");
  function searchedCves() {
    return state.query ? cveItems().filter(matchesFilters).sort(byScore) : [];
  }

  function visibleCves() {
    const q = state.cveQuery.toLowerCase();
    return cveItems().filter((it) => !q || `${it.title} ${it.summary}`.toLowerCase().includes(q)).sort(byScore);
  }

  // ---------- rendering ----------
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

  function render() {
    for (const tab of document.querySelectorAll(".tabs button")) tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
    for (const v of VIEWS) $(`#view-${v}`).hidden = state.view !== v;
    for (const b of document.querySelectorAll("[data-layout]")) b.setAttribute("aria-pressed", String(b.dataset.layout === state.layout));
    $("#cve-tab-count").textContent = cveItems().length ? String(cveItems().length) : "";
    const generated = state.dayData?.generated;
    $("#updated").textContent = generated ? `Updated ${fmtTime(generated)}` : "";
    $("#updated").title = generated ? `Last fetch for this day: ${new Date(generated).toLocaleString()}` : "";
    if (state.view === "news") renderNews();
    else if (state.view === "cves") renderCves();
    else if (state.view === "sources") renderSources();
    else renderHistory();
  }

  // Full name and a one-line description for each topic pill, shown above the stories when it's picked.
  // Must match the TOPICS keys in scripts/fetch_news.py; an unknown topic falls back to its pill text.
  const TOPIC_INFO = {
    "Accessibility": ["Accessibility", "Digital accessibility: WCAG, ADA Title II and Section 508, VPATs, screen readers and assistive technology, captions, and accessibility features in products."],
    "Agile & delivery": ["Agile and delivery", "Agile, Scrum, Kanban and Lean, product and project management, team practices and flow of work."],
    "AI": ["Artificial intelligence", "AI, machine learning, large language models and AI assistants."],
    "Backup & recovery": ["Backup and recovery", "Backups, disaster recovery, restores and business continuity."],
    "Cloud & infrastructure": ["Cloud and infrastructure", "Public cloud, virtualization, Kubernetes and data centers."],
    "Cloud status": ["Cloud service status and outages", "Incidents posted on cloud and SaaS status pages (Microsoft 365, Azure, AWS, Google, Cloudflare, Zoom, Canvas and others) and news about service outages. Planned maintenance notices are left out."],
    "Databases": ["Databases", "SQL Server, Oracle, PostgreSQL, MySQL and other database platforms."],
    "DevOps & SRE": ["DevOps and site reliability", "CI/CD, infrastructure as code, containers and Kubernetes, observability, platform engineering and incident practice."],
    "Development": ["Software development", "Programming languages, developer tools, source control and CI/CD."],
    "Embedded & IoT": ["Embedded systems and IoT", "Microcontrollers, firmware, RTOS, single-board computers and connected devices."],
    "Endpoint management": ["Endpoint management", "Intune, Configuration Manager, Autopilot, Jamf, device management and patching."],
    "Forensics & IR": ["Digital forensics and incident response", "Investigations, evidence collection, memory and disk analysis, IR write-ups."],
    "Game development": ["Game development", "Game engines, graphics APIs and GPU tech, game platforms and consoles, and the games industry: studios, publishers and releases."],
    "General IT": ["General IT", "Stories that don't match any of the other topics."],
    "Hardware": ["Hardware", "CPUs, GPUs, storage, servers, firmware and data center hardware."],
    "Higher education": ["Higher education", "Universities, campus IT, education technology and student data."],
    "ICS / OT": ["Industrial control systems and operational technology", "SCADA, PLCs, industrial networks, critical infrastructure and OT security."],
    "Identity & access": ["Identity and access", "Authentication, MFA, passkeys, SSO, SAML/OAuth and credentials."],
    "ITSM": ["IT service management", "ITIL, service desks, incident, problem and change management, CMDB and IT asset management, and ITSM tools such as ServiceNow and Jira Service Management."],
    "Linux & open source": ["Linux and open source", "Linux distributions, the kernel, open-source projects and tools."],
    "Microsoft & Windows": ["Microsoft and Windows", "Windows, Microsoft 365, Azure, Entra, Exchange, SQL Server and Defender."],
    "Networking": ["Networking", "Routers, firewalls, VPN, Wi-Fi, DNS and network vendors."],
    "Pen testing & red team": ["Penetration testing and red teaming", "Offensive security, exploits, C2 frameworks and bug bounties."],
    "Policy & regulation": ["Policy and regulation", "Laws, regulators, government action, lawsuits and fines."],
    "Ransomware & breaches": ["Ransomware and data breaches", "Ransomware attacks, breaches, leaks and extortion."],
    "Reverse engineering": ["Reverse engineering", "Decompiling, disassembly, fuzzing and malware analysis."],
    "Supply chain security": ["Software supply chain security", "Malicious packages, dependencies, SBOMs and open-source ecosystem security."],
    "System administration": ["System administration", "Running Windows, Microsoft 365 and Linux systems: AD, Group Policy, PowerShell, patching, releases and end-of-support dates."],
    "TLS & PKI": ["TLS, PKI and cryptography", "TLS and certificates, certificate authorities and root programs, ACME and Let's Encrypt, revocation, post-quantum cryptography and crypto libraries such as OpenSSL."],
    "Threats & malware": ["Threats and malware", "Malware, phishing, botnets, threat actors and campaigns."],
    "Vulnerabilities & patches": ["Vulnerabilities and patches", "CVEs, zero-days, exploits, security updates and advisories."],
  };

  // Says what the story list is showing: the picked topic in full, plus any source or search filter
  function renderFilterHead(count, cveCount = 0) {
    const head = $("#filter-head");
    const filtered = state.topic || state.source || state.query;
    if (!filtered) { head.hidden = true; return; }
    const [name, desc] = state.topic ? (TOPIC_INFO[state.topic] || [state.topic, ""]) : ["All topics", ""];
    const extra = [
      state.source ? `from ${state.source}` : "",
      state.query ? `matching "${state.query}"` : "",
    ].filter(Boolean).join(", ");
    const cveNote = cveCount ? ` and ${cveCount} ${cveCount === 1 ? "CVE" : "CVEs"}` : "";
    const note = `${count} ${count === 1 ? "story" : "stories"}${cveNote}${extra ? ` ${extra}` : ""}`;
    const clear = () => {
      Object.assign(state, { topic: "", source: "", query: "" });
      $("#search").value = "";
      $("#source-filter").value = "";
      syncUrl(true);
      render();
    };
    head.replaceChildren(
      el("div", { class: "filter-head-text" },
        el("span", { class: "filter-kicker", text: state.topic ? `Topic: ${state.topic}` : "Filtered" }),
        el("h2", { text: name }),
        ...(desc ? [el("p", { class: "muted filter-desc", text: desc })] : []),
        el("p", { class: "muted filter-note", text: note })),
      el("button", { class: "filter-clear", type: "button", onclick: clear, text: state.topic && !state.source && !state.query ? "Show all topics" : "Clear filters" }));
    head.hidden = false;
  }

  // Topic name in front, story count quieter beside it
  const navLabel = (label, n) => [el("span", { class: "nav-label", text: label }), el("span", { class: "nav-n", text: String(n) })];

  function setTopic(topic) {
    state.topic = topic;
    syncUrl(true);
    toggleTopicPanel(false);
    render();
    // Start the new list from its top when the user had scrolled down into the old one
    const top = $(".news-main").getBoundingClientRect().top;
    if (top < 0) window.scrollTo({ top: window.scrollY + top - topbarHeight() });
  }

  // One A-Z list of every known topic (TOPIC_INFO) plus any other topic found in the data,
  // so a topic newly added to fetch_news.py shows up even before it gets a TOPIC_INFO entry
  function renderTopicNav(items) {
    const counts = {};
    for (const it of items) for (const t of it.topics) counts[t] = (counts[t] || 0) + 1;
    const topics = [...new Set([...Object.keys(TOPIC_INFO), ...Object.keys(counts)])]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const item = (label, topic, n) => el("li", {},
      el("button", {
        type: "button",
        class: `nav-item${n ? "" : " empty"}`,
        "aria-current": state.topic === topic ? "true" : "false",
        title: topic ? (TOPIC_INFO[topic] || [topic, ""])[1] || topic : "Show every topic",
        onclick: () => setTopic(topic),
      }, ...navLabel(label, n)));
    $("#topic-nav").replaceChildren(
      el("div", { class: "nav-sheet-head" },
        el("span", { text: "Topics" }),
        el("button", { type: "button", class: "nav-close", text: "Close", onclick: () => toggleTopicPanel(false) })),
      el("ul", { class: "nav-list nav-all" }, item("All topics", "", items.length)),
      el("ul", { class: "nav-list nav-topics" }, ...topics.map((t) => item(t, t, counts[t] || 0))));
    $("#topics-toggle").textContent = state.topic ? `Topic: ${state.topic}` : "Topics";
  }

  function renderNews() {
    const items = newsItems();
    renderTopicNav(items);

    const list = visibleItems();
    const cves = searchedCves();
    renderFilterHead(list.length, cves.length);
    const box = $("#news");
    if (!list.length && !cves.length) {
      box.replaceChildren(el("p", { class: "empty", text: items.length ? "Nothing matches these filters." : "No stories for this day yet." }));
      return;
    }
    // A source picked in the drop-down: one flat list of that outlet's own articles, newest first
    if (state.source) {
      const own = list.map(asSourceArticle).sort((a, b) => (b.published || "").localeCompare(a.published || ""));
      const cveFirst = /cve-\d/i.test(state.query);
      box.replaceChildren(...[
        cves.length && cveFirst ? cveSection(cves) : null,
        own.length ? section(`From ${state.source}`, `${own.length} ${own.length === 1 ? "article" : "articles"}, newest first`, own) : null,
        cves.length && !cveFirst ? cveSection(cves) : null,
      ].filter(Boolean));
      addMoreToggles(box);
      return;
    }
    const top = list.filter((it) => coverage(it) > 1);
    // Every story with a CVSS badge, highest score first. Single-source ones move here from
    // "Other stories"; multi-source ones also stay in "Most reported".
    const vulns = list.filter(hasCvssBadge)
      .sort((a, b) => b.cves[0].score - a.cves[0].score || (b.published || "").localeCompare(a.published || ""));
    const rest = list.filter((it) => coverage(it) === 1 && !hasCvssBadge(it));
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
    const cveBlock = cves.length ? cveSection(cves) : null;
    // A search that looks like a CVE ID puts the CVE matches first; otherwise they follow the stories
    const cveFirst = /cve-\d/i.test(state.query);
    // replaceChildren() turns a null argument into the text "null", so drop the empty section
    box.replaceChildren(...[
      cveFirst ? cveBlock : null,
      top.length ? section("Most reported", `${top.length} ${top.length === 1 ? "story" : "stories"} covered by more than one source`, top, [], capped) : null,
      vulns.length ? section("Current vulnerabilities",
        `${vulns.length} ${vulns.length === 1 ? "story mentions" : "stories mention"} a CVE scored High (7.0+) or Critical (9.0+), highest score first`, vulns, [], capped) : null,
      rest.length ? section(top.length || vulns.length ? "Other stories" : "Stories",
        `${rest.length} from a single source, newest first${folded.size ? `; at most ${SOURCE_CAP} per source shown, the rest are folded below` : ""}`,
        shown, more, capped) : null,
      cveFirst ? null : cveBlock,
    ].filter(Boolean));
    addMoreToggles(box);
  }

  // The picked source's own version of a story: as-is when it is the lead outlet, otherwise its own
  // headline and link, with the lead outlet moved into "also covered by" (no summary of its own)
  function asSourceArticle(it) {
    if (it.source === state.source) return it;
    const also = it.also_covered_by || [];
    const mine = also.find((c) => c.source === state.source);
    if (!mine) return it;
    return {
      ...it, id: mine.id || it.id, title: mine.title, url: mine.url, source: mine.source, summary: "",
      also_covered_by: [{ id: it.id, source: it.source, title: it.title, url: it.url }, ...also.filter((c) => c !== mine)],
    };
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
    $("#cves-meta").textContent = nvd?.error
      ? `The NVD fetch failed for this day: ${nvd.error}`
      : `${all.length} CVEs published to NIST's NVD in the ${hours} hours before this fetch with a CVSS score of 9.0 or higher, highest first. EPSS is the estimated chance of exploitation in the next 30 days; "Exploited" means CISA lists it as known exploited. Earlier days are on the History tab.`;
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

  // Critical CVE records matching a News-tab search, in the same rows as the CVEs tab
  const CVE_SEARCH_CAP = 10;
  function cveSection(cves) {
    const first = cves.slice(0, CVE_SEARCH_CAP), rest = cves.slice(CVE_SEARCH_CAP);
    return el("section", { class: "news-section" },
      el("div", { class: "section-head" },
        el("h2", { text: "Matching CVEs" }),
        el("span", { class: "muted", text: `${cves.length} critical ${cves.length === 1 ? "CVE" : "CVEs"} (CVSS 9.0+) from NIST's NVD, highest score first` })),
      el("ul", { class: "cve-list" }, ...first.map(cveRow)),
      ...(rest.length ? [el("details", { class: "more", ontoggle: (e) => addMoreToggles(e.target) },
        el("summary", { text: `${rest.length} more matching CVEs` }),
        el("ul", { class: "cve-list" }, ...rest.map(cveRow)))] : []));
  }

  // ---------- History tab ----------
  // Every earlier day file: pick a day (or the last 7 days, or all of them) in the left list, then
  // search, filter by topic, and switch between stories and critical CVEs. One section per day.
  const fmtDay = (date, opts) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, opts);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function renderDayNav() {
    const sum = (list) => list.reduce((n, d) => n + d.count, 0);
    const item = (label, value, n, title) => el("li", {},
      el("button", {
        type: "button", class: "nav-item", title,
        "aria-current": state.hist.range === value ? "true" : "false",
        onclick: () => { state.hist.range = value; renderHistory(); window.scrollTo({ top: 0 }); },
      }, ...navLabel(label, n)));
    // Dates grouped under their month, newest first
    const months = new Map();
    for (const d of state.days) {
      const m = fmtDay(d.date, { month: "long", year: "numeric" });
      if (!months.has(m)) months.set(m, []);
      months.get(m).push(d);
    }
    const week = state.days.slice(0, WEEK_DAYS);
    $("#day-nav").replaceChildren(
      el("ul", { class: "nav-list nav-all" },
        item(`Last ${week.length} days`, WEEK, sum(week), "Every story from the last seven day files"),
        item(`All ${state.days.length} days`, ALL, sum(state.days), "Every day the digest has kept; loads every day file")),
      ...[...months].flatMap(([m, days]) => [
        el("div", { class: "nav-group-title", text: m }),
        el("ul", { class: "nav-list" }, ...days.map((d) => item(
          `${fmtDay(d.date, { weekday: "short", month: "short", day: "numeric" })}${d.date === state.day ? " (today)" : ""}`,
          d.date, d.count, d.date)))]));
  }

  const histMatch = (it, q) => !q || `${it.title} ${it.summary} ${it.cve || ""} ${sourcesOf(it).join(" ")}`.toLowerCase().includes(q);

  let histToken = 0; // ignores a slow load that finishes after the user has picked something else
  async function renderHistory() {
    renderDayNav();
    for (const b of document.querySelectorAll("[data-hkind]")) b.setAttribute("aria-pressed", String(b.dataset.hkind === state.hist.kind));
    const { range, kind } = state.hist;
    const dates = histDates(range);
    const box = $("#hist-list");
    $("#hist-title").textContent = range === WEEK ? `Last ${dates.length} days` : range === ALL ? `All ${dates.length} days`
      : fmtDay(range, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    if (!dates.length) {
      $("#hist-meta").textContent = "";
      box.replaceChildren(el("p", { class: "empty", text: "No days to show yet." }));
      return;
    }
    const token = ++histToken;
    const pending = dates.filter((d) => !dayCache.has(d) && d !== state.day).length;
    if (pending) {
      $("#hist-meta").textContent = `Loading ${plural(pending, "day", "days")}...`;
      box.replaceChildren();
    }
    let days;
    try {
      days = await Promise.all(dates.map(historyDay));
    } catch (e) {
      if (token === histToken) box.replaceChildren(el("p", { class: "empty", text: `Couldn't load history: ${e.message}` }));
      return;
    }
    if (token !== histToken) return;

    // Topic drop-down: every topic in the loaded days, A-Z
    const topics = [...new Set(days.flatMap((d) => (d.items || []).flatMap((it) => it.topics || [])))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const topicSel = $("#hist-topic");
    if (state.hist.topic && !topics.includes(state.hist.topic)) topics.unshift(state.hist.topic);
    topicSel.replaceChildren(el("option", { value: "", text: "All topics" }), ...topics.map((t) => el("option", { value: t, text: t })));
    topicSel.value = state.hist.topic;
    topicSel.disabled = kind === "cves";

    const q = state.hist.query.trim().toLowerCase();
    const searching = Boolean(q || (kind === "news" && state.hist.topic));
    const cap = dates.length === 1 || searching ? HIST_CAP_DAY : HIST_CAP_RANGE;
    let total = 0;
    const sections = days.map((d, i) => {
      const items = (d.items || []).filter((it) => (kind === "cves" ? isCve(it) : !isCve(it)) && isOn(it)
        && histMatch(it, q) && (kind === "cves" || !state.hist.topic || (it.topics || []).includes(state.hist.topic)))
        .sort(kind === "cves" ? byScore : rank);
      total += items.length;
      if (!items.length) return null;
      const list = (xs) => (kind === "cves" ? el("ul", { class: "cve-list" }, ...xs.map(cveRow)) : el("ul", { class: "rows" }, ...xs.map(row)));
      const first = items.slice(0, cap), rest = items.slice(cap);
      // The folded rows are only built when opened, so a long range stays quick to draw
      let built = false;
      const more = rest.length ? el("details", {
        class: "more",
        ontoggle: (e) => { if (!built) { e.target.append(list(rest)); built = true; } addMoreToggles(e.target); },
      }, el("summary", { text: `${rest.length} more from this day` })) : null;
      const one = kind === "cves" ? "critical CVE" : "story", many = kind === "cves" ? "critical CVEs" : "stories";
      return el("section", { class: "news-section" },
        el("div", { class: "section-head" },
          el("h2", { text: fmtDay(dates[i], { weekday: "long", month: "long", day: "numeric" }) }),
          el("span", { class: "muted", text: `${plural(items.length, one, many)}${kind === "cves" ? ", highest score first" : ", most reported first"}` })),
        list(first), more);
    }).filter(Boolean);

    const what = kind === "cves" ? plural(total, "critical CVE", "critical CVEs") : plural(total, "story", "stories");
    const filters = [state.hist.topic && kind === "news" ? `in ${state.hist.topic}` : "", q ? `matching "${state.hist.query.trim()}"` : ""].filter(Boolean).join(" ");
    $("#hist-meta").textContent = `${what}${filters ? ` ${filters}` : ""}. Each day lists the stories first fetched that day; sources switched off on the Sources tab stay hidden here too.`;
    box.replaceChildren(...(sections.length ? sections
      : [el("p", { class: "empty", text: searching ? "Nothing matches these filters." : "Nothing for these days." })]));
    addMoreToggles(box);
  }

  // With cap set, the first SECTION_CAP stories show and the rest fold into a "N more stories" drop-down
  function section(title, note, items, extra = [], cap = false) {
    const first = cap ? items.slice(0, SECTION_CAP) : items, over = cap ? items.slice(SECTION_CAP) : [];
    return el("section", { class: "news-section" },
      el("div", { class: "section-head" }, el("h2", { text: title }), el("span", { class: "muted", text: note })),
      storyList(first),
      ...(over.length ? [el("details", { class: "more", ontoggle: (e) => addMoreToggles(e.target) },
        el("summary", { text: `${over.length} more ${over.length === 1 ? "story" : "stories"}` }),
        storyList(over))] : []),
      ...extra,
    );
  }

  const storyList = (items) => (state.layout === "list"
    ? el("ul", { class: "rows" }, ...items.map(row))
    : el("div", { class: "cards" }, ...items.map(card)));

  // Every outlet covering a story, each linked to its own article (lead source first); starts hidden
  function sourcesPanel(it) {
    const all = [{ source: it.source, title: it.title, url: it.url }, ...(it.also_covered_by || [])];
    const ul = el("ul", { class: "also-list source-list" }, ...all.map(sourceLine));
    ul.hidden = true;
    return ul;
  }

  // One outlet's coverage: the whole "Source: headline" line links to that outlet's article
  const sourceLine = (c) => el("li", {},
    el("a", { href: safeUrl(c.url), target: "_blank", rel: "noopener noreferrer", title: `Open ${c.source}'s article` },
      el("span", { class: "source", text: `${c.source}: ` }), c.title));

  // Source-count pill colour: green for a few outlets up to red for many
  const heat = (n) => (n >= 6 ? "heat-4" : n >= 4 ? "heat-3" : n === 3 ? "heat-2" : "heat-1");

  // The "N sources" pill in List layout: a button that shows or hides the sources panel
  function sourcesToggle(n, panel) {
    const btn = el("button", { class: `count count-btn ${heat(n)}`, type: "button", "aria-expanded": "false", title: "Show the sources reporting this", text: `${n} sources ▾` });
    btn.addEventListener("click", () => {
      const open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = `${n} sources ${open ? "▴" : "▾"}`;
    });
    return btn;
  }

  // Compact layout: one line per story; the summary is in the headline's tooltip
  function row(it) {
    const also = it.also_covered_by || [];
    const n = coverage(it);
    const panel = n > 1 ? sourcesPanel(it) : null;
    const badges = [n > 1 ? sourcesToggle(n, panel) : null, kevBadge(it), cvssBadge(it), epssBadge(it)].filter(Boolean);
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
      panel,
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

  const hasCvssBadge = (it) => ((it.cves || [])[0]?.score || 0) >= HIGH_CVSS;
  function cvssBadge(it) {
    if (!hasCvssBadge(it)) return null;
    const top = it.cves[0];
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
        n > 1 ? el("span", { class: `count ${heat(n)}`, text: `${n} sources` }) : null,
        kevBadge(it),
        cvssBadge(it),
        epssBadge(it),
        el("span", { class: "source", text: it.source }),
        el("span", { text: fmtTime(it.published) }),
      ),
      el("h3", {}, link(it.url, it.title)),
      it.summary ? el("p", { class: "summary clamp", text: it.summary }) : null,
      also.length ? el("div", { class: "also-head", text: "Also reported by" }) : null,
      also.length ? el("ul", { class: "also-list" }, ...also.map(sourceLine)) : null,
      el("div", { class: "tags" }, ...it.topics.map((t) => el("span", { class: "tag", text: t }))),
    );
  }

  // Sources-tab search: every word must appear in one of the given fields (case-insensitive)
  function srcMatch(...fields) {
    const words = state.srcQuery.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = fields.filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  function renderSources() {
    const d = state.dayData || {};
    $("#sources-meta").textContent = !d.generated ? ""
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

    const shown = all.filter((s) => srcMatch(s.name, s.category, s.site, s.url));
    if (state.srcQuery.trim()) {
      $("#sources-switches").append(el("span", { class: "src-count", text: `${shown.length} of ${all.length} match "${state.srcQuery.trim()}".` }));
    }
    $("#sources-body").replaceChildren(...(shown.length ? [] : [el("tr", {}, el("td", { colspan: "6", class: "muted", text: "No source matches this search." }))]), ...shown.map((s) => {
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
    if (state.suggest) renderSuggestions(); else loadSuggestions();
  }

  // Add button: opens a pre-filled "Add source" issue; the add-source workflow test-fetches the feed and,
  // if it works, adds it to sources.json (only for issues the repository owner opens).
  const REPO = "Giles-de-Streel/it-news-digest";
  function addSourceUrl(c) {
    const feed = (c.feed && c.feed.url) || "";
    const src = { name: c.key, site: c.home || `https://${c.key}/`, url: feed, category: "IT industry" };
    const body = [
      `Suggested source: ${c.key}, linked ${c.mentions.length} times.`,
      "",
      "Check the JSON below before submitting: give it a proper `name`, pick a `category`"
        + (feed ? ", and confirm the feed `url`." : ", and put the site's RSS/Atom feed in `url` (no working feed was found automatically)."),
      "The Add source workflow test-fetches the feed and adds it to sources.json if it returns stories. Edit the issue to retry.",
      "",
      "```json", JSON.stringify(src, null, 2), "```",
    ].join("\n");
    return `https://github.com/${REPO}/issues/new?` + new URLSearchParams({ title: `Add source: ${c.key}`, body });
  }

  // Sites the aggregators (sources with "discover" in sources.json) link to often but no source covers yet
  const SUGGEST_MAX = 30;
  function renderSuggestions() {
    const s = state.suggest || {}, min = s.min_mentions || 3;
    const names = state.catalog.filter((c) => c.discover).map((c) => c.name);
    const via = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "the aggregator sources";
    // Only sites whose latest linked article was checked and found free to read
    const all = (s.candidates || []).filter((c) => c.mentions.length >= min && c.access === "free").slice(0, SUGGEST_MAX);
    const list = all.filter((c) => srcMatch(c.key, c.home, c.feed && c.feed.url, ...c.examples.map((e) => e.title)));
    $("#suggested").hidden = !s.generated;
    $("#suggested-meta").textContent = all.length && !list.length ? `None of the ${all.length} suggested sites match "${state.srcQuery.trim()}".`
      : list.length
      ? `Sites that ${via} linked to ${min} or more times in the last ${s.window_days} days, that no source covers yet and that are free to read (paywalled sites are left out), most-linked first. Nothing is added automatically: Add opens a pre-filled GitHub issue, and the Add source workflow test-fetches the feed and adds it to sources.json if it works.`
      : `No free-to-read site has been linked ${min} or more times yet. The list fills in as each fetch records links from ${via}.`;
    $("#suggested-body").replaceChildren(...list.map((c) => {
      const ex = c.examples[0];
      const feed = c.feed || {};
      return el("tr", {},
        el("td", {}, link(c.home, c.key)),
        el("td", { text: String(c.mentions.length) }),
        el("td", { class: "muted", text: [...new Set(c.mentions.map((m) => m[2]))].join(", ") }),
        el("td", {}, ex ? link(ex.url, ex.title) : ""),
        feed.url ? el("td", {}, link(feed.url, `Feed (${feed.items} items)`))
          : el("td", { class: "muted", text: feed.error || "Not checked yet" }),
        el("td", { class: "add" }, el("a", { class: "add-btn", href: addSourceUrl(c), target: "_blank", rel: "noopener noreferrer",
          text: "Add", title: feed.url ? `Open a GitHub issue to add ${c.key} with its feed` : `Open a GitHub issue to add ${c.key} (you'll need to supply its feed URL)` })),
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
    const sources = [...new Set(newsItems().flatMap(sourcesOf))].filter((s) => !state.off.has(s)).sort();
    const srcSel = $("#source-filter");
    srcSel.replaceChildren(el("option", { value: "", text: "All sources" }), ...sources.map((s) => el("option", { value: s, text: s })));
    srcSel.value = sources.includes(state.source) ? state.source : "";
    state.source = srcSel.value;
  }

  function setView(view) {
    state.view = view;
    store.set(LS_VIEW, view);
    history.replaceState(null, "", `${location.pathname}${location.search}${view === "news" ? "" : `#${view}`}`);
    render();
    window.scrollTo(0, 0);
  }

  // ---------- URL state ----------
  // The topic, source and search live in the address (?topic=AI&source=...&q=...), so a view
  // can be bookmarked or shared and the Back button steps through topic changes.
  function syncUrl(push) {
    const params = new URLSearchParams();
    if (state.topic) params.set("topic", state.topic);
    if (state.source) params.set("source", state.source);
    if (state.query) params.set("q", state.query);
    const qs = params.toString();
    const url = `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`;
    if (url === `${location.pathname}${location.search}${location.hash}`) return;
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }

  function readUrl() {
    const params = new URLSearchParams(location.search);
    state.topic = params.get("topic") || "";
    state.source = params.get("source") || "";
    state.query = params.get("q") || "";
    $("#search").value = state.query;
  }

  // ---------- small-screen topic panel and sticky offsets ----------
  // Height the sticky topbar covers; 0 on phones, where the topbar scrolls away (see style.css)
  const topbarHeight = () => {
    const bar = $(".topbar");
    return bar && getComputedStyle(bar).position === "sticky" ? bar.getBoundingClientRect().height : 0;
  };

  function toggleTopicPanel(open) {
    const nav = $("#topic-nav");
    const show = open ?? !nav.classList.contains("open");
    nav.classList.toggle("open", show);
    $("#topics-toggle").setAttribute("aria-expanded", String(show));
  }

  // The topbar wraps to two or three rows on narrow screens; sticky elements sit just below it
  function trackTopbar() {
    const set = () => document.documentElement.style.setProperty("--topbar-h", `${Math.ceil($(".topbar")?.getBoundingClientRect().height || 0)}px`);
    set();
    if ("ResizeObserver" in window) new ResizeObserver(set).observe($(".topbar"));
    else window.addEventListener("resize", set);
  }

  // The header goes back to the start: today's news as a list, all topics and sources, no search
  // The IT NEWS logo is "home": a full page reload (fresh data, and a new random set of header trees)
  // on today's News tab with filters cleared. Ctrl/Cmd/Shift/middle-click keep the browser's default.
  function goHome(e) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    store.set(LS_VIEW, "news");
    store.set(LS_LAYOUT, "list");
    location.assign(location.pathname); // drops ?filters and #tab
  }

  // Header animation on/off (match icon). The class is set before first paint by a script in <head>.
  function syncSceneToggle() {
    const on = !document.documentElement.classList.contains("scene-off");
    const b = $("#scene-toggle");
    b.setAttribute("aria-pressed", String(on));
    b.title = on ? "Turn the header animation off" : "Turn the header animation on";
  }

  // Colour mode (second match). html[data-theme] is set before first paint by a script in <head>.
  const themeNow = () => {
    const t = document.documentElement.getAttribute("data-theme");
    return THEMES.includes(t) ? t : "light";
  };
  function syncThemeToggle() {
    const t = themeNow(), next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    const b = $("#theme-toggle");
    b.dataset.mode = t;
    b.title = `${t[0].toUpperCase()}${t.slice(1)} mode: click for ${next} mode`;
    b.setAttribute("aria-label", `Colour mode: ${t}. Switch to ${next} mode`);
  }
  function setTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    syncThemeToggle();
  }

  // ---------- events ----------
  function wire() {
    $("#home").addEventListener("click", goHome);
    syncSceneToggle();
    syncThemeToggle();
    $("#theme-toggle").addEventListener("click", () => {
      const next = THEMES[(THEMES.indexOf(themeNow()) + 1) % THEMES.length];
      store.set(LS_THEME, next);
      setTheme(next);
    });
    // Until a mode is picked, follow the system setting when it changes
    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", (e) => {
      if (!THEMES.includes(store.get(LS_THEME, ""))) setTheme(e.matches ? "dark" : "light");
    });
    $("#scene-toggle").addEventListener("click", () => {
      const off = document.documentElement.classList.toggle("scene-off");
      store.set(LS_SCENE, !off);
      syncSceneToggle();
    });
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
    window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEWS.includes(v) && v !== state.view) setView(v); });
    $("#cve-search").addEventListener("input", (e) => { state.cveQuery = e.target.value; render(); });
    $("#src-search").addEventListener("input", (e) => { state.srcQuery = e.target.value; renderSources(); });
    $("#search").addEventListener("input", (e) => { state.query = e.target.value; syncUrl(false); render(); });
    $("#source-filter").addEventListener("change", (e) => { state.source = e.target.value; syncUrl(true); render(); window.scrollTo({ top: 0 }); });
    $("#topics-toggle").addEventListener("click", () => toggleTopicPanel());
    // A tap outside the open topic sheet closes it
    document.addEventListener("click", (e) => {
      if ($("#topic-nav").classList.contains("open") && !e.target.closest("#topic-nav, #topics-toggle")) toggleTopicPanel(false);
    });
    window.addEventListener("popstate", () => { readUrl(); populateFilters(); render(); });
    // "/" jumps to the search box (unless already typing somewhere); Escape closes the topic panel
    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        // On the Sources tab it searches the sources; everywhere else it jumps to the News search
        if (state.view === "sources") { $("#src-search").focus(); return; }
        if (state.view === "history") { $("#hist-search").focus(); return; }
        if (state.view !== "news") setView("news");
        $("#search").focus();
      } else if (e.key === "Escape") {
        toggleTopicPanel(false);
      }
    });
    document.querySelectorAll("[data-layout]").forEach((b) => b.addEventListener("click", () => {
      state.layout = b.dataset.layout;
      store.set(LS_LAYOUT, state.layout);
      render();
    }));
    $("#hist-search").addEventListener("input", (e) => { state.hist.query = e.target.value; renderHistory(); });
    $("#hist-topic").addEventListener("change", (e) => { state.hist.topic = e.target.value; renderHistory(); });
    document.querySelectorAll("[data-hkind]").forEach((b) => b.addEventListener("click", () => {
      state.hist.kind = b.dataset.hkind;
      renderHistory();
    }));
  }

  async function init() {
    wire();
    trackTopbar();
    readUrl();
    // A link like ...#cves opens that tab; otherwise reopen the last tab used
    const fromHash = location.hash.slice(1);
    const saved = store.get(LS_VIEW, "news");
    state.view = VIEWS.includes(fromHash) ? fromHash : VIEWS.includes(saved) ? saved : "news";
    state.layout = store.get(LS_LAYOUT, "list") === "cards" ? "cards" : "list";
    const off = store.get(LS_OFF, []);
    state.off = new Set(Array.isArray(off) ? off : []);
    await Promise.all([loadIndex(), loadCatalog()]);
    if (state.days.length) await loadDay(state.days[0].date);
    populateFilters();
    render();
  }

  init().catch((e) => { $("#news").replaceChildren(el("p", { class: "empty", text: `Couldn't load data: ${e.message}` })); });
})();

// Header scenery: replace the fixed extra trees with a fresh random set on every page load.
// The middle tree (no inline style) stays put: the dog stops there.
(() => {
  "use strict";
  const track = document.querySelector(".runner-track");
  const home = track && track.querySelector(".tree:not([style])");
  if (!track || !home) return;
  const SVG = {
    conifer: '<svg viewBox="0 0 12 24"><rect class="trunk" x="5.2" y="19" width="1.6" height="5" rx=".4"/><path class="leaves" d="M6 0 9.5 6.5H7.8l3 5H8.9L12 19.5H0l3.1-8H1.2l3-5H2.5z"/></svg>',
    round: '<svg viewBox="0 0 16 22"><rect class="trunk" x="7" y="13" width="2" height="9" rx=".6"/><path class="leaves" d="M8 1.5a4.2 4.2 0 0 1 4 3 3.6 3.6 0 0 1 2.2 6 3.4 3.4 0 0 1-3.4 4H5.2a3.4 3.4 0 0 1-3.4-4 3.6 3.6 0 0 1 2.2-6 4.2 4.2 0 0 1 4-3z"/></svg>',
  };
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const count = 9 + Math.floor(Math.random() * 6); // 9-14 trees
  const xs = [];
  for (let tries = 0; xs.length < count && tries < 500; tries++) {
    const x = rand(2, 98);
    // keep clear of the middle tree, and don't stack two trees on the same spot
    if (Math.abs(x - 50) < 3.5 || xs.some((o) => Math.abs(o - x) < 2.2)) continue;
    xs.push(x);
  }
  track.querySelectorAll(".tree[style]").forEach((t) => t.remove());
  for (const x of xs) {
    const conifer = Math.random() < 0.5;
    const tint = Math.random();
    // colour: round trees can turn autumn yellow/brown; any tree can take one of the two extra greens
    const colour = !conifer && tint < 0.15 ? "yellow" : !conifer && tint < 0.3 ? "brown"
      : tint < 0.5 ? "green2" : tint < 0.7 ? "green3" : "";
    const cls = ["tree", conifer ? "conifer" : "", colour, Math.random() < 0.4 ? "far" : ""];
    const t = document.createElement("div");
    t.className = cls.filter(Boolean).join(" ");
    t.style.setProperty("--x", `${x.toFixed(1)}%`);
    t.style.setProperty("--h", `${Math.round(rand(12, 26))}px`);
    t.innerHTML = conifer ? SVG.conifer : SVG.round; // constant markup, no feed data
    track.insertBefore(t, home);
  }

  // Sky: either a sun or a moon somewhere along the top, plus 1-3 slowly drifting clouds (behind the trees)
  const NS = "http://www.w3.org/2000/svg";
  const sky = (cls, viewBox, inner, styles) => {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("class", cls);
    s.setAttribute("viewBox", viewBox);
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = inner; // constant markup, no feed data
    Object.entries(styles).forEach(([k, v]) => s.style.setProperty(k, v));
    track.prepend(s);
    return s;
  };
  // Sun by day, moon by night (viewer's local time). It crosses the sky as the day or night goes on:
  // rising at the left, setting at the right (day 06:00-19:00, night 19:00-06:00).
  const now = new Date();
  const hrs = now.getHours() + now.getMinutes() / 60;
  const isDay = hrs >= 6 && hrs < 19;
  const progress = isDay ? (hrs - 6) / 13 : ((hrs + 24 - 19) % 24) / 11;
  const skyX = `${(6 + progress * 88).toFixed(1)}%`;
  if (isDay) {
    const rays = Array.from({ length: 8 }, (_, i) => { const a = (i * Math.PI) / 4; return `M${(6 * Math.cos(a)).toFixed(1)} ${(6 * Math.sin(a)).toFixed(1)}L${(8.6 * Math.cos(a)).toFixed(1)} ${(8.6 * Math.sin(a)).toFixed(1)}`; }).join("");
    sky("sky-sun", "-9 -9 18 18", `<path class="ray" d="${rays}"/><circle r="4.2"/>`, { "--x": skyX, "--s": `${Math.round(rand(11, 15))}px` });
  } else {
    sky("sky-moon", "-6 -6 12 12", '<path d="M2.2-5.2A5.6 5.6 0 1 0 5.4 2.6 4.4 4.4 0 0 1 2.2-5.2z"/>', { "--x": skyX, "--s": `${Math.round(rand(9, 12))}px` });
  }
  const clouds = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < clouds; i++) {
    sky("sky-cloud", "0 0 24 10", '<path d="M5 9.5h14.5a3.6 3.6 0 0 0 .4-7.2 4.6 4.6 0 0 0-8.6-.9A3.4 3.4 0 0 0 6.6 4 2.8 2.8 0 0 0 5 9.5z"/>',
      { "--x": `${rand(0, 92).toFixed(1)}%`, "--w": `${Math.round(rand(16, 28))}px`, "--y": `${rand(0, 5).toFixed(1)}px`,
        "--drift": `${Math.round(rand(10, 30)) * (Math.random() < 0.5 ? -1 : 1)}px`, "--dur": `${Math.round(rand(18, 40))}s` });
  }

  // Shrubs: a few low bushes in assorted colours, in front of the trees and behind the grass
  const pet1 = track.querySelector(".pet");
  const SHRUB = '<path d="M.6 9a3.4 3.4 0 0 1 2.9-5.3A4.4 4.4 0 0 1 11.4 2.4a3.5 3.5 0 0 1 4 6.6z"/>';
  const shrubs = 3 + Math.floor(Math.random() * 5); // 3-7
  for (let i = 0; i < shrubs; i++) {
    const s = document.createElementNS(NS, "svg");
    const w = Math.round(rand(8, 17));
    s.setAttribute("class", `shrub s${1 + Math.floor(Math.random() * 6)}${Math.random() < 0.35 ? " far" : ""}`);
    s.setAttribute("viewBox", "0 0 16 9");
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = SHRUB; // constant markup
    s.style.setProperty("--x", `${rand(1, 99).toFixed(1)}%`);
    s.style.setProperty("--w", `${w}px`);
    s.style.setProperty("--flip", Math.random() < 0.5 ? "-1" : "1");
    track.insertBefore(s, pet1);
  }

  // Grass: random tufts and patches along the ground line, in front of the trees but behind the dogs and runners
  const before = track.querySelector(".pet") || null;
  const patches = 5 + Math.floor(Math.random() * 6); // 5-10
  for (let i = 0; i < patches; i++) {
    const w = Math.round(rand(6, 36));
    const h = rand(3.5, 6.5);
    let d = "";
    for (let x = 0.8; x < w; x += rand(1.3, 2.6)) {
      const bh = h * rand(0.55, 1), lean = rand(-1.4, 1.4);
      d += `M${x.toFixed(1)} ${h.toFixed(1)}q${(lean * 0.3).toFixed(1)} ${(-bh * 0.6).toFixed(1)} ${lean.toFixed(1)} ${(-bh).toFixed(1)}`;
    }
    const g = document.createElementNS(NS, "svg");
    g.setAttribute("class", `grass g${1 + Math.floor(Math.random() * 3)}${Math.random() < 0.35 ? " far" : ""}`);
    g.setAttribute("viewBox", `0 0 ${w} ${h.toFixed(1)}`);
    g.setAttribute("aria-hidden", "true");
    g.style.setProperty("--x", `${rand(0, 100).toFixed(1)}%`);
    g.style.setProperty("--w", `${w}px`);
    g.style.setProperty("--h", `${h.toFixed(1)}px`);
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    g.appendChild(p);
    track.insertBefore(g, before);
  }

  // Rocks: small irregular stones of assorted sizes and colours, in front of the grass
  const rocks = 3 + Math.floor(Math.random() * 6); // 3-8
  for (let i = 0; i < rocks; i++) {
    const w = rand(3, 9);
    const h = w * rand(0.45, 0.75);
    // a lumpy dome: flat bottom, 5-7 random points over the top
    const n = 5 + Math.floor(Math.random() * 3);
    let d = `M0 ${h.toFixed(1)}`;
    for (let k = 0; k <= n; k++) {
      const a = Math.PI * (1 - k / n);
      d += `L${((w / 2) * (1 + Math.cos(a)) * rand(0.92, 1.0)).toFixed(1)} ${(h - h * Math.sin(a) * rand(0.75, 1.05)).toFixed(1)}`;
    }
    d += "Z";
    const r = document.createElementNS(NS, "svg");
    r.setAttribute("class", `rock r${1 + Math.floor(Math.random() * 5)}${Math.random() < 0.35 ? " far" : ""}`);
    r.setAttribute("viewBox", `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`);
    r.setAttribute("aria-hidden", "true");
    r.style.setProperty("--x", `${rand(1, 99).toFixed(1)}%`);
    r.style.setProperty("--w", `${w.toFixed(1)}px`);
    r.style.setProperty("--h", `${h.toFixed(1)}px`);
    const rp = document.createElementNS(NS, "path");
    rp.setAttribute("d", d);
    r.appendChild(rp);
    track.insertBefore(r, pet1);
  }

  // Birds: 1-4 little flapping birds crossing the sky at their own speed, height and direction
  const firstTree = track.querySelector(".tree");
  const birds = 1 + Math.floor(Math.random() * 4);
  for (let i = 0; i < birds; i++) {
    const b = document.createElement("div");
    b.className = "bird";
    b.setAttribute("aria-hidden", "true");
    b.innerHTML = '<svg viewBox="0 0 10 4"><path d="M.5 3Q2.6.4 5 2.8 7.4.4 9.5 3"/></svg>'; // constant markup
    const dur = Math.round(rand(14, 32));
    b.style.setProperty("--y", `${rand(1, 11).toFixed(1)}px`);
    b.style.setProperty("--bw", `${Math.round(rand(5, 9))}px`);
    b.style.setProperty("--dur", `${dur}s`);
    b.style.setProperty("--delay", `${(-rand(0, dur)).toFixed(1)}s`); // already mid-flight on load
    b.style.setProperty("--dir", Math.random() < 0.5 ? "normal" : "reverse");
    b.style.setProperty("--flap", `${rand(0.22, 0.4).toFixed(2)}s`);
    track.insertBefore(b, firstTree);
  }

  // The pup picks one of these trees to pee on while running back left (the first dog uses the middle
  // tree on the way right). Prefer trees that stay visible on phones and aren't too near either end.
  const pup = track.querySelector(".pet.pup");
  const trees = [...track.querySelectorAll(".tree[style]")].map((t) => ({ t, x: parseFloat(t.style.getPropertyValue("--x")) }));
  if (!pup || !trees.length) return;
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const mid = trees.filter((o) => o.x >= 12 && o.x <= 88);
  const pool = mid.filter((o) => !o.t.classList.contains("far"));
  const tree = pick(pool.length ? pool : mid.length ? mid : trees);
  tree.t.classList.remove("far"); // its tree must be there on phones too
  const x = Math.min(88, Math.max(12, tree.x));
  // runner turns at 46% and is back at the left by 86%: the pup runs left 46-84% with a 6% pee stop,
  // split so it keeps the same speed before and after the stop
  const a = +(46 + 32 * (100 - x) / 100).toFixed(2);
  const b = +(a + 6).toFixed(2);
  const spot = `calc(${x}% - 12px)`; // rear end (facing left) over the trunk
  const nods = (from, to) => { let s = ""; for (let p = from, up = true; p < to; p += 0.4, up = !up) s += `${p.toFixed(1)}% { transform: rotate(${up ? 62 : 72}deg); } `; return s; };
  const css = `
@keyframes pup-pace {
  0% { left: 4px; transform: scaleX(1); }
  36%, 45.99% { left: calc(100% - 60px); transform: scaleX(1); }
  46% { left: calc(100% - 60px); transform: scaleX(-1); }
  ${a}%, ${b}% { left: ${spot}; transform: scaleX(-1); }
  84%, 99.99% { left: 4px; transform: scaleX(-1); }
  100% { left: 4px; transform: scaleX(1); }
}
@keyframes pup-show-run { 0% { visibility: visible; } 36% { visibility: hidden; } 46% { visibility: visible; } ${a}% { visibility: hidden; } ${b}% { visibility: visible; } 84% { visibility: hidden; } }
@keyframes pup-show-stand { 0% { visibility: hidden; } 36% { visibility: visible; } 46% { visibility: hidden; } ${a}% { visibility: visible; } ${a + 1}% { visibility: hidden; } ${b - 0.5}% { visibility: visible; } ${b}% { visibility: hidden; } 84% { visibility: visible; } }
@keyframes pup-show-pee { 0% { visibility: hidden; } ${a + 1}% { visibility: visible; } ${b - 0.5}% { visibility: hidden; } }
@keyframes pup-sniff { 0%, 36.8% { transform: rotate(0deg); } ${nods(37, 44.6)} 45%, 85.8% { transform: rotate(0deg); } ${nods(86, 98)} 98.6%, 100% { transform: rotate(0deg); } }`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  pup.classList.add("ready");
})();
