// background.js — Gemini Usage Meter service worker.
//
// Where the numbers come from
// ---------------------------
// Gemini's own Settings > Usage limits page and its in-chat usage badge read
// BardFrontendService.CheckGeminiQuota (batchexecute rpcid "qpEbW"). Each row
// of the reply is:
//
//   [ [mode, action, ?],  unit,  percentUsed,  [resetEpochSec, nanos],  remaining,  limit ]
//
// * action 2 is the compute-based usage meter. It comes back once per window
//   ("unit"): the short window that refreshes every 5 hours, and the weekly
//   limit. This is exactly what Gemini's badge shows (it picks the higher one).
// * Other actions are per-feature counters (some Workspace and older plans are
//   still metered this way). Google does not label them in the reply, so we
//   show them by id rather than guess names.
//
// How we call it
// --------------
// Preferred: through an open gemini.google.com tab (page-injector.js makes the
// call in the page with the page's own tokens). Fallback when no Gemini tab is
// open: from here, after reading the tokens out of the /app HTML; a session
// declarativeNetRequest rule gives those requests a gemini.google.com Origin.
// The page also gets sniffed: whenever Gemini fetches its quota for itself, the
// content script forwards the rows, so the meter moves the moment the app's
// own badge would.

"use strict";

// ---- constants ------------------------------------------------------------
const POLL_ALARM = "gemini-usage-poll";
const DEFAULT_POLL_MINUTES = 1;
const IDLE_POLL_MINUTES = 5;              // when no Gemini tab is open
const TAB_FETCH_TIMEOUT_MS = 9000;
const TOKENS_TTL_MS = 25 * 60 * 1000;
const GEMINI_ORIGIN = "https://gemini.google.com";
const RPC_QUOTA = "qpEbW";
const COMPUTE_ACTION = 2;
const ARGS_COMPUTE = JSON.stringify([[[1, 2]]]);
const ARGS_ALL = "[]";
const SHORT_WINDOW_MAX_MS = 6 * 60 * 60 * 1000;   // a reset further away than this is the weekly one

// Store and site links.
const CHROME_REVIEW_URL = "https://chromewebstore.google.com/detail/gemini-usage-meter/mcdahaljogncagbhalakjnkgldplmoha/reviews";
const EDGE_REVIEW_URL = null;     // set once the Edge Add-ons listing exists; Edge falls back to the Chrome listing
const INSTALL_URL = "https://www.selectorshub.com/gemini-usage-meter-installed/";
const UNINSTALL_URL = "https://www.selectorshub.com/gemini-usage-meter-uninstalled/";

// ██ TEST BUILD — REVERT PROMPT_TEST to false before store packaging ██
// Wipes the rating prompt state on every install, update or "Reload" in
// chrome://extensions, so the rating flow can be replayed from the start.
// Pair with RATE_TEST = true in content-script.js.
const PROMPT_TEST = false;
const PROMPT_TEST_KEYS = ["rate_us_clicked", "rate_us_clicked_at", "rate_nudge_at", "rate_nudge_dismissals", "install_at"];

const DEFAULT_SETTINGS = {
  pollMinutes: DEFAULT_POLL_MINUTES,
  notificationsEnabled: true,
  thresholdsShort: [75, 90, 100],
  thresholdsWeekly: [75, 90, 100],
  forecastNotify: true,
  badge: "max",                   // max | short | weekly | off
  stripEnabled: true,
  stripCollapsed: false,
  stripFields: {
    short: true,
    weekly: true,
    resetShort: true,
    resetWeekly: true,
    usageBars: true,
    forecast: true,
    chatTokens: true,
    model: true,
    feature: true
  },
  autoScroll: false
};

const K = {
  settings: "settings",
  usage: "usage",
  page: "page_info",
  lastError: "last_error",
  fired: "fired_thresholds",
  history: "fc_history",
  tokens: "bg_tokens",
  rated: "rate_us_clicked",
  dismissedUntil: "strip_dismissed_until"
};

// ---- storage helpers --------------------------------------------------------
async function getLocal(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return o[key] === undefined ? fallback : o[key];
}
function setLocal(obj) { return chrome.storage.local.set(obj); }

async function getSettings() {
  const s = await getLocal(K.settings, {});
  return mergeSettings(s);
}
function mergeSettings(s) {
  const out = Object.assign({}, DEFAULT_SETTINGS, s || {});
  out.stripFields = Object.assign({}, DEFAULT_SETTINGS.stripFields, (s && s.stripFields) || {});
  if (!Array.isArray(out.thresholdsShort)) out.thresholdsShort = DEFAULT_SETTINGS.thresholdsShort;
  if (!Array.isArray(out.thresholdsWeekly)) out.thresholdsWeekly = DEFAULT_SETTINGS.thresholdsWeekly;
  out.pollMinutes = Math.max(1, Math.min(60, Number(out.pollMinutes) || DEFAULT_POLL_MINUTES));
  return out;
}
async function saveSettings(patch) {
  const cur = await getSettings();
  const next = mergeSettings(Object.assign({}, cur, patch, {
    stripFields: Object.assign({}, cur.stripFields, (patch && patch.stripFields) || {})
  }));
  await setLocal({ [K.settings]: next });
  return next;
}

// ---- parsing ----------------------------------------------------------------
function tsToMs(t) {
  if (!Array.isArray(t) || typeof t[0] !== "number") return null;
  return t[0] * 1000 + Math.round((t[1] || 0) / 1e6);
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function parseRow(r) {
  if (!Array.isArray(r)) return null;
  const ctx = Array.isArray(r[0]) ? r[0] : [];
  const action = num(ctx[1]);
  if (action == null) return null;
  return {
    mode: num(ctx[0]),
    action,
    unit: num(r[1]),
    pct: Math.max(0, num(r[2]) || 0),
    resetsAt: tsToMs(r[3]),
    remaining: num(r[4]),
    limit: num(r[5])
  };
}

// Split compute rows into the short (5-hour) window and the weekly one. The
// unit enum is 1 / 2 in today's app, but we cross-check against the reset
// distance so a renumbering can't swap the labels.
function classifyCompute(rows, now) {
  const comp = rows.filter((r) => r.action === COMPUTE_ACTION);
  if (!comp.length) return null;
  const byUnit = new Map();
  for (const r of comp) byUnit.set(r.unit, r);   // last wins
  const list = [...byUnit.values()].sort((a, b) => (a.resetsAt || 0) - (b.resetsAt || 0));
  let short = null, weekly = null;
  if (list.length >= 2) {
    short = list[0];
    weekly = list[list.length - 1];
  } else {
    const only = list[0];
    const dist = only.resetsAt ? only.resetsAt - now : 0;
    if (dist > SHORT_WINDOW_MAX_MS) weekly = only; else short = only;
  }
  const pick = (r) => r && { pct: r.pct, resetsAt: r.resetsAt, unit: r.unit };
  return { short: pick(short), weekly: pick(weekly) };
}

// Merge a fresh batch of rows into the stored usage. A sniffed page response
// may cover only some contexts, so per-feature counters merge by key and the
// compute meter is replaced only by a batch that carries it.
function mergeUsage(prev, rawRows, meta, now) {
  const rows = (rawRows || []).map(parseRow).filter(Boolean);
  // meta.full: the batch is a complete reading (both of our calls), so it
  // replaces what we had. Sniffed page responses are partial and merge.
  const sameAccount = prev && prev.authuser === meta.authuser;
  const keep = sameAccount && !meta.full;
  const next = {
    fetchedAt: now,
    source: meta.source,
    authuser: meta.authuser != null ? meta.authuser : (prev && prev.authuser) || 0,
    compute: keep ? prev.compute : null,
    counters: {}
  };
  if (keep && prev.counters) {
    for (const [k, c] of Object.entries(prev.counters)) {
      if (c.resetsAt && c.resetsAt < now) continue;      // that window is over
      next.counters[k] = c;
    }
  }
  const comp = classifyCompute(rows, now);
  if (comp) {
    next.compute = {
      short: comp.short || (next.compute && next.compute.short) || null,
      weekly: comp.weekly || (next.compute && next.compute.weekly) || null
    };
  }
  // A window whose reset time has passed is back to 0.
  if (next.compute) {
    for (const k of ["short", "weekly"]) {
      const w = next.compute[k];
      if (w && w.resetsAt && w.resetsAt < now) next.compute[k] = Object.assign({}, w, { pct: 0, stale: true });
    }
  }
  for (const r of rows) {
    if (r.action === COMPUTE_ACTION) continue;
    const key = r.mode + ":" + r.action + ":" + r.unit;
    next.counters[key] = r;
  }
  next.kind = next.compute ? "compute" : (Object.keys(next.counters).length ? "counters" : "none");
  return next;
}

function topCounter(usage) {
  if (!usage || !usage.counters) return null;
  let best = null;
  for (const c of Object.values(usage.counters)) {
    if (!c.limit) continue;
    if (!best || c.pct > best.pct) best = c;
  }
  return best;
}

// ---- forecast -------------------------------------------------------------
// Pace from recent samples; only shown when the window would run out before
// it resets. Needs ~12 minutes of data so a single burst doesn't cry wolf.
const FC_MIN_SPAN_MS = 12 * 60 * 1000;
const FC_LOOKBACK_MS = 60 * 60 * 1000;
const FC_MIN_RATE = 0.5;     // %/h
const FC_NOTIFY_MIN = 30;

async function updateForecast(usage, now) {
  const hist = await getLocal(K.history, {});
  const out = {};
  for (const scope of ["short", "weekly"]) {
    const w = usage.compute && usage.compute[scope];
    let h = hist[scope] || { resetsAt: null, samples: [] };
    if (!w) { out[scope] = null; continue; }
    // A new window (reset moved by > 10 min) starts a fresh history.
    if (!h.resetsAt || !w.resetsAt || Math.abs(h.resetsAt - w.resetsAt) > 10 * 60 * 1000) {
      h = { resetsAt: w.resetsAt, samples: [] };
    }
    const last = h.samples[h.samples.length - 1];
    if (!last || now - last.t > 30 * 1000 || last.p !== w.pct) h.samples.push({ t: now, p: w.pct });
    const lookback = scope === "short" ? FC_LOOKBACK_MS : 6 * FC_LOOKBACK_MS;
    h.samples = h.samples.filter((s) => now - s.t <= lookback).slice(-240);
    hist[scope] = h;
    out[scope] = computeForecast(h.samples, w, now);
  }
  await setLocal({ [K.history]: hist });
  return out;
}

function computeForecast(samples, w, now) {
  if (!samples.length || w.pct >= 100 || !w.resetsAt) return null;
  const first = samples[0];
  const span = now - first.t;
  if (span < FC_MIN_SPAN_MS) return null;
  // least-squares slope, % per ms
  const n = samples.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) { const x = s.t - first.t; sx += x; sy += s.p; sxx += x * x; sxy += x * s.p; }
  const den = n * sxx - sx * sx;
  let slope = den ? (n * sxy - sx * sy) / den : 0;
  if (n < 3) slope = (samples[n - 1].p - first.p) / Math.max(1, span);
  const perHour = slope * 3600 * 1000;
  if (!(perHour > FC_MIN_RATE)) return null;
  const msLeft = ((100 - w.pct) / perHour) * 3600 * 1000;
  const untilReset = w.resetsAt - now;
  if (msLeft >= untilReset) return null;
  return { msLeft: Math.round(msLeft), runsOutAt: now + Math.round(msLeft), ratePerHour: Math.round(perHour * 10) / 10 };
}

// ---- notifications ----------------------------------------------------------
function notify(id, title, message) {
  return new Promise((resolve) => {
    try {
      chrome.notifications.create(id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title, message, priority: 1
      }, () => { void chrome.runtime.lastError; resolve(); });
    } catch (_) { resolve(); }
  });
}

function fmtReset(ms) {
  if (!ms) return "";
  const d = ms - Date.now();
  if (d <= 0) return "now";
  const m = Math.round(d / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return h + "h " + String(mm).padStart(2, "0") + "m";
  const days = Math.floor(h / 24), hh = h % 24;
  return days + "d " + hh + "h";
}

async function maybeNotify(usage, forecast, settings) {
  if (!settings.notificationsEnabled || !usage.compute) return;
  const fired = await getLocal(K.fired, {});
  let changed = false;
  const scopes = [
    ["short", "5-hour limit", settings.thresholdsShort],
    ["weekly", "Weekly limit", settings.thresholdsWeekly]
  ];
  for (const [scope, label, thresholds] of scopes) {
    const w = usage.compute[scope];
    if (!w) continue;
    const key = scope + ":" + (w.resetsAt ? Math.round(w.resetsAt / 600000) : "x");
    const done = fired[key] || [];
    const due = (thresholds || []).filter((t) => w.pct >= t && !done.includes(t)).sort((a, b) => b - a);
    if (due.length) {
      const t = due[0];
      const msg = t >= 100
        ? `You've used all of your Gemini ${label.toLowerCase()}. It resets in ${fmtReset(w.resetsAt)}.`
        : `You've used ${Math.round(w.pct)}% of your Gemini ${label.toLowerCase()}. Resets in ${fmtReset(w.resetsAt)}.`;
      await notify("gum-" + key + "-" + t, `Gemini ${label}: ${Math.round(w.pct)}%`, msg);
      fired[key] = done.concat(due);
      changed = true;
    }
    const f = forecast && forecast[scope];
    const fkey = key + ":fc";
    if (settings.forecastNotify && f && f.msLeft <= FC_NOTIFY_MIN * 60000 && !fired[fkey]) {
      await notify("gum-" + fkey, `Gemini ${label}: ~${Math.max(1, Math.round(f.msLeft / 60000))}m left at this pace`,
        `At your current pace you'll hit the ${label.toLowerCase()} before it resets in ${fmtReset(w.resetsAt)}.`);
      fired[fkey] = [1];
      changed = true;
    }
  }
  if (changed) {
    // keep the map small
    const keys = Object.keys(fired);
    if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete fired[k];
    await setLocal({ [K.fired]: fired });
  }
}

// ---- toolbar badge ----------------------------------------------------------
function levelColor(p) {
  if (p >= 90) return "#ef4444";
  if (p >= 75) return "#f97316";
  if (p >= 50) return "#f59e0b";
  return "#3b82f6";
}
async function updateBadge(usage, settings) {
  try {
    let p = null;
    if (settings.badge !== "off" && usage) {
      const c = usage.compute;
      if (c) {
        if (settings.badge === "short") p = c.short && c.short.pct;
        else if (settings.badge === "weekly") p = c.weekly && c.weekly.pct;
        else p = Math.max((c.short && c.short.pct) || 0, (c.weekly && c.weekly.pct) || 0);
      } else {
        const t = topCounter(usage);
        if (t && t.pct > 0) p = t.pct;
      }
    }
    if (p == null) { await chrome.action.setBadgeText({ text: "" }); return; }
    const txt = p >= 100 ? "MAX" : String(Math.round(p));
    await chrome.action.setBadgeText({ text: txt });
    await chrome.action.setBadgeBackgroundColor({ color: levelColor(p) });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  } catch (_) {}
}

// ---- fetching: via an open Gemini tab ---------------------------------------
async function geminiTabs() {
  try { return await chrome.tabs.query({ url: GEMINI_ORIGIN + "/*" }); } catch (_) { return []; }
}

function authOfUrl(url) {
  const m = /^https:\/\/gemini\.google\.com\/u\/(\d+)(?:\/|$)/.exec(url || "");
  return m ? Number(m[1]) : 0;
}

function sendToTab(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ error: "timeout" }); } }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (done) return;
        done = true; clearTimeout(t);
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
        else resolve(resp || { error: "no_response" });
      });
    } catch (e) { done = true; clearTimeout(t); resolve({ error: String(e) }); }
  });
}

async function fetchViaTab(preferAuth) {
  const tabs = await geminiTabs();
  if (!tabs.length) return null;
  tabs.sort((a, b) => {
    const ma = authOfUrl(a.url) === preferAuth ? 1 : 0, mb = authOfUrl(b.url) === preferAuth ? 1 : 0;
    if (ma !== mb) return mb - ma;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  let lastErr = null;
  for (const tab of tabs.slice(0, 3)) {
    const r = await sendToTab(tab.id, { type: "fetch_quota" }, TAB_FETCH_TIMEOUT_MS);
    if (r && Array.isArray(r.rows)) {
      return { rows: r.rows, complete: !!r.complete, authuser: r.authuser != null ? r.authuser : authOfUrl(tab.url), source: "tab" };
    }
    lastErr = (r && r.error) || "empty";
    if (lastErr === "signed_out") return { error: "signed_out" };
  }
  return { error: lastErr || "tab_failed" };
}

// ---- fetching: directly from the service worker ------------------------------
async function installOriginRule() {
  try {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "origin", operation: "set", value: GEMINI_ORIGIN },
            { header: "referer", operation: "set", value: GEMINI_ORIGIN + "/app" }
          ]
        },
        condition: {
          urlFilter: "|https://gemini.google.com/",
          tabIds: [chrome.tabs.TAB_ID_NONE],
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ["xmlhttprequest"]
        }
      }]
    });
  } catch (e) {
    console.warn("[GUM] origin rule failed", e);
  }
}

function prefixFor(authuser) { return authuser ? "/u/" + authuser : ""; }

async function getTokens(authuser, force) {
  const cache = await getLocal(K.tokens, {});
  const c = cache[authuser];
  if (!force && c && Date.now() - c.at < TOKENS_TTL_MS) return c;
  const res = await fetch(GEMINI_ORIGIN + prefixFor(authuser) + "/app", { credentials: "include", redirect: "follow" });
  if (!res.ok) throw new Error("http_" + res.status);
  if (/accounts\.google\.com/.test(res.url)) throw new Error("signed_out");
  const html = await res.text();
  const grab = (k) => { const m = new RegExp('"' + k + '":"([^"]*)"').exec(html); return m ? m[1] : null; };
  const t = { at: Date.now(), xsrf: grab("SNlM0e"), bl: grab("cfb2h"), sid: grab("FdrFJe") };
  if (!t.xsrf) throw new Error("signed_out");
  cache[authuser] = t;
  await setLocal({ [K.tokens]: cache });
  return t;
}

function parseBatch(text) {
  const rows = [];
  let saw = false, error = null;
  for (const line of String(text || "").split("\n")) {
    const s = line.trim();
    if (!s.startsWith("[")) continue;
    let arr; try { arr = JSON.parse(s); } catch (_) { continue; }
    for (const env of arr || []) {
      if (!Array.isArray(env) || env[0] !== "wrb.fr" || env[1] !== RPC_QUOTA) continue;
      saw = true;
      if (Array.isArray(env[5])) { error = env[5][0]; continue; }
      try { const d = JSON.parse(env[2]); if (Array.isArray(d) && Array.isArray(d[0])) rows.push(...d[0]); } catch (_) {}
    }
  }
  return { saw, rows, error };
}

let bgReq = Math.floor(Math.random() * 9000) + 1000;
async function bgCall(authuser, tokens, args) {
  const qs = new URLSearchParams({
    rpcids: RPC_QUOTA, "source-path": "/app", bl: tokens.bl || "", "f.sid": tokens.sid || "",
    hl: "en", _reqid: String((bgReq += 100000)), rt: "c"
  });
  const body = new URLSearchParams({ "f.req": JSON.stringify([[[RPC_QUOTA, args, null, "generic"]]]), at: tokens.xsrf });
  const res = await fetch(GEMINI_ORIGIN + prefixFor(authuser) + "/_/BardChatUi/data/batchexecute?" + qs, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
    body
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error("auth_" + res.status);
  if (!res.ok) throw new Error("http_" + res.status);
  return parseBatch(await res.text());
}

async function fetchDirect(authuser) {
  let tokens = await getTokens(authuser, false);
  const run = async () => {
    const [a, b] = await Promise.allSettled([bgCall(authuser, tokens, ARGS_COMPUTE), bgCall(authuser, tokens, ARGS_ALL)]);
    if (a.status === "rejected" && b.status === "rejected") throw a.reason;
    const rows = [];
    let complete = true;
    for (const r of [a, b]) {
      if (r.status !== "fulfilled" || !r.value.saw || r.value.error != null) { complete = false; continue; }
      rows.push(...r.value.rows);
    }
    if (!rows.length && !complete) throw new Error("no_rows");
    return { rows, complete };
  };
  let out;
  try {
    out = await run();
  } catch (e) {
    // stale XSRF token: refresh once
    tokens = await getTokens(authuser, true);
    out = await run();
  }
  return { rows: out.rows, complete: out.complete, authuser, source: "background" };
}

// ---- the poll ------------------------------------------------------------------
let polling = null;

async function pollUsage(reason) {
  if (polling) return polling;
  polling = (async () => {
    const page = await getLocal(K.page, {});
    const prefer = page.authuser != null ? page.authuser : 0;
    let result = await fetchViaTab(prefer);
    if (!result || (result.error && result.error !== "signed_out")) {
      try { result = await fetchDirect(prefer); }
      catch (e) { result = { error: String((e && e.message) || e) }; }
    }
    if (!result || result.error) {
      const err = result ? result.error : "unknown";
      await setLocal({ [K.lastError]: { at: Date.now(), error: /signed_out|auth_/.test(err) ? "signed_out" : err } });
      await broadcast();
      return;
    }
    await applyRows(result.rows, { source: result.source, authuser: result.authuser, full: !!result.complete });
  })().finally(() => { polling = null; });
  return polling;
}

async function applyRows(rows, meta) {
  const now = Date.now();
  const prev = await getLocal(K.usage, null);
  const usage = mergeUsage(prev, rows, meta, now);
  const settings = await getSettings();
  usage.forecast = await updateForecast(usage, now);
  await setLocal({ [K.usage]: usage, [K.lastError]: null });
  await updateBadge(usage, settings);
  await maybeNotify(usage, usage.forecast, settings);
  await broadcast();
}

async function getState() {
  const [usage, settings, page, lastError, rated, dismissedUntil] = await Promise.all([
    getLocal(K.usage, null), getSettings(), getLocal(K.page, {}), getLocal(K.lastError, null),
    getLocal(K.rated, false), getLocal(K.dismissedUntil, 0)
  ]);
  return {
    usage, settings, page, lastError,
    topCounter: topCounter(usage),
    reviewUrl: rated ? null : reviewUrl(),
    dismissedUntil
  };
}

async function broadcast() {
  const state = await getState();
  try { chrome.runtime.sendMessage({ type: "state", state }, () => void chrome.runtime.lastError); } catch (_) {}
  for (const tab of await geminiTabs()) {
    try { chrome.tabs.sendMessage(tab.id, { type: "state", state }, () => void chrome.runtime.lastError); } catch (_) {}
  }
}

function reviewUrl() {
  if (EDGE_REVIEW_URL && isEdgeBrowser()) return EDGE_REVIEW_URL;
  return CHROME_REVIEW_URL;
}

// ---- alarms ----------------------------------------------------------------------
async function rescheduleAlarm() {
  const s = await getSettings();
  const tabs = await geminiTabs();
  const period = tabs.length ? s.pollMinutes : Math.max(s.pollMinutes, IDLE_POLL_MINUTES);
  const cur = await chrome.alarms.get(POLL_ALARM);
  if (cur && cur.periodInMinutes === period) return;
  await chrome.alarms.clear(POLL_ALARM);
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: period, delayInMinutes: Math.min(period, 1) });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === POLL_ALARM) pollUsage("alarm").then(rescheduleAlarm);
});

chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.status === "complete" && tab.url && tab.url.startsWith(GEMINI_ORIGIN)) rescheduleAlarm();
});
chrome.tabs.onRemoved.addListener(() => { rescheduleAlarm(); });

// ---- messages ----------------------------------------------------------------------
let genRefreshTimer = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "get_state":
        return getState();
      case "refresh":
        await pollUsage("manual");
        return getState();
      case "quota_sniffed":
        if (Array.isArray(msg.rows) && msg.rows.length) {
          await applyRows(msg.rows, { source: "page", authuser: msg.authuser || 0 });
        }
        return { ok: true };
      case "gen_done":
        // A reply just finished; Gemini settles the quota a moment later.
        clearTimeout(genRefreshTimer);
        genRefreshTimer = setTimeout(() => pollUsage("gen_done"), 2500);
        return { ok: true };
      case "page_info": {
        const prev = await getLocal(K.page, {});
        const next = Object.assign({}, prev, msg.info || {}, { at: Date.now() });
        await setLocal({ [K.page]: next });
        if (prev.authuser !== next.authuser) pollUsage("account_switch");
        return { ok: true };
      }
      case "save_settings": {
        const s = await saveSettings(msg.patch || {});
        const usage = await getLocal(K.usage, null);
        await updateBadge(usage, s);
        await rescheduleAlarm();
        await broadcast();
        return s;
      }
      case "dismiss_strip": {
        await setLocal({ [K.dismissedUntil]: Date.now() + 12 * 60 * 60 * 1000 });
        await broadcast();
        return { ok: true };
      }
      case "reset": {
        await setLocal({ [K.fired]: {}, [K.dismissedUntil]: 0, [K.history]: {}, [K.tokens]: {} });
        await pollUsage("reset");
        return getState();
      }
      case "test_notification": {
        const u = await getLocal(K.usage, null);
        const w = u && u.compute && u.compute.short;
        await notify("gum-test-" + Date.now(), "Gemini Usage Meter",
          w ? `Notifications work. 5-hour usage is ${Math.round(w.pct)}%, resets in ${fmtReset(w.resetsAt)}.`
            : "Notifications work. You'll get an alert as you approach your Gemini limits.");
        return { ok: true };
      }
      case "open_options":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      case "open_review":
        await openReview();
        return { ok: true };
      case "rate_clicked":
        await setLocal({ [K.rated]: true });
        return { ok: true };
      default:
        return null;
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});

// ---- lifecycle ----------------------------------------------------------------------
async function boot() {
  await installOriginRule();
  await rescheduleAlarm();
  const usage = await getLocal(K.usage, null);
  await updateBadge(usage, await getSettings());
}

function isEdgeBrowser() {
  try {
    const brands = navigator.userAgentData && navigator.userAgentData.brands;
    if (Array.isArray(brands) && brands.some((b) => /edge/i.test(b.brand))) return true;
  } catch (_) {}
  try { return /Edg(e|A|iOS)?\//i.test(navigator.userAgent || ""); } catch (_) {}
  return false;
}

// Uninstall feedback page: the browser opens it right after removal, with the
// version, browser and days installed so feedback can be read in context.
// Nothing else about the user is sent. Re-set on every worker start so the
// "days installed" figure stays roughly current.
async function setUninstallPage() {
  try {
    if (!UNINSTALL_URL || !chrome.runtime.setUninstallURL) return;
    const p = new URLSearchParams({ v: chrome.runtime.getManifest().version, b: isEdgeBrowser() ? "edge" : "chrome" });
    const installAt = await getLocal("install_at", 0);
    if (installAt) p.set("d", String(Math.max(0, Math.floor((Date.now() - installAt) / 86400000))));
    const r = chrome.runtime.setUninstallURL(UNINSTALL_URL + "?" + p.toString());
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch (_) {}
}

// Marks the user as having rated (first write of the timestamp wins) and opens
// the store's review page. Shared by the strip button, the rating card and the
// toolbar popup, so "Rate us" disappears everywhere at once.
async function openReview() {
  const patch = { [K.rated]: true };
  const at = await getLocal("rate_us_clicked_at", 0);
  if (!at) patch.rate_us_clicked_at = Date.now();
  await setLocal(patch);
  await chrome.tabs.create({ url: reviewUrl() });
  await broadcast();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (PROMPT_TEST) {
    try { await chrome.storage.local.remove(PROMPT_TEST_KEYS); } catch (_) {}
  }
  // Record the install time first so the Rate us gate always has a value. A
  // fresh install starts the clock now; an update with no record counts as an
  // existing user (0 = gate already passed). The test build treats every
  // reload as a fresh install so the whole flow can be replayed.
  try {
    const installAt = await getLocal("install_at", undefined);
    if (installAt === undefined) {
      await setLocal({ install_at: (details.reason === "install" || PROMPT_TEST) ? Date.now() : 0 });
    }
  } catch (_) {}
  await setUninstallPage();
  await boot();
  if (details.reason === "install" && INSTALL_URL) {
    try { chrome.tabs.create({ url: INSTALL_URL }); } catch (_) {}
  }
  pollUsage("install");
});
chrome.runtime.onStartup.addListener(() => { setUninstallPage(); boot().then(() => pollUsage("startup")); });
setUninstallPage();

// exported for tests (no-op in the extension)
if (typeof module !== "undefined") module.exports = { parseRow, classifyCompute, mergeUsage, computeForecast, topCounter };
