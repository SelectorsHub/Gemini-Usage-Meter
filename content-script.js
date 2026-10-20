// content-script.js — Gemini Usage Meter, isolated world on gemini.google.com.
//
//  * Bridges page-injector.js (MAIN world) and the service worker:
//      - background asks "fetch_quota"  -> we ask the injector -> rows come back
//      - the app fetches its own quota -> injector sniffs it -> we forward it
//      - a reply finishes (StreamGenerate) -> we tell the worker and recount the chat
//  * Reports page facts the worker can't see: account index (/u/N), the mode
//    picker label (Fast / Thinking / Pro ...) and the plan badge (Plus / Pro /
//    Ultra, "Work" for Workspace).
//  * Draws the usage strip just above Gemini's chat box.
(() => {
  "use strict";
  if (window.__gumContent) return;
  window.__gumContent = true;

  const SRC_IN = "gum-injector";
  const SRC_OUT = "gum-cs";
  const PRODUCT_URL = "https://selectorshub.com/";
  const UTM = "utm_source=gemini-usage-meter&utm_campaign=more-tools&utm_medium=";

  const SH_TOOLS = [
    { icon: "screenshot-with-url", name: "Screenshot with URL", desc: "Screenshots with the URL bar", url: "https://selectorshub.com/screenshot-with-url/" },
    { icon: "testcase-studio", name: "TestCase Studio", desc: "Record test steps as you go", url: "https://selectorshub.com/testcase-studio/" },
    { icon: "check-my-links", name: "Check My Links", desc: "Find broken links in 1 click", url: "https://selectorshub.com/checkmylinks/" },
    { icon: "page-load-timer", name: "Page Load Timer", desc: "Page load time, automatically", url: "https://selectorshub.com/page-load-timer/" },
    { icon: "selectorshub", name: "SelectorsHub", desc: "XPath & Playwright locators", url: "https://selectorshub.com/selectorshub/" },
    { icon: "auto-data-filler", name: "Auto Data Filler", desc: "Fill forms in one click", url: "https://selectorshub.com/auto-data-filler/" },
    { icon: "modify-header", name: "Modify Header", desc: "Edit request & response headers", url: "https://selectorshub.com/modify-header/" },
    { icon: "anyformat", name: "AnyFormat", desc: "Save images in any format", url: "https://www.selectorshub.com/anyformat/" }
  ];
  function withUtm(url, medium) { return url + (url.includes("?") ? "&" : "?") + UTM + medium; }

  // ---------------------------------------------------------------------------
  // Bridge to the page
  // ---------------------------------------------------------------------------
  const pending = new Map();
  let reqSeq = 0;

  function askPage(type, timeoutMs) {
    return new Promise((resolve) => {
      const id = "q" + (++reqSeq) + "_" + Date.now();
      const t = setTimeout(() => { pending.delete(id); resolve({ error: "timeout" }); }, timeoutMs || 8000);
      pending.set(id, (d) => { clearTimeout(t); resolve(d); });
      window.postMessage({ source: SRC_OUT, type, id }, location.origin);
    });
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r); });
      } catch (_) { resolve(null); }   // extension reloaded: this script is orphaned
    });
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== SRC_IN) return;
    switch (d.type) {
      case "quota_result": {
        const fn = pending.get(d.id);
        if (fn) { pending.delete(d.id); fn(d); }
        break;
      }
      case "quota_sniffed":
        send({ type: "quota_sniffed", rows: d.rows, authuser: d.authuser });
        break;
      case "gen_done":
        send({ type: "gen_done" });
        scheduleChatCount(1500);
        break;
      case "gen_start":
        break;
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "fetch_quota") {
      askPage("fetch_quota", 8000).then((d) => {
        sendResponse({ rows: d.rows || null, error: d.rows ? null : (d.error || "no_rows"), complete: !!d.complete, authuser: d.authuser });
      });
      return true;
    }
    if (msg.type === "state") {
      applyState(msg.state);
    }
  });

  // ---------------------------------------------------------------------------
  // Page facts
  // ---------------------------------------------------------------------------
  function authIndex() {
    const m = location.pathname.match(/^\/u\/(\d+)(?=\/|$)/);
    return m ? Number(m[1]) : 0;
  }
  function textOf(sel) {
    const el = document.querySelector(sel);
    return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }
  function readModel() {
    let t = textOf('[data-test-id="bard-mode-menu-button"] .picker-primary-text');
    if (!t) {
      const b = document.querySelector('[data-test-id="bard-mode-menu-button"]');
      if (b) t = (b.innerText || "").split("\n")[0].trim();
    }
    return t.slice(0, 40);
  }
  function readPlan() {
    const tier = textOf(".mavatar-tier-label");
    const work = !!document.querySelector(".mavatar-enterprise-label");
    if (!tier && !work && !document.querySelector(".mavatar-tier-enterprise-labels")) return null;
    return { tier: tier || "", work };
  }

  let lastInfoKey = "";
  let pageInfo = { authuser: authIndex(), model: "", plan: null };
  function reportPageInfo() {
    const plan = readPlan();
    const info = {
      authuser: authIndex(),
      model: readModel() || pageInfo.model,
      plan: plan || pageInfo.plan
    };
    pageInfo = info;
    const key = JSON.stringify(info);
    if (key !== lastInfoKey) {
      lastInfoKey = key;
      send({ type: "page_info", info });
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // Chat size (estimate)
  // ---------------------------------------------------------------------------
  // Gemini re-reads the conversation with each turn, so the chat's size is what
  // every new message costs and the one usage number you can act on (start a
  // new chat). We count the turns that are on the page: prompts, replies (not
  // the "thinking" panel) and images at a flat 258 tokens each.
  const WIDE_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;
  const PIECE_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]+|\d+|\s{2,}|[^\sA-Za-z\d]+/g;
  const IMAGE_TOKENS = 258;

  function estimateTokens(str) {
    if (!str) return 0;
    let tokens = 0;
    const wide = str.match(WIDE_RE);
    if (wide) { tokens += wide.length; str = str.replace(WIDE_RE, " "); }
    const pieces = str.match(PIECE_RE);
    if (!pieces) return tokens;
    for (const p of pieces) {
      const c = p.charCodeAt(0);
      if (c <= 32) { tokens += 1; continue; }
      if (c >= 48 && c <= 57) { tokens += Math.ceil(p.length / 3); continue; }
      if (!/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/.test(p[0])) {
        tokens += /^[\x21-\x7e]+$/.test(p) ? Math.ceil(p.length / 2) : p.length;
        continue;
      }
      tokens += p.length <= 6 ? 1 : Math.ceil(p.length / 4.5);
    }
    return tokens;
  }

  function contentText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("model-thoughts, .thoughts-container, button, mat-icon, .gum-strip").forEach((n) => n.remove());
    return clone.textContent || "";
  }

  let chat = { id: null, total: 0, you: 0, gemini: 0, images: 0, turns: 0 };
  function chatIdFromUrl() {
    const m = location.pathname.match(/\/app\/([0-9a-f]{8,})/i) || location.pathname.match(/\/gem\/[^/]+\/([0-9a-f]{8,})/i);
    return m ? m[1] : null;
  }

  function countChat() {
    const id = chatIdFromUrl();
    const queries = document.querySelectorAll("user-query");
    const replies = document.querySelectorAll("model-response");
    let you = 0, gem = 0, images = 0;
    queries.forEach((q) => {
      const t = q.querySelector(".query-text") || q;
      you += estimateTokens(contentText(t));
      images += q.querySelectorAll("img").length;
    });
    replies.forEach((r) => {
      const mc = r.querySelectorAll("message-content");
      if (mc.length) mc.forEach((m) => { gem += estimateTokens(contentText(m)); });
      else gem += estimateTokens(contentText(r));
    });
    const imgTokens = images * IMAGE_TOKENS;
    chat = { id, you, gemini: gem, images, imgTokens, total: you + gem + imgTokens, turns: queries.length };
    render();
  }
  let chatTimer = null;
  function scheduleChatCount(ms) {
    clearTimeout(chatTimer);
    chatTimer = setTimeout(countChat, ms == null ? 800 : ms);
  }

  function contextWindow() {
    const plan = pageInfo.plan;
    if (!plan) return null;
    const t = (plan.tier || "").toLowerCase();
    if (/ultra|pro/.test(t)) return 1000000;
    if (/plus/.test(t)) return 128000;
    if (!t && !plan.work) return 32000;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  function fmtTokens(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    if (n < 1000) return String(n);
    if (n < 100000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    if (n < 1000000) return Math.round(n / 1000) + "K";
    return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
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
    if (!ms) return "";
    const d = new Date(ms);
    const sameDay = new Date().toDateString() === d.toDateString();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return sameDay ? time : d.toLocaleDateString([], { weekday: "short" }) + " " + time;
  }
  function pctText(p) {
    if (p == null) return "—";
    if (p > 0 && p < 1) return "<1%";
    return Math.round(Math.min(p, 100)) + "%";
  }
  function level(p) {
    if (p == null) return "na";
    if (p >= 100) return "max";
    if (p >= 90) return "red";
    if (p >= 75) return "orange";
    if (p >= 50) return "amber";
    return "ok";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------------------------------------------------------------------
  // Icons
  // ---------------------------------------------------------------------------
  let logoSeq = 0;
  function logoSvg(size) {
    const id = "gumlg" + (++logoSeq);
    return `<svg class="gum-logo-svg" viewBox="0 0 256 256" width="${size}" height="${size}" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="${id}o" gradientUnits="userSpaceOnUse" x1="40" y1="240" x2="230" y2="150">
          <stop offset="0" stop-color="#3B82F6"/><stop offset="0.55" stop-color="#7C6CF2"/><stop offset="1" stop-color="#B46CE0"/>
        </linearGradient>
      </defs>
      <g fill="none">
        <path class="gum-gauge-rest" d="M 46.325,236.800 A 168.960,168.960 0 0 1 209.920,25.600" stroke-width="40.96"/>
        <path d="M 46.325,236.800 A 168.960,168.960 0 0 1 76.345,91.094" stroke="url(#${id}o)" stroke-width="40.96"/>
        <polygon points="201.871,163.230 93.548,104.419 177.572,194.600" fill="url(#${id}o)" stroke="url(#${id}o)" stroke-width="3" stroke-linejoin="round"/>
        <circle cx="209.920" cy="194.560" r="42.240" fill="url(#${id}o)"/>
        <path d="M209.92,161.56A33,33 0 0 0 242.92,194.56A33,33 0 0 0 209.92,227.56A33,33 0 0 0 176.92,194.56A33,33 0 0 0 209.92,161.56Z" fill="#fff"/>
      </g></svg>`;
  }
  const ICON = {
    gear: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>',
    expand: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    chat: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    hourglass: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="13" height="13" fill="#fbbf24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>'
  };
  function ring(p, lvl) {
    const r = 6.5, c = 2 * Math.PI * r;
    const f = p == null ? 0 : Math.max(0, Math.min(1, p / 100));
    return `<svg class="gum-ring lvl-${lvl}" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="${r}" class="gum-ring-bg"/>
      <circle cx="8" cy="8" r="${r}" class="gum-ring-fg" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let state = null;
  let autoCollapsed = false;

  function applyState(s) {
    if (!s) return;
    state = s;
    render();
  }

  function settings() { return (state && state.settings) || { stripEnabled: true, stripFields: {} }; }
  function fieldOn(k) {
    const f = settings().stripFields || {};
    return f[k] !== false;
  }

  // ---------------------------------------------------------------------------
  // Mounting
  // ---------------------------------------------------------------------------
  let strip = null;

  function findComposer() {
    const area = document.querySelector("input-area-v2");
    if (area && area.parentElement) return { parent: area.parentElement, before: area };
    const ed = document.querySelector('rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"]');
    if (!ed) return null;
    const fs = ed.closest("fieldset") || ed.closest(".input-area") || ed.parentElement;
    return fs && fs.parentElement ? { parent: fs.parentElement, before: fs } : null;
  }

  function ensureMounted() {
    const s = settings();
    const dismissed = state && state.dismissedUntil && state.dismissedUntil > Date.now();
    if (!s.stripEnabled || dismissed) {
      if (strip && strip.isConnected) strip.remove();
      return false;
    }
    const spot = findComposer();
    if (!spot) return false;
    if (!strip) strip = buildStrip();
    if (strip.parentElement !== spot.parent || strip.nextElementSibling !== spot.before) {
      spot.parent.insertBefore(strip, spot.before);
      observeWidth();
    }
    return true;
  }

  function buildStrip() {
    const el = document.createElement("div");
    el.className = "gum-strip";
    el.setAttribute("role", "status");
    el.setAttribute("aria-label", "Gemini usage");
    el.addEventListener("click", onStripClick);
    return el;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function detectTheme() {
    if (document.body.classList.contains("dark-theme")) return "dark";
    if (document.body.classList.contains("light-theme")) return "light";
    const bg = getComputedStyle(document.body).backgroundColor || "";
    const m = bg.match(/\d+(\.\d+)?/g);
    if (m && m.length >= 3) {
      const [r, g, b] = m.map(Number);
      return (0.299 * r + 0.587 * g + 0.114 * b) < 128 ? "dark" : "light";
    }
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function windowSeg(key, label, shortLabel, w, fc, showReset) {
    if (!w) return "";
    const p = w.pct;
    const lvl = level(p);
    const until = w.resetsAt ? w.resetsAt - Date.now() : null;
    const resetTxt = w.resetsAt ? (key === "short" ? "Resets in " + fmtDur(until) : "Resets " + fmtClock(w.resetsAt)) : "";
    const tip = `${label}: ${pctText(p)} used` + (w.resetsAt ? `\nResets ${fmtClock(w.resetsAt)} (in ${fmtDur(until)})` : "") +
      (key === "short" ? "\nGemini refreshes this every 5 hours until you reach your weekly limit." : "");
    const fcHtml = fc && fieldOn("forecast") && p < 100
      ? `<span class="gum-fc lvl-${fc.msLeft < 20 * 60000 ? "red" : fc.msLeft < 60 * 60000 ? "orange" : "amber"}" title="At your current pace (${fc.ratePerHour}%/h) you'll hit the ${esc(label.toLowerCase())} in about ${fmtDur(fc.msLeft)}, before it resets.">${ICON.hourglass}<span>~${fmtDur(fc.msLeft)} left</span></span>`
      : "";
    return `<div class="gum-seg gum-seg-${key} lvl-${lvl}" title="${esc(tip)}">
        <span class="gum-lbl"><span class="gum-lbl-long">${esc(label)}</span><span class="gum-lbl-short">${esc(shortLabel)}</span>${fieldOn("usageBars") ? `<span class="gum-bar"><i style="width:${Math.min(100, p || 0)}%"></i></span>` : ""}</span>
        <span class="gum-pct">${p >= 100 ? "Limit reached" : pctText(p)}</span>
        ${p >= 100 && w.resetsAt ? `<span class="gum-back">back in ${esc(fmtDur(until))}</span>`
          : showReset && resetTxt ? `<span class="gum-dot">·</span><span class="gum-reset">${esc(resetTxt)}</span>` : ""}
        ${fcHtml}
      </div>`;
  }

  function featureSeg(c) {
    if (!c) return "";
    const until = c.resetsAt ? c.resetsAt - Date.now() : null;
    const left = c.limit != null && c.remaining != null ? `${c.remaining} of ${c.limit} left` : "";
    const tip = `Your tightest Gemini limit right now: ${pctText(c.pct)} used${left ? " (" + left + ")" : ""}` +
      (c.resetsAt ? `\nResets ${fmtClock(c.resetsAt)} (in ${fmtDur(until)})` : "") +
      "\nThis account is metered per feature. Google doesn't name the features in the data, so the popup lists them by id.";
    return `<div class="gum-seg gum-seg-feature lvl-${level(c.pct)}" title="${esc(tip)}">
        <span class="gum-lbl"><span class="gum-lbl-long">Top limit</span><span class="gum-lbl-short">Limit</span>${fieldOn("usageBars") ? `<span class="gum-bar"><i style="width:${Math.min(100, c.pct || 0)}%"></i></span>` : ""}</span>
        <span class="gum-pct">${pctText(c.pct)}</span>
        ${c.resetsAt && fieldOn("resetShort") ? `<span class="gum-dot">·</span><span class="gum-reset">Resets in ${fmtDur(until)}</span>` : ""}
      </div>`;
  }

  function chatSeg() {
    if (!fieldOn("chatTokens") || !chat.id || !chat.turns) return "";
    const win = contextWindow();
    const frac = win ? chat.total / win : 0;
    const lvl = frac >= 0.8 ? "orange" : frac >= 0.5 ? "amber" : "neutral";
    const tip = `This chat is about ${fmtTokens(chat.total)} tokens` + (win ? ` of your ${fmtTokens(win)} context window` : "") +
      `.\nGemini re-reads the whole chat with every message, so long chats use your limit faster. Start a new chat to reset this.` +
      `\n\nYou ~${fmtTokens(chat.you)} · Gemini ~${fmtTokens(chat.gemini)}` + (chat.images ? ` · ${chat.images} image${chat.images > 1 ? "s" : ""} ~${fmtTokens(chat.imgTokens)}` : "") +
      `\nEstimate from the turns loaded on the page; attached files, Gems instructions and very old turns aren't counted.`;
    return `<div class="gum-seg gum-seg-chat lvl-${lvl}" title="${esc(tip)}">
        <span class="gum-chat-ic">${ICON.chat}</span><span class="gum-lbl gum-chat-lbl">Chat</span>
        <span class="gum-pct">~${fmtTokens(chat.total)}</span>${win ? `<span class="gum-of">/ ${fmtTokens(win)}</span>` : ""}<span class="gum-tok-word">tokens</span>
      </div>`;
  }

  function modelSeg() {
    if (!fieldOn("model") || !pageInfo.model) return "";
    const plan = pageInfo.plan;
    const planTxt = plan ? [plan.work ? "Workspace" : "", plan.tier || (plan.work ? "" : "Free")].filter(Boolean).join(" ") : "";
    return `<div class="gum-seg gum-seg-model" title="${esc("Mode: " + pageInfo.model + (planTxt ? "\nPlan: " + planTxt : "") + "\nHeavier modes, long chats and tools like Deep Research use more of your limit.")}"><span class="gum-model">${esc(pageInfo.model)}</span></div>`;
  }

  function render() {
    if (!ensureMounted()) return;
    const s = settings();
    const u = state && state.usage;
    const err = state && state.lastError;
    const collapsed = s.stripCollapsed || autoCollapsed;
    strip.dataset.theme = detectTheme();
    strip.classList.toggle("gum-collapsed", !!collapsed);

    const comp = u && u.compute;
    const fc = (u && u.forecast) || {};
    const showShort = comp && comp.short && fieldOn("short");
    const showWeekly = comp && comp.weekly && fieldOn("weekly");
    const top = !comp && state && state.topCounter && fieldOn("feature") ? state.topCounter : null;
    const maxPct = Math.max((comp && comp.short && comp.short.pct) || 0, (comp && comp.weekly && comp.weekly.pct) || 0, (top && top.pct) || 0);

    let body = "";
    if (collapsed) {
      const chips = [];
      if (showShort) chips.push(`<span class="gum-chip lvl-${level(comp.short.pct)}" title="5-hour: ${pctText(comp.short.pct)}">${ring(comp.short.pct, level(comp.short.pct))}<b>5h</b> ${pctText(comp.short.pct)}</span>`);
      if (showWeekly) chips.push(`<span class="gum-chip lvl-${level(comp.weekly.pct)}" title="Weekly: ${pctText(comp.weekly.pct)}">${ring(comp.weekly.pct, level(comp.weekly.pct))}<b>W</b> ${pctText(comp.weekly.pct)}</span>`);
      if (top) chips.push(`<span class="gum-chip lvl-${level(top.pct)}">${ring(top.pct, level(top.pct))}${pctText(top.pct)}</span>`);
      if (fieldOn("chatTokens") && chat.id && chat.turns) chips.push(`<span class="gum-chip gum-chip-chat" title="Chat ~${fmtTokens(chat.total)} tokens">${ICON.chat} ~${fmtTokens(chat.total)}</span>`);
      body = `<button class="gum-logo" data-act="logo" title="Gemini Usage Meter · by SelectorsHub">${logoSvg(18, maxPct)}</button>
        ${chips.join("") || '<span class="gum-msg">—</span>'}
        <span class="gum-spacer"></span>
        ${autoCollapsed ? "" : `<button class="gum-btn" data-act="expand" title="Expand">${ICON.expand}</button>`}`;
    } else {
      const segs = [];
      if (err && err.error === "signed_out" && !u) {
        segs.push(`<span class="gum-msg">Sign in to Gemini to see your usage.</span>`);
      } else if (!u) {
        segs.push(`<span class="gum-msg">Reading your Gemini usage…</span>`);
      } else if (u.kind === "none") {
        segs.push(`<span class="gum-msg" title="Gemini didn't return any usage limits for this account.">No usage limits reported for this account</span>`);
      }
      if (showShort) segs.push(windowSeg("short", "5-hour", "5h", comp.short, fc.short, fieldOn("resetShort")));
      if (showWeekly) segs.push(windowSeg("weekly", "Weekly", "W", comp.weekly, fc.weekly, fieldOn("resetWeekly")));
      if (top) segs.push(featureSeg(top));
      const cs = chatSeg(); if (cs) segs.push(cs);
      const ms = modelSeg(); if (ms) segs.push(ms);
      const rate = state && state.reviewUrl
        ? `<button class="gum-rate" data-act="rate" title="Enjoying the meter? A review helps a lot.">${ICON.star}<span>Rate us</span></button>` : "";
      body = `<button class="gum-logo" data-act="logo" title="Gemini Usage Meter · offered by SelectorsHub. Click to try more free tools from us.">${logoSvg(18, maxPct)}</button>
        <span class="gum-by">by SelectorsHub</span>
        ${segs.map((x, i) => (i ? '<span class="gum-sep"></span>' : '<span class="gum-sep gum-sep-first"></span>') + x).join("")}
        <span class="gum-spacer"></span>
        ${rate}
        <button class="gum-btn" data-act="gear" title="Strip settings">${ICON.gear}</button>
        <button class="gum-btn" data-act="collapse" title="Collapse">${ICON.collapse}</button>
        <button class="gum-btn gum-close" data-act="close" title="Hide for 12 hours">${ICON.close}</button>`;
    }
    if (strip.__html !== body) {
      strip.innerHTML = `<div class="gum-row">${body}</div>`;
      strip.__html = body;
    }
    fit();
  }

  // ---------------------------------------------------------------------------
  // Fitting the strip into narrow composers
  // ---------------------------------------------------------------------------
  // Shed detail one level at a time (byline, model, reset text, long labels,
  // "tokens" word, chat label) until the row fits; if even that is too wide,
  // show the collapsed pill until room comes back. This is a layout state, the
  // user's collapse setting is untouched.
  const MAX_FIT = 6;
  let fitting = false;
  function overflowing() {
    const row = strip && strip.firstElementChild;
    return row ? row.scrollWidth > row.clientWidth + 1 : false;
  }
  function fit() {
    if (!strip || fitting) return;
    fitting = true;
    try {
      const s = settings();
      if (s.stripCollapsed) { strip.dataset.fit = "0"; return; }
      if (autoCollapsed) {
        // try to come back
        autoCollapsed = false; strip.__html = null;
        fitting = false; render(); fitting = true;
      }
      let lvl = 0;
      strip.dataset.fit = "0";
      while (overflowing() && lvl < MAX_FIT) { lvl++; strip.dataset.fit = String(lvl); }
      if (overflowing()) {
        autoCollapsed = true; strip.__html = null;
        fitting = false; render(); return;
      }
    } finally { fitting = false; }
  }

  let ro = null;
  let lastW = 0;
  function observeWidth() {
    if (ro) ro.disconnect();
    if (!window.ResizeObserver || !strip.parentElement) return;
    ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (Math.abs(w - lastW) < 4) return;
      lastW = w;
      strip.__html = null;
      render();
    });
    ro.observe(strip.parentElement);
  }

  // ---------------------------------------------------------------------------
  // Interactions
  // ---------------------------------------------------------------------------
  function saveSettings(patch) {
    return send({ type: "save_settings", patch }).then((s) => { if (s && state) { state.settings = s; strip && (strip.__html = null); render(); } });
  }

  function onStripClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const act = b.dataset.act;
    if (act === "collapse") saveSettings({ stripCollapsed: true });
    else if (act === "expand") saveSettings({ stripCollapsed: false });
    else if (act === "close") { send({ type: "dismiss_strip" }); strip.remove(); }
    else if (act === "gear") openGear(b);
    else if (act === "logo") {
      if (e.ctrlKey || e.metaKey) window.open(withUtm(PRODUCT_URL, "logo"), "_blank", "noopener");
      else openToolsMenu(b);
    } else if (act === "rate" && state && state.reviewUrl) {
      window.open(state.reviewUrl, "_blank", "noopener");
      send({ type: "rate_clicked" });
    }
  }

  // ---- popovers ------------------------------------------------------------
  let pop = null;
  function closePop() {
    if (pop) { pop.remove(); pop = null; }
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onEsc, true);
  }
  function outside(e) { if (pop && !pop.contains(e.target) && !e.target.closest(".gum-strip [data-act]")) closePop(); }
  function onEsc(e) { if (e.key === "Escape") closePop(); }

  function openPop(anchor, html, cls) {
    const wasSame = pop && pop.__anchor === anchor.dataset.act;
    closePop();
    if (wasSame) return null;
    pop = document.createElement("div");
    pop.className = "gum-pop " + (cls || "");
    pop.dataset.theme = detectTheme();
    pop.innerHTML = html;
    pop.__anchor = anchor.dataset.act;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
    let top = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    setTimeout(() => {
      document.addEventListener("mousedown", outside, true);
      document.addEventListener("keydown", onEsc, true);
    }, 0);
    return pop;
  }

  function openGear(anchor) {
    const s = settings();
    const row = (key, label, isSetting) => {
      const on = isSetting ? !!s[key] : fieldOn(key);
      return `<label class="gum-check"><input type="checkbox" data-${isSetting ? "setting" : "field"}="${key}" ${on ? "checked" : ""}/><span>${label}</span></label>`;
    };
    const p = openPop(anchor, `
      <div class="gum-pop-title">Show in strip</div>
      ${row("short", "5-hour limit")}
      ${row("weekly", "Weekly limit")}
      ${row("resetShort", "5-hour reset time")}
      ${row("resetWeekly", "Weekly reset time")}
      ${row("usageBars", "Usage bars")}
      ${row("forecast", "Limit forecast")}
      ${row("chatTokens", "Chat size (tokens)")}
      ${row("model", "Current mode")}
      ${row("feature", "Per-feature limit (older plans)")}
      <div class="gum-pop-sep"></div>
      ${row("notificationsEnabled", "Desktop notifications", true)}
      <div class="gum-pop-sep"></div>
      <button class="gum-pop-link" data-pop="options">All settings…</button>
      <button class="gum-pop-link" data-pop="hide">Hide strip for 12 hours</button>
    `, "gum-pop-gear");
    if (!p) return;
    p.addEventListener("change", (e) => {
      const i = e.target;
      if (i.dataset.field) saveSettings({ stripFields: { [i.dataset.field]: i.checked } });
      else if (i.dataset.setting) saveSettings({ [i.dataset.setting]: i.checked });
    });
    p.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pop]");
      if (!b) return;
      if (b.dataset.pop === "options") send({ type: "open_options" });
      if (b.dataset.pop === "hide") { send({ type: "dismiss_strip" }); strip && strip.remove(); }
      closePop();
    });
  }

  // Tool icons: fetched and inlined as data URLs. An <img src="chrome-extension://">
  // depends on the site's CSP allowing it; a data URL usually survives, and if
  // it doesn't, the initial-letter tile below shows instead.
  const iconCache = new Map();
  function toolIcon(name) {
    if (iconCache.has(name)) return iconCache.get(name);
    const p = fetch(chrome.runtime.getURL("icons/tools/" + name + ".png"))
      .then((r) => r.blob())
      .then((b) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); }))
      .catch(() => null);
    iconCache.set(name, p);
    return p;
  }

  function openToolsMenu(anchor) {
    const items = SH_TOOLS.map((t) => `
      <a class="gum-tool" href="${esc(withUtm(t.url, "logo-menu"))}" target="_blank" rel="noopener noreferrer">
        <span class="gum-tool-ic" data-icon="${t.icon}">${esc(t.name[0])}</span>
        <span class="gum-tool-txt"><b>${esc(t.name)}</b><small>${esc(t.desc)}</small></span>
      </a>`).join("");
    const p = openPop(anchor, `
      <div class="gum-pop-title">Free tools from SelectorsHub</div>
      <div class="gum-tools">${items}</div>
      <div class="gum-pop-sep"></div>
      <a class="gum-pop-link" href="${esc(withUtm("https://selectorshub.com/", "logo-menu-all"))}" target="_blank" rel="noopener noreferrer">See all 15+ free tools →</a>
    `, "gum-pop-tools");
    if (!p) return;
    p.querySelectorAll("[data-icon]").forEach((el) => {
      toolIcon(el.dataset.icon).then((src) => {
        if (!src) return;
        const img = new Image();
        img.alt = "";
        img.onload = () => { el.textContent = ""; el.appendChild(img); el.classList.add("has-img"); };
        img.src = src;
      });
    });
    p.addEventListener("click", (e) => { if (e.target.closest("a")) setTimeout(closePop, 0); });
  }

  // ---------------------------------------------------------------------------
  // Boot / observers
  // ---------------------------------------------------------------------------
  let lastPath = location.pathname;
  let moTimer = null;
  const mo = new MutationObserver((muts) => {
    // ignore our own nodes
    if (muts.every((m) => m.target === strip || (strip && strip.contains(m.target)) || (pop && pop.contains(m.target)))) return;
    if (moTimer) return;
    moTimer = setTimeout(() => {
      moTimer = null;
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        chat = { id: chatIdFromUrl(), total: 0, you: 0, gemini: 0, images: 0, turns: 0 };
        scheduleChatCount(1200);
        if (authIndex() !== pageInfo.authuser) reportPageInfo();
      }
      if (!strip || !strip.isConnected) render();
      reportPageInfo();
      scheduleChatCount(2500);
    }, 400);
  });

  function start() {
    mo.observe(document.documentElement, { childList: true, subtree: true });
    send({ type: "get_state" }).then((s) => {
      applyState(s);
      // Opening Gemini is the moment the numbers matter most: refresh if the
      // last reading is more than a minute old (the app's own quota call,
      // which we sniff, usually beats this anyway).
      const u = s && s.usage;
      if (!u || Date.now() - (u.fetchedAt || 0) > 60 * 1000) setTimeout(() => send({ type: "refresh" }), 1200);
    });
    reportPageInfo();
    scheduleChatCount(1500);
    // Reset countdowns tick.
    setInterval(() => { if (strip && strip.isConnected) { strip.__html = null; render(); } }, 30000);
    // Theme switches don't always mutate the tree we watch.
    if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { strip && (strip.__html = null); render(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
