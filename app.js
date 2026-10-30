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
  const SECTION_CAP = 7; // stories shown per News section before the rest fold into "N more stories"
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
    layout: "list",
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
    for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(b.dataset.layout === state.layout));
    $("#cve-tab-count").textContent = cveItems().length ? String(cveItems().length) : "";
    const generated = state.dayData?.generated;
    $("#updated").textContent = generated ? `Updated ${fmtTime(generated)}` : "";
    $("#updated").title = generated ? `Last fetch for this day: ${new Date(generated).toLocaleString()}` : "";
    if (state.view === "news") renderNews();
    else if (state.view === "cves") renderCves();
    else renderSources();
  }

  // Full name and a one-line description for each topic pill, shown above the stories when it's picked.
  // Must match the TOPICS keys in scripts/fetch_news.py; an unknown topic falls back to its pill text.
  const TOPIC_INFO = {
    "Accessibility": ["Accessibility", "Web and digital accessibility: WCAG, Section 508, screen readers."],
    "AI": ["Artificial intelligence", "AI, machine learning, large language models and AI assistants."],
    "Backup & recovery": ["Backup and recovery", "Backups, disaster recovery, restores and business continuity."],
    "Cloud & infrastructure": ["Cloud and infrastructure", "Public cloud, virtualization, Kubernetes and data centers."],
    "Databases": ["Databases", "SQL Server, Oracle, PostgreSQL, MySQL and other database platforms."],
    "DevOps & SRE": ["DevOps and site reliability", "CI/CD, infrastructure as code, containers and Kubernetes, observability, platform engineering and incident practice."],
    "Development": ["Software development", "Programming languages, developer tools, source control and CI/CD."],
    "Embedded & IoT": ["Embedded systems and IoT", "Microcontrollers, firmware, RTOS, single-board computers and connected devices."],
    "Endpoint management": ["Endpoint management", "Intune, Configuration Manager, Autopilot, Jamf, device management and patching."],
    "Forensics & IR": ["Digital forensics and incident response", "Investigations, evidence collection, memory and disk analysis, IR write-ups."],
    "General IT": ["General IT", "Stories that don't match any of the other topics."],
    "Hardware": ["Hardware", "CPUs, GPUs, storage, servers, firmware and data center hardware."],
    "Higher education": ["Higher education", "Universities, campus IT, education technology and student data."],
    "ICS / OT": ["Industrial control systems and operational technology", "SCADA, PLCs, industrial networks, critical infrastructure and OT security."],
    "Identity & access": ["Identity and access", "Authentication, MFA, passkeys, SSO, SAML/OAuth and credentials."],
    "Linux & open source": ["Linux and open source", "Linux distributions, the kernel, open-source projects and tools."],
    "Microsoft & Windows": ["Microsoft and Windows", "Windows, Microsoft 365, Azure, Entra, Exchange, SQL Server and Defender."],
    "Networking": ["Networking", "Routers, firewalls, VPN, Wi-Fi, DNS and network vendors."],
    "Pen testing & red team": ["Penetration testing and red teaming", "Offensive security, exploits, C2 frameworks and bug bounties."],
    "Policy & regulation": ["Policy and regulation", "Laws, regulators, government action, lawsuits and fines."],
    "Ransomware & breaches": ["Ransomware and data breaches", "Ransomware attacks, breaches, leaks and extortion."],
    "Reverse engineering": ["Reverse engineering", "Decompiling, disassembly, fuzzing and malware analysis."],
    "Supply chain security": ["Software supply chain security", "Malicious packages, dependencies, SBOMs and open-source ecosystem security."],
    "System administration": ["System administration", "Running Windows, Microsoft 365 and Linux systems: AD, Group Policy, PowerShell, patching, releases and end-of-support dates."],
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
  async function goHome(e) {
    e.preventDefault();
    Object.assign(state, { topic: "", source: "", query: "", layout: "list" });
    store.set(LS_LAYOUT, "list");
    $("#search").value = "";
    syncUrl(true);
    const latest = state.days[0]?.date;
    if (latest && state.day !== latest) await loadDay(latest);
    populateFilters();
    setView("news");
  }

  // ---------- events ----------
  function wire() {
    $("#home").addEventListener("click", goHome);
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
    window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEWS.includes(v) && v !== state.view) setView(v); });
    $("#cve-search").addEventListener("input", (e) => { state.cveQuery = e.target.value; render(); });
    $("#search").addEventListener("input", (e) => { state.query = e.target.value; syncUrl(false); render(); });
    $("#source-filter").addEventListener("change", (e) => { state.source = e.target.value; syncUrl(true); render(); });
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
        if (state.view !== "news") setView("news");
        $("#search").focus();
      } else if (e.key === "Escape") {
        toggleTopicPanel(false);
      }
    });
    document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
      state.layout = b.dataset.layout;
      store.set(LS_LAYOUT, state.layout);
      render();
    }));
    $("#day").addEventListener("change", async (e) => { await loadDay(e.target.value); populateFilters(); render(); });
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
