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
// open: from here, after reading the tokens (and the account id) out of the
// /app HTML; a session declarativeNetRequest rule gives those requests a
// gemini.google.com Origin.
// The page also gets sniffed: whenever Gemini fetches its quota for itself, the
// content script forwards the rows, so the meter moves the moment the app's
// own badge would.
//
// Several accounts (v1.0.3)
// -------------------------
// One browser can hold several Google accounts at once, and a private window
// can be signed in to yet another one. So an account is never identified by a
// URL path or by the window: it is the 21-digit
// Google user id (WIZ_global_data.S06Grb), read from the same page or /app
// document that supplies the call tokens. Everything that belongs to "the
// account" (usage, forecast history, alerts already fired, tokens) is stored
// under that id, each tab remembers which account it is on, and a private
// window is only ever read through a Gemini tab of that window. See "accounts
// and windows" below.

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

// ---- accounts and windows (v1.0.3) ------------------------------------------
//
// One extension instance serves two cookie jars (the normal window and a
// private window) and, inside one jar, several Google accounts open in
// different tabs. Each of them can show different numbers, so before this the
// single set of keys below made a private window show the normal window's
// account, and a second account in another tab overwrote the first.
//
//   CTX            "default" for the normal jar, otherwise "incognito" (or the
//                  cookieStoreId where the browser exposes one). It exists to
//                  keep the worker's own fetch, which always carries the NORMAL
//                  jar's cookies, from ever running on behalf of another jar.
//   CURRENT_ACCT   the 21-digit Google user id (WIZ_global_data.S06Grb) of the
//                  tab or reading being processed.
//   CURRENT_TAB    the tab being served, when there is one.
//   inCtx(...)     runs a job with those three set, strictly one at a time (a
//                  FIFO queue), so the code in between can keep reading K.* as
//                  if there were only one account. Every entry point (alarm,
//                  message, badge refresh) goes through it.
//
// Keys in chrome.storage.local come in three kinds:
//   shared      user level, one copy: settings, rate_us_clicked,
//               strip_dismissed_until
//   account     everything that describes ONE account, stored as
//               acct:<id>:<name> (usage, fired_thresholds, fc_history,
//               bg_tokens), whichever window or tab it was seen from
//   window      facts about one jar, not an account: page_info, last_error and
//               window_acct, the last account active in that jar (used when the
//               popup opens on a non-Gemini tab, or when polling with no Gemini
//               tab open). The normal jar keeps the un-prefixed names, the
//               others use ctx:<ctx>:<name>.
let CTX = "default";
let CURRENT_ACCT = null;
let CURRENT_TAB = null;

const BASE_K = {
  settings: "settings",
  usage: "usage",
  page: "page_info",
  lastError: "last_error",
  fired: "fired_thresholds",
  history: "fc_history",
  tokens: "bg_tokens",
  rated: "rate_us_clicked",
  dismissedUntil: "strip_dismissed_until",
  acct: "window_acct"
};
const SHARED_K = new Set(["settings", "rated", "dismissedUntil"]);
const WINDOW_K = new Set(["page", "lastError", "acct"]);
const windowKey = (ctx, base) => (ctx === "default" ? base : `ctx:${ctx}:${base}`);

const K = {};
for (const name of Object.keys(BASE_K)) {
  Object.defineProperty(K, name, {
    enumerable: true,
    get() {
      const base = BASE_K[name];
      if (SHARED_K.has(name)) return base;
      if (WINDOW_K.has(name)) return windowKey(CTX, base);
      return `acct:${CURRENT_ACCT || "-"}:${base}`;
    }
  });
}

function ctxOfTab(tab) {
  if (!tab) return "default";
  const sid = tab.cookieStoreId;
  if (sid) return (sid === "firefox-default" || sid === "0") ? "default" : String(sid);
  return tab.incognito ? "incognito" : "default";
}

// Per-tab state, kept in memory and mirrored to storage so a service worker
// restart doesn't forget which account each open tab is on.
// tabId -> { acct, ctx, page, lastError }
const TAB_STATE = new Map();
const LAST_ACCT_BY_CTX = new Map();
let tabStateLoaded = false;

async function ensureTabStateLoaded() {
  if (tabStateLoaded) return;
  tabStateLoaded = true;
  try {
    const raw = await getLocal("session_tabs", null);
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        const id = Number(k);
        if (Number.isFinite(id) && v && typeof v === "object" && !TAB_STATE.has(id)) {
          TAB_STATE.set(id, v);
        }
      }
    }
  } catch (_) {}
}

async function persistTabState() {
  try {
    const out = {};
    for (const [id, st] of TAB_STATE.entries()) out[id] = st;
    await setLocal({ session_tabs: out });
  } catch (_) {}
}

function getTabEntry(tabId, ctx) {
  if (tabId == null) return null;
  let st = TAB_STATE.get(tabId);
  if (!st) {
    st = { acct: null, ctx: ctx || "default", page: {}, lastError: null };
    TAB_STATE.set(tabId, st);
  } else if (ctx) {
    st.ctx = ctx;
  }
  return st;
}

async function acctForCtx(ctx) {
  if (LAST_ACCT_BY_CTX.has(ctx)) return LAST_ACCT_BY_CTX.get(ctx);
  const a = await getLocal(windowKey(ctx, BASE_K.acct), null);
  if (a) LAST_ACCT_BY_CTX.set(ctx, a);
  return a;
}

async function acctForTabOrCtx(tabId, ctx) {
  await ensureTabStateLoaded();
  if (tabId != null && TAB_STATE.has(tabId)) {
    const st = TAB_STATE.get(tabId);
    if (st && st.acct) return st.acct;
  }
  return acctForCtx(ctx);
}

// Before 1.0.3 usage / fired_thresholds / fc_history were stored un-prefixed.
// The first time a real account is seen in the normal window, move them under
// it (the old single-account data was the normal window's, so it is that
// account's).
const MIGRATED_ACCTS = new Set();
async function migrateLegacyAccountState(acct) {
  if (CTX !== "default" || !acct || /^x-/.test(acct) || MIGRATED_ACCTS.has(acct)) return;
  MIGRATED_ACCTS.add(acct);
  try {
    const legacyKeys = ["usage", "fired", "history"].map((n) => BASE_K[n]);
    const prefix = `acct:${acct}:`;
    const got = await chrome.storage.local.get([...legacyKeys, prefix + BASE_K.usage]);
    if (got[prefix + BASE_K.usage]) {
      await chrome.storage.local.remove(legacyKeys);
      return;
    }
    const legacy = got[BASE_K.usage];
    if (!legacy) return;
    const moved = {};
    for (const k of legacyKeys) {
      if (got[k] != null) {
        if (k === BASE_K.usage && typeof got[k] === "object") {
          const copy = Object.assign({}, got[k]);
          delete copy.authuser;
          copy.acct = acct;
          moved[prefix + k] = copy;
        } else {
          moved[prefix + k] = got[k];
        }
      }
    }
    await chrome.storage.local.set(moved);
    await chrome.storage.local.remove(legacyKeys);
  } catch (_) {}
}

async function setCurrentAcct(acct, tabId) {
  if (!acct) return;
  CURRENT_ACCT = acct;
  if (tabId != null) {
    const st = getTabEntry(tabId, CTX);
    st.acct = acct;
    await persistTabState();
  }
  if (LAST_ACCT_BY_CTX.get(CTX) !== acct) {
    LAST_ACCT_BY_CTX.set(CTX, acct);
    await setLocal({ [windowKey(CTX, BASE_K.acct)]: acct });
  }
  await migrateLegacyAccountState(acct);
}

async function getPageInfoForCurrent() {
  if (CURRENT_TAB != null && TAB_STATE.has(CURRENT_TAB)) {
    const p = TAB_STATE.get(CURRENT_TAB).page;
    if (p && Object.keys(p).length) return p;
  }
  if (CURRENT_ACCT) {
    for (const st of TAB_STATE.values()) {
      if (st.acct === CURRENT_ACCT && st.page && Object.keys(st.page).length) return st.page;
    }
  }
  return getLocal(K.page, {});
}

async function setPageInfoForCurrent(info) {
  if (CURRENT_TAB != null) {
    const st = getTabEntry(CURRENT_TAB, CTX);
    st.page = info;
    await persistTabState();
  }
  await setLocal({ [K.page]: info });
}

async function getLastErrorForCurrent() {
  if (CURRENT_TAB != null && TAB_STATE.has(CURRENT_TAB)) {
    const st = TAB_STATE.get(CURRENT_TAB);
    if (st.lastError !== undefined) return st.lastError;
  }
  if (CURRENT_ACCT) {
    for (const st of TAB_STATE.values()) {
      if (st.acct === CURRENT_ACCT && st.lastError !== undefined) return st.lastError;
    }
  }
  return getLocal(K.lastError, null);
}

async function setLastErrorForCurrent(errObj) {
  if (CURRENT_TAB != null) {
    const st = getTabEntry(CURRENT_TAB, CTX);
    st.lastError = errObj;
  }
  if (CURRENT_ACCT) {
    for (const st of TAB_STATE.values()) {
      if (st.acct === CURRENT_ACCT) st.lastError = errObj;
    }
  }
  await persistTabState();
  await setLocal({ [K.lastError]: errObj });
}

// Freeze guards: the queue is a single lane, so one job that never settles
// would stall polling and every message for all windows. Each job has a hard
// time limit, each request a shorter one, and a request that finishes after its
// job was given up on is discarded (ctx_expired) so it can never write into the
// account that runs next.
const CTX_JOB_TIMEOUT_MS = 60 * 1000;     // longest a single queued job may hold the lane
const CTX_FETCH_TIMEOUT_MS = 20 * 1000;   // longest a single request may take
let ctxQueue = Promise.resolve();
let RUN_ID = 0;
let runSeq = 0;

function inCtx(ctx, fn, opts) {
  const tabId = opts && opts.tabId != null ? opts.tabId : null;
  const explicitAcct = opts && opts.acct ? opts.acct : null;
  const run = () => {
    const myRun = ++runSeq;
    RUN_ID = myRun;
    CTX = ctx || "default";
    CURRENT_TAB = tabId;
    let timer = null;
    const work = (async () => {
      await ensureTabStateLoaded();
      CURRENT_ACCT = explicitAcct || (await acctForTabOrCtx(tabId, CTX));
      if (explicitAcct) await setCurrentAcct(explicitAcct, tabId);
      else if (CURRENT_ACCT) await migrateLegacyAccountState(CURRENT_ACCT);
      return await fn();
    })();
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("ctx_job_timeout")), CTX_JOB_TIMEOUT_MS);
    });
    return Promise.race([work, watchdog]).finally(() => {
      clearTimeout(timer);
      if (RUN_ID !== myRun) return;
      CTX = "default";
      CURRENT_ACCT = null;
      CURRENT_TAB = null;
      RUN_ID = 0;
    });
  };
  const p = ctxQueue.then(run, run);
  ctxQueue = p.catch(() => {});
  return p;
}

async function guardedFetch(url, init) {
  const myRun = RUN_ID;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl && ctl.abort(); } catch (_) {} }, CTX_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, ctl ? { ...(init || {}), signal: ctl.signal } : init);
    if (myRun && RUN_ID !== myRun) throw new Error("ctx_expired");
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function activeCtxs() {
  const set = new Set(["default"]);
  try {
    for (const t of await geminiTabs()) set.add(ctxOfTab(t));
  } catch (_) {}
  return [...set];
}

// Poll every distinct account open across all Gemini tabs (several accounts in
// one window included), plus the normal window's direct fallback when it has no
// Gemini tab of its own.
async function pollAll() {
  await ensureTabStateLoaded();
  const tabs = await geminiTabs();
  const jobs = [];
  const seenAcctInCtx = new Set();
  let hasDefaultTab = false;

  // Prefer active tabs first so the visible tab in each window is polled first.
  const sorted = tabs.slice().sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  for (const t of sorted) {
    const c = ctxOfTab(t);
    if (c === "default") hasDefaultTab = true;
    const knownAcct = TAB_STATE.get(t.id) && TAB_STATE.get(t.id).acct;
    const dedupeKey = knownAcct ? `${c}:acct:${knownAcct}` : `${c}:tab:${t.id}`;
    if (seenAcctInCtx.has(dedupeKey)) continue;
    seenAcctInCtx.add(dedupeKey);
    jobs.push(inCtx(c, () => pollUsage("poll", t.id), { tabId: t.id, acct: knownAcct || null }));
  }

  if (!hasDefaultTab) {
    jobs.push(inCtx("default", () => pollUsage("poll", null)));
  }

  await Promise.all(jobs);
}

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
// compute meter is replaced only by a batch that carries it. `prev` is read
// from this account's own key (acct:<id>:usage), so it always belongs to the
// same account and nothing has to be compared.
function mergeUsage(prev, rawRows, meta, now) {
  const rows = (rawRows || []).map(parseRow).filter(Boolean);
  // meta.full: the batch is a complete reading (both of our calls), so it
  // replaces what we had. Sniffed page responses are partial and merge.
  const keep = !!prev && !meta.full;
  const next = {
    fetchedAt: now,
    source: meta.source,
    acct: (meta && meta.acct) || (prev && prev.acct) || CURRENT_ACCT || null,
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
      await notify("gum-" + (CURRENT_ACCT || "a") + "-" + key + "-" + t, `Gemini ${label}: ${Math.round(w.pct)}%`, msg);
      fired[key] = done.concat(due);
      changed = true;
    }
    const f = forecast && forecast[scope];
    const fkey = key + ":fc";
    if (settings.forecastNotify && f && f.msLeft <= FC_NOTIFY_MIN * 60000 && !fired[fkey]) {
      await notify(
        "gum-" + (CURRENT_ACCT || "a") + "-" + fkey,
        `Gemini ${label}: ~${Math.max(1, Math.round(f.msLeft / 60000))}m left at this pace`,
        `At your current pace you'll hit the ${label.toLowerCase()} before it resets in ${fmtReset(w.resetsAt)}.`
      );
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
function computeBadge(usage, settings) {
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
  if (p == null) return { text: "" };
  return { text: p >= 100 ? "MAX" : String(Math.round(p)), color: levelColor(p) };
}

async function paintBadge(b, tabId) {
  const t = tabId == null ? {} : { tabId };
  await chrome.action.setBadgeText({ ...t, text: b.text });
  if (!b.text) return;
  await chrome.action.setBadgeBackgroundColor({ ...t, color: b.color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ ...t, color: "#ffffff" });
}

// v1.0.3: Because two tabs in the SAME window can be signed in to different
// Google accounts, each Gemini tab with a known account gets its own tab-specific
// badge, and the global badge reflects the default window's active account.
async function updateBadge(usage, settings) {
  const ctx = CTX;
  const acct = CURRENT_ACCT;
  try {
    const b = computeBadge(usage, settings);
    if (ctx === "default") {
      await paintBadge(b);
    }
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      if (t.id == null) continue;
      const tCtx = ctxOfTab(t);
      const tAcct = TAB_STATE.get(t.id) && TAB_STATE.get(t.id).acct;
      if (acct && tAcct === acct) {
        try { await paintBadge(b, t.id); } catch (_) {}
      } else if (!tAcct && tCtx === ctx && ctx !== "default") {
        try { await paintBadge(b, t.id); } catch (_) {}
      }
    }
  } catch (_) {}
}

async function refreshOtherBadges(settings, exceptCtx) {
  try {
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      if (t.id == null) continue;
      const tAcct = TAB_STATE.get(t.id) && TAB_STATE.get(t.id).acct;
      if (tAcct) {
        const u = await getLocal(`acct:${tAcct}:${BASE_K.usage}`, null);
        try { await paintBadge(computeBadge(u, settings), t.id); } catch (_) {}
      }
    }
    for (const c of await activeCtxs()) {
      if (c === exceptCtx) continue;
      inCtx(c, async () => {
        await updateBadge(await getLocal(K.usage, null), settings);
      });
    }
  } catch (_) {}
}

async function refreshTabBadge(tab) {
  try {
    if (!tab || tab.id == null) return;
    await ensureTabStateLoaded();
    const ctx = ctxOfTab(tab);
    const tAcct = TAB_STATE.get(tab.id) && TAB_STATE.get(tab.id).acct;
    if (!tAcct && ctx === "default") return;
    await inCtx(ctx, async () => {
      try {
        await paintBadge(computeBadge(await getLocal(K.usage, null), await getSettings()), tab.id);
      } catch (_) {}
    }, { tabId: tab.id, acct: tAcct || null });
  } catch (_) {}
}

if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId).then(async (tab) => {
      await ensureTabStateLoaded();
      const st = TAB_STATE.get(tabId);
      if (st && st.acct) {
        const ctx = ctxOfTab(tab);
        LAST_ACCT_BY_CTX.set(ctx, st.acct);
        await setLocal({ [windowKey(ctx, BASE_K.acct)]: st.acct });
        if (ctx === "default") {
          const u = await getLocal(`acct:${st.acct}:${BASE_K.usage}`, null);
          await paintBadge(computeBadge(u, await getSettings()));
        }
      }
      await refreshTabBadge(tab);
    }).catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.status === "complete" || info.status === "loading") refreshTabBadge(tab);
  });
}

// ---- fetching: via an open Gemini tab ---------------------------------------
async function geminiTabs() {
  try { return await chrome.tabs.query({ url: GEMINI_ORIGIN + "/*" }); } catch (_) { return []; }
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

// v1.0.3: pick the Gemini tab to ask: the one that was asked for, else one on
// the wanted account, and always one of the SAME window (jar) as the job, so a
// private window is read through its own tab and never through a normal one.
// Matched by account id only.
async function fetchViaTab(targetTabId, preferAcct) {
  const ctx = CTX;
  const allInCtx = (await geminiTabs()).filter((t) => ctxOfTab(t) === ctx);
  if (!allInCtx.length) return null;

  let candidates;
  if (targetTabId != null) {
    const exact = allInCtx.filter((t) => t.id === targetTabId);
    candidates = exact.length ? exact : allInCtx;
  } else if (preferAcct) {
    const matching = allInCtx.filter((t) => (TAB_STATE.get(t.id) && TAB_STATE.get(t.id).acct) === preferAcct);
    candidates = matching.length ? matching : allInCtx;
  } else {
    candidates = allInCtx;
  }

  candidates.sort((a, b) => {
    if (targetTabId != null) {
      if (a.id === targetTabId) return -1;
      if (b.id === targetTabId) return 1;
    }
    if (preferAcct) {
      const ma = (TAB_STATE.get(a.id) && TAB_STATE.get(a.id).acct) === preferAcct ? 1 : 0;
      const mb = (TAB_STATE.get(b.id) && TAB_STATE.get(b.id).acct) === preferAcct ? 1 : 0;
      if (ma !== mb) return mb - ma;
    }
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });

  let lastErr = null;
  for (const tab of candidates.slice(0, 3)) {
    const r = await sendToTab(tab.id, { type: "fetch_quota" }, TAB_FETCH_TIMEOUT_MS);
    if (r && Array.isArray(r.rows)) {
      if (r.acct && r.rpc && ctxOfTab(tab) === "default") await rememberRpc(r.acct, r.rpc);
      return {
        rows: r.rows,
        complete: !!r.complete,
        acct: r.acct || (TAB_STATE.get(tab.id) && TAB_STATE.get(tab.id).acct) || null,
        tabId: tab.id,
        source: "tab"
      };
    }
    lastErr = (r && r.error) || "empty";
    if (lastErr === "signed_out") return { error: "signed_out", tabId: tab.id };
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

// v1.0.3: the worker's own request carries the NORMAL window's cookies, so /app
// is the account that window is on. The call tokens and the 21-digit Google
// user id (S06Grb) come out of that one document, so they can't disagree.
// Tokens are cached per account (acct:<id>:bg_tokens).
// The worker's own fallback request can only reach the NORMAL window's session, and to read an account that
// is not the default one it has to address it by position. The account's page in that window reports its RPC
// base ("/u/1/_/BardChatUi"); it is kept per account (21-digit id) and used ONLY as an address. It never says
// whose data comes back: the S06Grb of the fresh /app response does, and the reading is filed under that.
const RPC_BY_ACCT = new Map();
const validRpc = (r) => typeof r === "string" && /^\/(?:u\/\d{1,2}\/)?_\/BardChatUi$/.test(r);
async function rememberRpc(acct, rpc) {
  if (!acct || !validRpc(rpc) || RPC_BY_ACCT.get(acct) === rpc) return;
  RPC_BY_ACCT.set(acct, rpc);
  await setLocal({ ["acct:" + acct + ":rpc_base"]: rpc });
}
async function rpcFor(acct) {
  if (!acct) return null;
  if (RPC_BY_ACCT.has(acct)) return RPC_BY_ACCT.get(acct);
  const v = await getLocal("acct:" + acct + ":rpc_base", null);
  if (!validRpc(v)) return null;
  RPC_BY_ACCT.set(acct, v);
  return v;
}
async function forgetRpc(acct) {
  if (!acct) return;
  RPC_BY_ACCT.delete(acct);
  await chrome.storage.local.remove("acct:" + acct + ":rpc_base");
}

async function getTokens(force, rpc) {
  if (!force && CURRENT_ACCT) {
    const cached = await getLocal(K.tokens, null);
    if (cached && cached.xsrf && cached.acct !== undefined && Date.now() - cached.at < TOKENS_TTL_MS) {
      return cached;
    }
  }
  const prefix = validRpc(rpc) ? rpc.replace(/\/_\/BardChatUi$/, "") : "";   // "" (default account) or "/u/N"
  const res = await guardedFetch(GEMINI_ORIGIN + prefix + "/app", { credentials: "include", redirect: "follow" });
  if (!res.ok) throw new Error("http_" + res.status);
  if (/accounts\.google\.com/.test(res.url)) throw new Error("signed_out");
  const html = await res.text();
  const grab = (k) => { const m = new RegExp('"' + k + '":"([^"]*)"').exec(html); return m ? m[1] : null; };
  // rpc: the batchexecute base of this very document (Im6cmf), so the calls go to the session the tokens belong to
  const rpcRaw = (grab("Im6cmf") || "").replace(/\\\//g, "/").replace(/\/+$/, "");
  const t = { at: Date.now(), xsrf: grab("SNlM0e"), bl: grab("cfb2h"), sid: grab("FdrFJe"), acct: grab("S06Grb"),
              rpc: validRpc(rpcRaw) ? rpcRaw : (prefix ? prefix + "/_/BardChatUi" : null) };
  if (!t.xsrf) throw new Error("signed_out");
  // the worker reads the normal window's default account: that says nothing about the account of the TAB that asked
  if (t.acct) await setCurrentAcct(t.acct, null);
  if (t.acct && t.rpc) await rememberRpc(t.acct, t.rpc);   // the address that really reached this account just now
  await setLocal({ [K.tokens]: t });
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
async function bgCall(tokens, args) {
  const qs = new URLSearchParams({
    rpcids: RPC_QUOTA, "source-path": "/app", bl: tokens.bl || "", "f.sid": tokens.sid || "",
    hl: "en", _reqid: String((bgReq += 100000)), rt: "c"
  });
  const body = new URLSearchParams({ "f.req": JSON.stringify([[[RPC_QUOTA, args, null, "generic"]]]), at: tokens.xsrf });
  const res = await guardedFetch(GEMINI_ORIGIN + (tokens.rpc || "/_/BardChatUi") + "/data/batchexecute?" + qs, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
    body
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error("auth_" + res.status);
  if (!res.ok) throw new Error("http_" + res.status);
  return parseBatch(await res.text());
}

async function fetchDirect(rpc) {
  const want = CURRENT_ACCT;   // the account this poll is about (getTokens switches CURRENT_ACCT to what /app returns)
  // Always a fresh /app, never cached tokens: its S06Grb is the check of whose session this address reaches RIGHT NOW
  // (sessions can be re-ordered or signed out since the address was reported). The reading is filed under that id.
  let tokens;
  try {
    tokens = await getTokens(true, rpc);
  } catch (e) {
    if (!rpc) throw e;
    await forgetRpc(want);                 // that address leads nowhere any more: fall back to the default account
    tokens = await getTokens(true, null);
  }
  if (rpc && want && tokens.acct && tokens.acct !== want) await forgetRpc(want);   // that address now belongs to someone else
  const run = async () => {
    const [a, b] = await Promise.allSettled([bgCall(tokens, ARGS_COMPUTE), bgCall(tokens, ARGS_ALL)]);
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
    tokens = await getTokens(true, tokens.rpc);
    out = await run();
  }
  return { rows: out.rows, complete: out.complete, acct: tokens.acct || null, source: "background" };
}

// ---- the poll ------------------------------------------------------------------
async function pollUsage(reason, targetTabId) {
  const myRun = RUN_ID;
  const tabId = targetTabId !== undefined ? targetTabId : CURRENT_TAB;
  let result = await fetchViaTab(tabId, CURRENT_ACCT);

  if (CTX !== "default") {
    // v1.0.3: the worker's own fetch carries the NORMAL window's cookies, so it
    // is never used for another window: no tab there means no reading.
    if (!result) {
      CURRENT_ACCT = null;
      LAST_ACCT_BY_CTX.delete(CTX);
      await setLocal({ [K.acct]: null });
      result = { error: "no_tab_for_context" };
    }
  } else if (!result || (result.error && result.error !== "signed_out")) {
    try { result = await fetchDirect(await rpcFor(CURRENT_ACCT)); }
    catch (e) { result = { error: String((e && e.message) || e) }; }
  }

  if (myRun && RUN_ID !== myRun) throw new Error("ctx_expired");

  if (!result || result.error) {
    const err = result ? result.error : "unknown";
    await setLastErrorForCurrent({
      at: Date.now(),
      error: /signed_out|auth_/.test(err) ? "signed_out" : err
    });
    await broadcast();
    return;
  }

  await applyRows(result.rows, {
    source: result.source,
    acct: result.acct,
    // only a reading that CAME FROM a tab says anything about that tab's account; the worker's
    // own fetch reads the normal window's default account, whichever tab asked for it
    tabId: result.tabId != null ? result.tabId : null,
    full: !!result.complete
  });
}

async function applyRows(rows, meta) {
  const now = Date.now();
  const tabId = meta && meta.tabId !== undefined ? meta.tabId : CURRENT_TAB;
  const fallbackAcct = tabId != null ? `x-${CTX}-tab-${tabId}` : `x-${CTX}-0`;
  await setCurrentAcct((meta && meta.acct) || CURRENT_ACCT || fallbackAcct, tabId);

  const prev = await getLocal(K.usage, null);
  const usage = mergeUsage(prev, rows, { ...meta, acct: CURRENT_ACCT }, now);
  const settings = await getSettings();
  usage.forecast = await updateForecast(usage, now);

  await setLocal({ [K.usage]: usage });
  await setLastErrorForCurrent(null);
  await updateBadge(usage, settings);
  await maybeNotify(usage, usage.forecast, settings);
  await broadcast();
}

async function getState() {
  const [usage, settings, page, lastError, rated, dismissedUntil] = await Promise.all([
    CURRENT_ACCT ? getLocal(K.usage, null) : Promise.resolve(null),
    getSettings(),
    getPageInfoForCurrent(),
    getLastErrorForCurrent(),
    getLocal(K.rated, false),
    getLocal(K.dismissedUntil, 0)
  ]);
  return {
    ctx: CTX,
    acct: CURRENT_ACCT || null,
    usage,
    settings,
    page,
    lastError,
    topCounter: topCounter(usage),
    reviewUrl: rated ? null : reviewUrl(),
    dismissedUntil
  };
}

async function broadcast() {
  const state = await getState();
  try {
    chrome.runtime.sendMessage({ type: "state", state }, () => void chrome.runtime.lastError);
  } catch (_) {}

  // v1.0.3: send this state only to tabs on the same Google account (even across
  // windows), or to tabs of the same window that don't know their account yet.
  const acct = CURRENT_ACCT;
  const ctx = CTX;
  const curTab = CURRENT_TAB;
  for (const tab of await geminiTabs()) {
    const tCtx = ctxOfTab(tab);
    const tAcct = TAB_STATE.get(tab.id) && TAB_STATE.get(tab.id).acct;
    let shouldSend = false;
    if (acct && tAcct) {
      shouldSend = (tAcct === acct);
    } else if (curTab != null && tab.id === curTab) {
      shouldSend = true;
    } else if (!tAcct && tCtx === ctx) {
      shouldSend = true;
    }
    if (!shouldSend) continue;
    try {
      chrome.tabs.sendMessage(tab.id, { type: "state", state }, () => void chrome.runtime.lastError);
    } catch (_) {}
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
  if (a.name === POLL_ALARM) pollAll().then(rescheduleAlarm);
});

chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.status === "complete" && tab.url && tab.url.startsWith(GEMINI_ORIGIN)) rescheduleAlarm();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (TAB_STATE.has(tabId)) {
    TAB_STATE.delete(tabId);
    persistTabState();
  }
  rescheduleAlarm();
});

// ---- messages ----------------------------------------------------------------------
const genRefreshTimers = new Map();   // tabId (or ctx) -> pending refresh

function handleMessage(msg, sender, sendResponse) {
  (async () => {
    // The tab a message is about: the one it came from, or (the popup is not a
    // tab) the one the popup was opened on.
    const senderTabId = (sender && sender.tab && sender.tab.id != null)
      ? sender.tab.id
      : (msg && typeof msg.tabId === "number" ? msg.tabId : null);

    switch (msg && msg.type) {
      case "get_state":
        return getState();
      case "refresh":
        await pollUsage("manual", senderTabId);
        return getState();
      case "quota_sniffed":
        if (Array.isArray(msg.rows) && msg.rows.length) {
          await applyRows(msg.rows, {
            source: "page",
            acct: msg.acct || CURRENT_ACCT || null,
            tabId: senderTabId
          });
        }
        return { ok: true };
      case "gen_done": {
        // A reply just finished; Gemini settles the quota a moment later.
        const c = CTX;
        const acct = msg.acct || CURRENT_ACCT || null;
        const timerKey = senderTabId != null ? `tab:${senderTabId}` : `ctx:${c}`;
        clearTimeout(genRefreshTimers.get(timerKey));
        genRefreshTimers.set(
          timerKey,
          setTimeout(() => inCtx(c, () => pollUsage("gen_done", senderTabId), { tabId: senderTabId, acct }), 2500)
        );
        return { ok: true };
      }
      case "page_info": {
        const prev = await getPageInfoForCurrent();
        const incomingAcct = msg.acct || (msg.info && msg.info.acct) || null;
        const prevAcct = prev.acct || CURRENT_ACCT || null;
        if (incomingAcct) await setCurrentAcct(incomingAcct, senderTabId);
        const next = Object.assign({}, prev, msg.info || {}, {
          acct: incomingAcct || prevAcct || null,
          at: Date.now()
        });
        await setPageInfoForCurrent(next);
        if (incomingAcct && incomingAcct !== prevAcct) {
          await pollUsage("account_switch", senderTabId);
        } else {
          await updateBadge(await getLocal(K.usage, null), await getSettings());
          await broadcast();
        }
        return { ok: true };
      }
      case "save_settings": {
        const s = await saveSettings(msg.patch || {});
        const usage = await getLocal(K.usage, null);
        await updateBadge(usage, s);
        refreshOtherBadges(s, CTX);
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
        await setLocal({ [K.fired]: {}, [K.dismissedUntil]: 0, [K.history]: {}, [K.tokens]: null });
        await pollUsage("reset", senderTabId);
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
}

// v1.0.3: every message runs inside the window and account of the tab it is
// about, so the numbers it reads or writes are that account's.
const CTX_FREE_MESSAGES = new Set(["open_options"]);

async function resolveMessageTarget(msg, sender) {
  if (sender && sender.tab) {
    return {
      ctx: ctxOfTab(sender.tab),
      tabId: sender.tab.id,
      // page_info is how a tab announces a (new) account: run it as the account
      // the tab was on until now, so page_info can tell that it changed.
      acct: msg.type === "page_info" ? null : (msg.acct || (msg.info && msg.info.acct) || null)
    };
  }
  if (msg && typeof msg.tabId === "number") {
    try {
      const t = await chrome.tabs.get(msg.tabId);
      if (t) {
        return {
          ctx: ctxOfTab(t),
          tabId: t.id,
          acct: msg.acct || (TAB_STATE.get(t.id) && TAB_STATE.get(t.id).acct) || null
        };
      }
    } catch (_) {}
  }
  return { ctx: "default", tabId: null, acct: (msg && msg.acct) || null };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (CTX_FREE_MESSAGES.has(msg.type)) return handleMessage(msg, sender, sendResponse);
  let replied = false;
  const replyOnce = (v) => {
    if (replied) return;
    replied = true;
    try { sendResponse(v); } catch (_) {}
  };
  (async () => {
    const target = await resolveMessageTarget(msg, sender);
    if (msg.acct && msg.rpc && target.ctx === "default") await rememberRpc(msg.acct, msg.rpc);
    await inCtx(target.ctx, async () => {
      await new Promise((resolve) => {
        const reply = (v) => { replyOnce(v); resolve(); };
        let ret;
        try { ret = handleMessage(msg, sender, reply); } catch (_) { ret = undefined; }
        if (ret !== true) { replyOnce(); resolve(); }
      });
    }, { tabId: target.tabId, acct: target.acct });
  })().catch((err) => {
    replyOnce({ error: (err && err.message) || "failed" });
  });
  return true;
});

// ---- lifecycle ----------------------------------------------------------------------
async function boot() {
  await installOriginRule();
  await rescheduleAlarm();
  await inCtx("default", async () => {
    await updateBadge(await getLocal(K.usage, null), await getSettings());
  });
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
  pollAll();
});
chrome.runtime.onStartup.addListener(() => {
  setUninstallPage();
  // Tab ids don't survive a browser restart, so what was remembered per tab is
  // stale now. Each tab reports its account again as soon as it loads.
  chrome.storage.local.remove("session_tabs").catch(() => {});
  boot().then(() => pollAll());
});
setUninstallPage();

// exported for tests (no-op in the extension)
if (typeof module !== "undefined") module.exports = { parseRow, classifyCompute, mergeUsage, computeForecast, topCounter, ctxOfTab };
