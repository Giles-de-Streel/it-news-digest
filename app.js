// IT News Digest: review daily candidates, approve or reject them, and save
// decisions to data/vetting.json in the repo through the GitHub contents API.
// All feed text is rendered with textContent; links are limited to http(s).
(() => {
  "use strict";

  const VETTING_PATH = "data/vetting.json";
  const LS = { settings: "ind.settings", pending: "ind.pending", view: "ind.view" };

  const state = {
    days: [],
    day: null,
    dayData: null,
    vetting: {},        // id -> {status, at}
    vettingSha: null,
    pending: {},        // id -> {status, at} or {status: null} for undo
    view: "review",
    statusFilter: "pending",
    topic: "",
    source: "",
    query: "",
    focus: 0,
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

  // ---------- storage (wrapped: may be unavailable) ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  function defaultRepo() {
    const host = location.hostname.match(/^([^.]+)\.github\.io$/i);
    const seg = location.pathname.split("/").filter(Boolean)[0];
    return { owner: host ? host[1] : "Giles-de-Streel", repo: host && seg ? seg : "it-news-digest" };
  }
  function settings() {
    return { ...defaultRepo(), token: "", ...store.get(LS.settings, {}) };
  }

  // ---------- GitHub API ----------
  const b64encode = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

  async function gh(path, opts = {}) {
    const s = settings();
    const res = await fetch(`https://api.github.com/repos/${s.owner}/${s.repo}${path}`, {
      ...opts,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(s.token ? { Authorization: `Bearer ${s.token}` } : {}),
        ...(opts.headers || {}),
      },
      cache: "no-store",
    });
    return res;
  }

  async function loadVettingFromApi() {
    const res = await gh(`/contents/${VETTING_PATH}`);
    if (res.status === 404) return { data: { decisions: {} }, sha: null };
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const body = await res.json();
    return { data: JSON.parse(b64decode(body.content)), sha: body.sha };
  }

  async function loadVetting() {
    // With a token, read through the API (fresh, and gives the sha we need to save).
    // Without one, read the published file (may lag a few minutes behind a save).
    if (settings().token) {
      try {
        const { data, sha } = await loadVettingFromApi();
        state.vetting = data.decisions || {};
        state.vettingSha = sha;
        return;
      } catch (e) { toast(`Couldn't read decisions from GitHub (${e.message}); using published copy`); }
    }
    try {
      const res = await fetch(`${VETTING_PATH}?t=${Date.now()}`, { cache: "no-store" });
      state.vetting = res.ok ? (await res.json()).decisions || {} : {};
    } catch { state.vetting = {}; }
  }

  async function saveVetting() {
    const s = settings();
    if (!s.token) { openSettings("Add a token to save decisions to GitHub."); return; }
    const count = Object.keys(state.pending).length;
    if (!count) return;
    $("#save-btn").disabled = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        // Always merge onto the latest copy so a save from another device isn't lost
        const { data, sha } = await loadVettingFromApi();
        const decisions = { ...(data.decisions || {}) };
        for (const [id, d] of Object.entries(state.pending)) {
          if (d.status) decisions[id] = d; else delete decisions[id];
        }
        const content = JSON.stringify({ decisions: sortKeys(decisions) }, null, 1) + "\n";
        const res = await gh(`/contents/${VETTING_PATH}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `Vetting: ${count} decision${count === 1 ? "" : "s"} for ${state.day}`,
            content: b64encode(content),
            ...(sha ? { sha } : {}),
          }),
        });
        if (res.status === 409 || res.status === 422) continue; // sha moved underneath us, retry
        if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.json().catch(() => ({}))).message || ""}`);
        const body = await res.json();
        state.vetting = decisions;
        state.vettingSha = body.content.sha;
        state.pending = {};
        store.set(LS.pending, {});
        toast(`Saved ${count} decision${count === 1 ? "" : "s"}`);
        render();
        return;
      }
      throw new Error("the file kept changing, try again");
    } catch (e) {
      toast(`Save failed: ${e.message}`);
    } finally {
      $("#save-btn").disabled = false;
    }
  }

  const sortKeys = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

  // ---------- data ----------
  async function loadIndex() {
    const res = await fetch(`data/index.json?t=${Date.now()}`, { cache: "no-store" });
    state.days = res.ok ? (await res.json()).days || [] : [];
  }
  async function loadDay(day) {
    const res = await fetch(`data/days/${day}.json`, { cache: "no-store" });
    state.dayData = res.ok ? await res.json() : { items: [], sources: [] };
    state.day = day;
    state.focus = 0;
  }

  const statusOf = (id) => (id in state.pending ? state.pending[id].status : state.vetting[id]?.status) || "pending";

  function decide(id, status) {
    const saved = state.vetting[id]?.status || null;
    const target = status === "pending" ? null : status;
    if (target === saved) delete state.pending[id];
    else state.pending[id] = target ? { status: target, at: new Date().toISOString() } : { status: null };
    store.set(LS.pending, state.pending);
    render();
  }

  function visibleItems() {
    const q = state.query.toLowerCase();
    return (state.dayData?.items || []).filter((it) => {
      const st = statusOf(it.id);
      if (state.statusFilter !== "all" && st !== state.statusFilter) return false;
      if (state.topic && !it.topics.includes(state.topic)) return false;
      if (state.source && it.source !== state.source && !(it.also_covered_by || []).some((c) => c.source === state.source)) return false;
      if (q && !`${it.title} ${it.summary}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // ---------- rendering ----------
  const fmtTime = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const fmtDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  function render() {
    for (const tab of document.querySelectorAll(".tabs button")) tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
    for (const v of ["review", "digest", "sources"]) $(`#view-${v}`).hidden = state.view !== v;
    if (state.view === "review") renderReview();
    if (state.view === "digest") renderDigest();
    if (state.view === "sources") renderSources();
    renderSavebar();
  }

  function renderReview() {
    const items = state.dayData?.items || [];
    const counts = { pending: 0, approved: 0, rejected: 0, all: items.length };
    for (const it of items) counts[statusOf(it.id)]++;
    for (const [k, v] of Object.entries(counts)) $(`[data-count="${k}"]`).textContent = v;
    for (const b of document.querySelectorAll("#status-filter button")) b.classList.toggle("on", b.dataset.status === state.statusFilter);

    const topicCounts = {};
    for (const it of items) for (const t of it.topics) topicCounts[t] = (topicCounts[t] || 0) + 1;
    const chips = $("#topic-filter");
    chips.replaceChildren(
      el("button", { class: `chip${state.topic ? "" : " on"}`, text: "All topics", onclick: () => { state.topic = ""; render(); } }),
      ...Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) =>
        el("button", { class: `chip${state.topic === t ? " on" : ""}`, text: `${t} ${n}`, onclick: () => { state.topic = state.topic === t ? "" : t; render(); } })),
    );

    const list = visibleItems();
    state.focus = Math.min(state.focus, Math.max(0, list.length - 1));
    const cards = $("#cards");
    if (!list.length) {
      cards.replaceChildren(el("p", { class: "empty", text: items.length ? "Nothing matches these filters." : "No stories for this day yet." }));
      return;
    }
    cards.replaceChildren(...list.map((it, i) => card(it, i)));
  }

  function card(it, index) {
    const st = statusOf(it.id);
    const unsaved = it.id in state.pending;
    const also = (it.also_covered_by || []);
    return el("article", { class: `card st-${st}${index === state.focus ? " focus" : ""}`, "data-id": it.id, onclick: () => { state.focus = index; markFocus(); } },
      el("div", { class: "meta" },
        el("span", { class: "source", text: it.source }),
        el("span", { text: fmtTime(it.published) }),
        also.length ? el("span", { class: "also", text: `+${also.length} more source${also.length > 1 ? "s" : ""}` }) : null,
        unsaved ? el("span", { class: "unsaved", text: "unsaved" }) : null,
      ),
      el("h3", {}, el("a", { href: safeUrl(it.url), target: "_blank", rel: "noopener noreferrer", text: it.title })),
      it.summary ? el("p", { class: "summary", text: it.summary }) : null,
      also.length ? el("ul", { class: "also-list" }, ...also.map((c) =>
        el("li", {}, el("span", { class: "source", text: `${c.source}: ` }), el("a", { href: safeUrl(c.url), target: "_blank", rel: "noopener noreferrer", text: c.title })))) : null,
      el("div", { class: "card-foot" },
        el("div", { class: "tags" }, ...it.topics.map((t) => el("span", { class: "tag", text: t }))),
        el("div", { class: "actions" },
          st !== "pending" ? el("button", { class: "ghost", text: "Undo", onclick: (e) => { e.stopPropagation(); decide(it.id, "pending"); } }) : null,
          el("button", { class: `reject${st === "rejected" ? " on" : ""}`, text: "Reject", onclick: (e) => { e.stopPropagation(); decide(it.id, "rejected"); } }),
          el("button", { class: `approve${st === "approved" ? " on" : ""}`, text: "Approve", onclick: (e) => { e.stopPropagation(); decide(it.id, "approved"); } }),
        ),
      ),
    );
  }

  function markFocus() {
    document.querySelectorAll(".card").forEach((c, i) => c.classList.toggle("focus", i === state.focus));
    document.querySelectorAll(".card")[state.focus]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function approvedByTopic() {
    const groups = {};
    for (const it of state.dayData?.items || []) {
      if (statusOf(it.id) !== "approved") continue;
      (groups[it.topics[0]] ||= []).push(it);
    }
    return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  }

  function renderDigest() {
    $("#digest-title").textContent = state.day ? `IT news for ${fmtDay(state.day)}` : "IT news";
    const groups = approvedByTopic();
    const box = $("#digest");
    if (!groups.length) {
      box.replaceChildren(el("p", { class: "empty", text: "No approved stories yet. Approve stories on the Review tab and they show up here." }));
      return;
    }
    box.replaceChildren(...groups.map(([topic, items]) => el("section", { class: "digest-group" },
      el("h3", { text: topic }),
      el("ul", {}, ...items.map((it) => el("li", {},
        el("a", { href: safeUrl(it.url), target: "_blank", rel: "noopener noreferrer", text: it.title }),
        el("span", { class: "muted", text: ` (${[it.source, ...(it.also_covered_by || []).map((c) => c.source)].join(", ")})` }),
        it.summary ? el("p", { class: "summary", text: it.summary }) : null,
      ))),
    )));
  }

  function digestText(markdown) {
    const lines = [markdown ? `## IT news for ${fmtDay(state.day)}` : `IT news for ${fmtDay(state.day)}`, ""];
    for (const [topic, items] of approvedByTopic()) {
      lines.push(markdown ? `### ${topic}` : topic.toUpperCase());
      for (const it of items) {
        const sources = [it.source, ...(it.also_covered_by || []).map((c) => c.source)].join(", ");
        lines.push(markdown ? `- [${it.title.replace(/[[\]]/g, "")}](${safeUrl(it.url)}) (${sources})` : `- ${it.title} (${sources})\n  ${safeUrl(it.url)}`);
        if (it.summary) lines.push(`  ${it.summary}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  async function copyDigest(markdown) {
    if (!approvedByTopic().length) { toast("Nothing approved to copy"); return; }
    try { await navigator.clipboard.writeText(digestText(markdown)); toast("Copied"); }
    catch { toast("Clipboard not available in this browser"); }
  }

  function renderSources() {
    const d = state.dayData || {};
    $("#sources-meta").textContent = d.generated ? `Fetched ${fmtTime(d.generated)}, window ${d.window_hours} hours. ${(d.items || []).length} stories after removing duplicates.` : "";
    $("#sources-body").replaceChildren(...(d.sources || []).map((s) => el("tr", {},
      el("td", { text: s.source }),
      el("td", { text: String(s.fetched) }),
      el("td", { text: String(s.recent) }),
      el("td", { class: s.error ? "bad" : "good", text: s.error || "OK" }),
    )));
  }

  function renderSavebar() {
    const n = Object.keys(state.pending).length;
    $("#savebar").hidden = n === 0;
    $("#save-msg").textContent = `${n} unsaved decision${n === 1 ? "" : "s"}${settings().token ? "" : " (kept in this browser until you add a token)"}`;
  }

  function populateFilters() {
    const daySel = $("#day");
    daySel.replaceChildren(...state.days.map((d) => el("option", { value: d.date, text: `${d.date} (${d.count})` })));
    daySel.value = state.day || "";
    const sources = [...new Set((state.dayData?.items || []).flatMap((it) => [it.source, ...(it.also_covered_by || []).map((c) => c.source)]))].sort();
    const srcSel = $("#source-filter");
    srcSel.replaceChildren(el("option", { value: "", text: "All sources" }), ...sources.map((s) => el("option", { value: s, text: s })));
    srcSel.value = sources.includes(state.source) ? state.source : "";
    state.source = srcSel.value;
  }

  // ---------- settings ----------
  function openSettings(message) {
    const s = settings();
    $("#set-owner").value = s.owner;
    $("#set-repo").value = s.repo;
    $("#set-token").value = s.token;
    $("#set-status").textContent = message || (s.token ? "A token is saved in this browser." : "No token saved; you can review, but not save to GitHub.");
    $("#settings").showModal();
  }
  function readSettingsForm() {
    return { owner: $("#set-owner").value.trim(), repo: $("#set-repo").value.trim(), token: $("#set-token").value.trim() };
  }

  async function testSettings() {
    store.set(LS.settings, readSettingsForm());
    $("#set-status").textContent = "Checking…";
    try {
      const res = await gh("");
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const repo = await res.json();
      $("#set-status").textContent = repo.permissions?.push ? `OK: can write to ${repo.full_name}.` : `Read-only on ${repo.full_name}: the token needs Contents read and write.`;
    } catch (e) { $("#set-status").textContent = `Failed: ${e.message}`; }
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // ---------- events ----------
  function wire() {
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { state.view = b.dataset.view; store.set(LS.view, state.view); render(); }));
    document.querySelectorAll("#status-filter button").forEach((b) => b.addEventListener("click", () => { state.statusFilter = b.dataset.status; state.focus = 0; render(); }));
    $("#search").addEventListener("input", (e) => { state.query = e.target.value; state.focus = 0; render(); });
    $("#source-filter").addEventListener("change", (e) => { state.source = e.target.value; state.focus = 0; render(); });
    $("#day").addEventListener("change", async (e) => { await loadDay(e.target.value); populateFilters(); render(); });
    $("#copy-md").addEventListener("click", () => copyDigest(true));
    $("#copy-text").addEventListener("click", () => copyDigest(false));
    $("#save-btn").addEventListener("click", saveVetting);
    $("#discard-btn").addEventListener("click", () => { state.pending = {}; store.set(LS.pending, {}); render(); });
    $("#settings-btn").addEventListener("click", () => openSettings());
    $("#set-test").addEventListener("click", testSettings);
    $("#set-clear").addEventListener("click", () => { $("#set-token").value = ""; store.set(LS.settings, readSettingsForm()); $("#set-status").textContent = "Token removed from this browser."; });
    $("#set-save").addEventListener("click", async () => { store.set(LS.settings, readSettingsForm()); await loadVetting(); render(); });

    document.addEventListener("keydown", (e) => {
      if (state.view !== "review" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) || $("#settings").open) return;
      const list = visibleItems();
      const it = list[state.focus];
      const actions = {
        j: () => { state.focus = Math.min(list.length - 1, state.focus + 1); markFocus(); },
        k: () => { state.focus = Math.max(0, state.focus - 1); markFocus(); },
        a: () => it && decide(it.id, "approved"),
        r: () => it && decide(it.id, "rejected"),
        u: () => it && decide(it.id, "pending"),
        o: () => it && window.open(safeUrl(it.url), "_blank", "noopener"),
      };
      if (actions[e.key]) { e.preventDefault(); actions[e.key](); }
    });
    window.addEventListener("beforeunload", (e) => { if (Object.keys(state.pending).length && !settings().token) e.preventDefault(); });
  }

  async function init() {
    wire();
    state.pending = store.get(LS.pending, {});
    state.view = store.get(LS.view, "review");
    await Promise.all([loadIndex(), loadVetting()]);
    if (state.days.length) await loadDay(state.days[0].date);
    populateFilters();
    render();
  }

  init().catch((e) => { $("#cards").replaceChildren(el("p", { class: "empty", text: `Couldn't load data: ${e.message}` })); });
})();
