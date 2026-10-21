// popup.js — Gemini Usage Meter toolbar popup.
// Opening the popup forces a fresh fetch, so the numbers are never older than
// the click that opened it.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let state = null;
  let showAllCounters = false;

  function send(msg) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r); }); }
      catch (_) { resolve(null); }
    });
  }

  // ---- formatting ---------------------------------------------------------------
  function level(p) {
    if (p == null) return "na";
    if (p >= 100) return "max";
    if (p >= 90) return "red";
    if (p >= 75) return "orange";
    if (p >= 50) return "amber";
    return "ok";
  }
  function pctText(p) {
    if (p == null) return "—";
    if (p > 0 && p < 1) return "<1%";
    return Math.round(Math.min(p, 100)) + "%";
  }
  function fmtDur(ms) {
    if (ms == null) return "";
    if (ms <= 0) return "now";
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return h + "h" + (mm ? " " + String(mm).padStart(2, "0") + "m" : "");
    const d = Math.floor(h / 24), hh = h % 24;
    return d + "d" + (hh ? " " + hh + "h" : "");
  }
  function fmtClock(ms) {
    const d = new Date(ms);
    const sameDay = new Date().toDateString() === d.toDateString();
    const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return sameDay ? "today " + t : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + ", " + t;
  }
  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    return Math.round(m / 60) + "h ago";
  }

  // ---- rendering ------------------------------------------------------------------
  function renderWindow(key, w, fc) {
    const pct = $(key + "-pct"), fill = $(key + "-fill"), sub = $(key + "-sub"), fce = $(key + "-fc");
    const card = $(key + "-card");
    if (!w) {
      card.classList.add("hidden");
      return;
    }
    card.classList.remove("hidden");
    const lvl = level(w.pct);
    pct.textContent = w.pct >= 100 ? "100%" : pctText(w.pct);
    pct.className = "pct lvl-" + lvl;
    fill.style.width = Math.min(100, w.pct || 0) + "%";
    fill.className = "bar-fill lvl-" + lvl;
    if (w.resetsAt) {
      const until = w.resetsAt - Date.now();
      sub.textContent = (w.pct >= 100 ? "Limit reached · resets " : "Resets ") + "in " + fmtDur(until) + " · " + fmtClock(w.resetsAt);
    } else {
      sub.textContent = "Reset time not reported";
    }
    if (fc && w.pct < 100) {
      fce.classList.remove("hidden");
      fce.textContent = `⏳ At this pace you'll hit 100% in ~${fmtDur(fc.msLeft)}, before it resets.`;
    } else fce.classList.add("hidden");
  }

  function renderCounters(usage) {
    const card = $("counters-card"), list = $("counters-list"), more = $("counters-more");
    const counters = usage && usage.counters ? Object.values(usage.counters).filter((c) => c.limit) : [];
    if (!counters.length || (usage.compute && !counters.some((c) => c.pct > 0))) {
      card.classList.add("hidden");
      return;
    }
    card.classList.remove("hidden");
    counters.sort((a, b) => b.pct - a.pct || (a.action - b.action));
    const used = counters.filter((c) => c.pct > 0);
    const shown = showAllCounters ? counters : (used.length ? used.slice(0, 6) : counters.slice(0, 4));
    list.textContent = "";
    for (const c of shown) {
      const row = document.createElement("div");
      row.className = "counter";
      const lvl = level(c.pct);
      const left = c.remaining != null && c.limit != null ? `${c.remaining} of ${c.limit} left` : "";
      const reset = c.resetsAt ? "resets in " + fmtDur(c.resetsAt - Date.now()) : "";
      row.innerHTML = `
        <span class="counter-name"></span>
        <span class="counter-pct pct lvl-${lvl}" style="font-size:12px"></span>
        <div class="bar"><div class="bar-fill lvl-${lvl}"></div></div>
        <span class="counter-sub"></span>`;
      row.querySelector(".counter-name").textContent = "Limit #" + c.action + (c.mode != null && c.mode !== 2 ? "·" + c.mode : "");
      row.querySelector(".counter-pct").textContent = pctText(c.pct);
      row.querySelector(".bar-fill").style.width = Math.min(100, c.pct) + "%";
      row.querySelector(".counter-sub").textContent = [left, reset].filter(Boolean).join(" · ");
      list.appendChild(row);
    }
    const hiddenCount = counters.length - shown.length;
    if (hiddenCount > 0 || showAllCounters) {
      more.classList.remove("hidden");
      more.textContent = showAllCounters ? "Show fewer" : `Show all ${counters.length} limits`;
    } else more.classList.add("hidden");
  }

  function render() {
    if (!state) return;
    const { usage, settings, page, lastError } = state;
    // strip toggle
    $("show-strip").checked = !!settings.stripEnabled;
    const dismissed = state.dismissedUntil && state.dismissedUntil > Date.now();
    $("show-strip-sub").textContent = !settings.stripEnabled ? "Off — numbers stay here and on the toolbar badge"
      : dismissed ? "Hidden until " + new Date(state.dismissedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + " (Reset brings it back)"
      : "Sits right above the chat box";

    // error / empty
    const banner = $("error-banner");
    banner.className = "banner hidden";
    if (lastError && lastError.error) {
      banner.classList.remove("hidden");
      if (lastError.error === "signed_out") {
        banner.innerHTML = 'Not signed in to Gemini in this browser. <a href="https://gemini.google.com/app" target="_blank" rel="noopener" style="color:inherit">Open Gemini</a> and sign in.';
      } else if (usage) {
        banner.classList.add("info");
        banner.textContent = "Couldn't refresh just now (" + lastError.error + "). Showing the last reading.";
      } else {
        banner.textContent = "Couldn't read usage (" + lastError.error + "). Open gemini.google.com and click refresh.";
      }
    }
    $("empty-hint").classList.toggle("hidden", !!usage || (lastError && lastError.error === "signed_out"));

    const comp = usage && usage.compute;
    const fc = (usage && usage.forecast) || {};
    if (usage) {
      renderWindow("short", comp && comp.short, fc.short);
      renderWindow("weekly", comp && comp.weekly, fc.weekly);
      if (!comp) { $("short-card").classList.add("hidden"); $("weekly-card").classList.add("hidden"); }
    } else {
      $("short-card").classList.toggle("hidden", !!(lastError && lastError.error));
      $("weekly-card").classList.toggle("hidden", !!(lastError && lastError.error));
    }
    renderCounters(usage);

    // meta pills
    const meta = $("meta");
    const pills = [];
    if (page && page.plan) {
      const p = page.plan;
      pills.push("Plan: " + ((p.work ? "Workspace " : "") + (p.tier || (p.work ? "" : "Free"))).trim());
    }
    if (page && page.model) pills.push("Mode: " + page.model);
    if (usage && usage.authuser) pills.push("Account /u/" + usage.authuser);
    if (usage && usage.kind === "none") pills.push("No limits reported");
    meta.textContent = "";
    for (const t of pills) { const s = document.createElement("span"); s.className = "pill"; s.textContent = t; meta.appendChild(s); }
    meta.classList.toggle("hidden", !pills.length);

    // fields
    document.querySelectorAll("[data-field]").forEach((i) => { i.checked = settings.stripFields[i.dataset.field] !== false; });
    document.querySelectorAll("[data-setting]").forEach((i) => { i.checked = !!settings[i.dataset.setting]; });

    // rate
    const rate = $("rate-btn");
    if (state.reviewUrl) { rate.href = state.reviewUrl; rate.classList.remove("hidden"); } else rate.classList.add("hidden");

    $("updated").textContent = usage && usage.fetchedAt
      ? "Updated " + ago(usage.fetchedAt) + (usage.source === "page" ? " · live from Gemini" : usage.source === "tab" ? " · via your Gemini tab" : "")
      : "";
  }

  // ---- actions ---------------------------------------------------------------------
  async function refresh() {
    const btn = $("refresh-btn");
    btn.classList.add("spin");
    $("brand-logo").classList.add("pulsing");
    const s = await send({ type: "refresh" });
    btn.classList.remove("spin");
    $("brand-logo").classList.remove("pulsing");
    if (s) { state = s; render(); }
  }
  async function save(patch) {
    const s = await send({ type: "save_settings", patch });
    if (s && state) { state.settings = s; render(); }
  }

  $("refresh-btn").addEventListener("click", refresh);
  $("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("show-strip").addEventListener("change", (e) => save({ stripEnabled: e.target.checked }));
  $("fields-toggle").addEventListener("click", () => {
    const p = $("fields-panel");
    const open = p.classList.contains("hidden");
    p.classList.toggle("hidden", !open);
    $("fields-toggle").setAttribute("aria-expanded", open ? "true" : "false");
  });
  $("fields-panel").addEventListener("change", (e) => {
    const i = e.target;
    if (i.dataset.field) save({ stripFields: { [i.dataset.field]: i.checked } });
    else if (i.dataset.setting) save({ [i.dataset.setting]: i.checked });
  });
  $("counters-more").addEventListener("click", () => { showAllCounters = !showAllCounters; render(); });
  $("test-btn").addEventListener("click", async () => {
    await send({ type: "test_notification" });
    const r = $("test-result");
    r.textContent = "Sent. If nothing appeared, check your system's notification settings for this browser.";
    r.classList.remove("hidden");
  });
  $("reset-btn").addEventListener("click", async () => {
    const s = await send({ type: "reset" });
    if (s) { state = s; render(); }
    const r = $("test-result");
    r.textContent = "Alerts re-armed and the strip is visible again.";
    r.classList.remove("hidden");
  });
  // Rate us: shown until the user rates anywhere (strip, card or here), then
  // hidden forever. The worker records it and opens the review page.
  $("rate-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    $("rate-btn").classList.add("hidden");
    await send({ type: "open_review" });
    window.close();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "state" && msg.state) { state = msg.state; render(); }
  });

  // first paint from cache, then a fresh fetch
  send({ type: "get_state" }).then((s) => { if (s) { state = s; render(); } refresh(); });
  setInterval(render, 30000);
})();

// ---- More tools drawer ---------------------------------------------------------------
(() => {
  const OPEN_KEY = "sh_tools_open";
  const TOOLS = [
    { name: "Screenshot with URL", desc: "Screenshots with the URL bar", url: "https://selectorshub.com/screenshot-with-url/" },
    { name: "TestCase Studio", desc: "Record test steps as you go", url: "https://selectorshub.com/testcase-studio/" },
    { name: "Check My Links", desc: "Find broken links in 1 click", url: "https://selectorshub.com/checkmylinks/" },
    { name: "SelectorsHub", desc: "XPath & Playwright locators", url: "https://selectorshub.com/selectorshub/" },
    { name: "Page Load Timer", desc: "Page load time, automatically", url: "https://selectorshub.com/page-load-timer/" },
    { name: "Auto Data Filler", desc: "Fill forms in one click", url: "https://selectorshub.com/auto-data-filler/" },
    { name: "Bookmarks Finder", desc: "Find any bookmark by typing", url: "https://www.selectorshub.com/bookmarks-finder/" },
    { name: "AnyFormat", desc: "Save images in any format", url: "https://www.selectorshub.com/anyformat/" }
  ];
  const utm = (u) => u + (u.includes("?") ? "&" : "?") + "utm_source=gemini-usage-meter&utm_medium=popup&utm_campaign=more-tools";
  const wrap = document.getElementById("sh-tools");
  const toggle = document.getElementById("sh-tools-toggle");
  const grid = document.getElementById("sh-tools-grid");
  const all = document.getElementById("sh-tools-all");
  all.href = utm("https://selectorshub.com/");
  let built = false;
  function build() {
    if (built) return; built = true;
    for (const t of TOOLS) {
      const a = document.createElement("a");
      a.className = "sh-t-card"; a.href = utm(t.url); a.target = "_blank"; a.rel = "noopener noreferrer";
      const n = document.createElement("span"); n.className = "sh-t-name"; n.textContent = t.name;
      const d = document.createElement("span"); d.className = "sh-t-desc"; d.textContent = t.desc;
      a.append(n, d); grid.appendChild(a);
    }
  }
  function setOpen(open, persist) {
    if (open) build();
    wrap.classList.toggle("sh-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (persist) try { chrome.storage.local.set({ [OPEN_KEY]: open }); } catch (_) {}
  }
  toggle.addEventListener("click", () => setOpen(!wrap.classList.contains("sh-open"), true));
  try { chrome.storage.local.get(OPEN_KEY, (o) => { if (o && o[OPEN_KEY]) setOpen(true, false); }); } catch (_) {}
})();
