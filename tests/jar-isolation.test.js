// Simulates:
// - a normal and an incognito window signed in to different / the same Google accounts
// - TWO different Google accounts open simultaneously in two tabs of the SAME window
// - account switches inside a tab, sniffed partial readings, direct worker fallback,
//   a private window with no Gemini tab, pages with no identity, and legacy migration.
// Usage: node tests/jar-isolation.test.js <path-to-extension-folder>
const fs = require("fs"), vm = require("vm");
const src = fs.readFileSync(process.argv[2] + "/background.js", "utf8");

const MAIN = { uid: "104829384756102938475" };
const SECOND = { uid: "112191377747774603807" };
const THIRD = { uid: "100000000000000000003" };
const raw = (a) => (a ? a.uid : null);
const RESET_SHORT = Date.now() + 3 * 3600e3, RESET_WEEKLY = Date.now() + 3 * 86400e3;

const jars = {
  default: { who: MAIN, short: 11, weekly: 5 },
  incognito: { who: SECOND, short: 77, weekly: 20 }
};
// Optional per-tab account override (for testing multiple accounts inside the same window)
const tabAccounts = new Map();
// Tabs whose own quota read fails (timeout, navigation...), so the worker's fallback has to step in
const failTabs = new Set();

const tabs = [
  { id: 1, url: "https://gemini.google.com/app", incognito: false, active: true },
  { id: 2, url: "https://gemini.google.com/app", incognito: true, active: true },
];
const store = {};
const fetchLog = [], stateLog = [], notifs = [], badges = [];

const row = (action, unit, pct, resetMs) => [[1, action, 0], unit, pct, [Math.floor(resetMs / 1000), 0], null, null];
const quotaRows = (j) => [row(2, 1, j.short, RESET_SHORT), row(2, 2, j.weekly, RESET_WEEKLY)];
const batchText = (rows) => ")]}'\n\n" + JSON.stringify([["wrb.fr", "qpEbW", JSON.stringify([rows]), null, null, null, "generic"]]) + "\n";

// What the worker's own requests reach: the normal window's sessions, addressed by POSITION (/u/N).
// jarList = the accounts of that window by position (null: just jars.default at position 0).
let jarList = null;
const appHtml = (j, pos) =>
  `<script>window.WIZ_global_data={"SNlM0e":"XSRF-${j.who ? j.who.uid : "none"}","cfb2h":"bl","FdrFJe":"sid"` +
  (j.who ? `,"S06Grb":"${j.who.uid}"` : "") +
  `,"Im6cmf":"${pos ? `\\/u\\/${pos}\\/_\\/BardChatUi` : "\\/_\\/BardChatUi"}"}</script>`;

const fetch = async (url, init) => {
  fetchLog.push({ via: "worker", jar: "default", url });
  const u = new URL(url);
  const m = u.pathname.match(/^\/u\/(\d+)(\/.*)$/);
  const pos = m ? Number(m[1]) : 0;                 // no prefix = position 0 = the default account
  const path = m ? m[2] : u.pathname;
  const j = jarList ? jarList[pos] : (pos === 0 ? jars.default : null);
  if (!j) return { ok: true, status: 200, url: "https://accounts.google.com/signin", text: async () => "" };   // no such session
  if (/\/app$/.test(path)) return { ok: true, status: 200, url, text: async () => appHtml(j, pos) };
  const at = new URLSearchParams(String(init && init.body)).get("at");   // a token of another account is rejected
  if (at !== "XSRF-" + (j.who ? j.who.uid : "none")) return { ok: false, status: 400, url, text: async () => "" };
  return { ok: true, status: 200, url, text: async () => batchText(quotaRows(j)) };
};

const noop = () => {};
const ev = () => ({ addListener: noop });
const chrome = {
  runtime: {
    onMessage: { addListener: (f) => (chrome._onMsg = f) },
    onInstalled: ev(),
    onStartup: ev(),
    lastError: null,
    getURL: (p) => p,
    setUninstallURL: noop,
    getManifest: () => ({ version: "1.0.3" }),
    id: "x",
    sendMessage: (msg, cb) => {
      if (msg.type === "state") stateLog.push({ tabId: "popup", ctx: msg.state.ctx, acct: msg.state.acct });
      if (cb) cb();
    }
  },
  storage: {
    local: {
      get: async (k) => {
        const keys = k == null ? Object.keys(store) : typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k);
        const o = {};
        for (const x of keys) if (x in store) o[x] = JSON.parse(JSON.stringify(store[x]));
        return o;
      },
      set: async (o) => { for (const k in o) store[k] = JSON.parse(JSON.stringify(o[k])); },
      remove: async (k) => { for (const x of (Array.isArray(k) ? k : [k])) delete store[x]; },
      onChanged: ev()
    }
  },
  alarms: { create: async () => {}, clear: async () => {}, get: async () => null, onAlarm: ev() },
  action: {
    setBadgeText: async (o) => badges.push({ tabId: o.tabId, text: o.text }),
    setBadgeBackgroundColor: async () => {},
    setBadgeTextColor: async () => {},
    setTitle: async () => {}
  },
  notifications: {
    create: (id, o, cb) => {
      notifs.push({ id, title: o.title, message: o.message });
      if (typeof cb === "function") cb();
    }
  },
  declarativeNetRequest: { updateSessionRules: async () => {} },
  tabs: {
    TAB_ID_NONE: -1,
    query: async (q) => tabs.filter((t) => !q || !q.url || t.url.startsWith("https://gemini.google.com/")),
    get: async (id) => tabs.find((t) => t.id === id),
    create: async () => ({}),
    onActivated: ev(),
    onUpdated: ev(),
    onRemoved: ev(),
    sendMessage: (id, msg, cb) => {
      const tab = tabs.find((t) => t.id === id);
      const jar = tab.incognito ? "incognito" : "default";
      if (msg.type === "fetch_quota" && failTabs.has(id)) {
        setTimeout(() => cb && cb({ rows: null, error: "boom" }), 0);
        return;
      }
      if (msg.type === "fetch_quota") {
        fetchLog.push({ via: "tab" + id, jar });
        const j = tabAccounts.get(id) || jars[jar];
        const resp = { rows: quotaRows(j), complete: true, acct: raw(j.who), rpc: j.rpc || null };
        setTimeout(() => cb && cb(resp), 0);
        return;
      }
      if (msg.type === "state") {
        const u = msg.state.usage;
        stateLog.push({
          tabId: id,
          ctx: msg.state.ctx,
          acct: msg.state.acct,
          pct: u && u.compute && u.compute.short && u.compute.short.pct
        });
      }
      if (cb) cb();
    },
  },
};

const ctx = {
  chrome,
  fetch,
  console: { log: noop, info: noop, warn: noop, error: console.error, debug: noop },
  setTimeout,
  clearTimeout,
  setInterval,
  Date,
  URL,
  URLSearchParams
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

const poll = () => vm.runInContext("typeof pollAll === 'function' ? pollAll() : pollUsage()", ctx);
const keyOf = (who) => who.uid;
const call = (msg, tab) => new Promise((res) => chrome._onMsg(msg, tab ? { tab } : {}, res));
const askState = (tabId) => call({ type: "get_state", tabId });
const fromTab = (id, msg) => call(msg, tabs.find((t) => t.id === id));
const settle = () => new Promise((r) => setTimeout(r, 60));
const pct = (s) => s.usage && s.usage.compute && s.usage.compute.short && s.usage.compute.short.pct;
const wk = (s) => s.usage && s.usage.compute && s.usage.compute.weekly && s.usage.compute.weekly.pct;
const usageKeys = () => Object.keys(store).filter((k) => /^acct:.*:usage$/.test(k));
const pageLoads = async (id, who, rpc) => {
  await fromTab(id, { type: "page_info", acct: raw(who), rpc, info: { acct: raw(who), model: "", plan: null } });
  await settle();
};

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " " + JSON.stringify(extra)));
  if (!cond) failures++;
};

(async () => {
  const kMain = keyOf(MAIN), kSecond = keyOf(SECOND), kThird = keyOf(THIRD);

  store["usage"] = { kind: "compute", compute: { short: { pct: 1, resetsAt: RESET_SHORT }, weekly: null }, counters: {} };
  store["fired_thresholds"] = { "legacy-window": [75] };
  store["fc_history"] = { short: { resetsAt: RESET_SHORT, samples: [{ t: Date.now() - 1000, p: 1 }] } };

  // 1) two different accounts, normal + incognito
  stateLog.length = 0;
  await poll();
  await settle();
  const n = await askState(1), i = await askState(2);
  check("normal tab shows main account", pct(n) === 11, { n: pct(n) });
  check("incognito tab shows second account", pct(i) === 77, { i: pct(i) });
  check(
    "stored per ACCOUNT in one store (none per window)",
    !!store[`acct:${kMain}:usage`] && !!store[`acct:${kSecond}:usage`] && !("usage" in store),
    Object.keys(store)
  );
  check(
    "legacy data migrated to normal window's account, old keys removed",
    JSON.stringify(store[`acct:${kMain}:fired_thresholds`]) === JSON.stringify({ "legacy-window": [75] }) &&
      !!store[`acct:${kMain}:fc_history`] &&
      !("fired_thresholds" in store) &&
      !("fc_history" in store),
    Object.keys(store)
  );
  check(
    "no cross-account broadcast",
    stateLog.filter((m) => m.tabId === 1).every((m) => m.pct === 11) &&
      stateLog.filter((m) => m.tabId === 2).every((m) => !m.pct || m.pct === 77),
    stateLog
  );
  check("alert is for the second account's 77% only", notifs.length === 1 && /77%/.test(notifs[0].title), notifs);
  check(
    "global badge shows normal account; incognito tab has its own",
    badges.some((b) => b.tabId == null && b.text === "11") &&
      badges.some((b) => b.tabId === 2 && b.text === "77") &&
      !badges.some((b) => b.tabId == null && b.text === "77"),
    badges
  );

  // 2) incognito hops to ANOTHER account and back
  const secondFired = JSON.stringify(store[`acct:${kSecond}:fired_thresholds`]);
  jars.incognito = { who: THIRD, short: 33, weekly: 10 };
  await pageLoads(2, THIRD);
  check(
    "third account got its own entry, second untouched",
    pct(await askState(2)) === 33 &&
      !!store[`acct:${kThird}:usage`] &&
      store[`acct:${kSecond}:usage`].compute.short.pct === 77 &&
      JSON.stringify(store[`acct:${kSecond}:fired_thresholds`]) === secondFired &&
      pct(await askState(1)) === 11,
    { p2: pct(await askState(2)) }
  );
  notifs.length = 0;
  jars.incognito = { who: SECOND, short: 90, weekly: 20 };
  await pageLoads(2, SECOND);
  const back = await askState(2);
  const firedBack = store[`acct:${kSecond}:fired_thresholds`] || {};
  check(
    "back on second account: its data restored, alerts not re-fired",
    pct(back) === 90 &&
      Object.values(firedBack).some((a) => a.includes(75) && a.includes(90)) &&
      notifs.length === 1 &&
      /90%/.test(notifs[0].title),
    { p: pct(back), firedBack, notifs }
  );

  // 3) a PARTIAL reading sniffed from the incognito tab goes to ITS account
  await fromTab(2, { type: "quota_sniffed", acct: raw(SECOND), rows: [row(2, 1, 55, RESET_SHORT)] });
  await settle();
  check(
    "sniffed rows merge into the sender's account only",
    pct(await askState(2)) === 55 && wk(await askState(2)) === 20 && pct(await askState(1)) === 11,
    { i: pct(await askState(2)), w: wk(await askState(2)), n: pct(await askState(1)) }
  );

  // 4) SAME account in normal and incognito: one shared entry, both tabs served
  jars.default = { who: MAIN, short: 42, weekly: 5 };
  jars.incognito = { who: MAIN, short: 42, weekly: 5 };
  await pageLoads(2, MAIN);
  stateLog.length = 0;
  await poll();
  await settle();
  const a = await askState(1), c = await askState(2);
  check(
    "same account in both windows -> same data, one entry",
    pct(a) === 42 && pct(c) === 42 && usageKeys().length === 3,
    { a: pct(a), c: pct(c), keys: usageKeys() }
  );
  check(
    "both tabs received the update",
    stateLog.some((m) => m.tabId === 1 && m.pct === 42) && stateLog.some((m) => m.tabId === 2 && m.pct === 42),
    stateLog
  );

  // 5) no Gemini tab in the normal window: worker's direct fetch reads S06Grb from /app
  tabs.splice(0, 1);
  jars.default = { who: MAIN, short: 61, weekly: 5 };
  jars.incognito = { who: SECOND, short: 20, weekly: 20 };
  await pageLoads(2, SECOND);
  fetchLog.length = 0;
  await poll();
  await settle();
  const viaWorker = store[`acct:${kMain}:usage`];
  check(
    "direct (worker) path reads the same user id from /app and updates the same entry",
    fetchLog.some((f) => f.via === "worker") &&
      !!viaWorker &&
      viaWorker.source === "background" &&
      viaWorker.compute.short.pct === 61 &&
      usageKeys().length === 3,
    { src: viaWorker && viaWorker.source, keys: usageKeys() }
  );
  check(
    "incognito still read through its own tab, not the worker",
    fetchLog.filter((f) => f.via === "tab2").length > 0 && pct(await askState(2)) === 20,
    { fetchLog }
  );

  // 6) incognito window has no Gemini tab any more: no fallback to worker
  const workerCalls = fetchLog.filter((f) => f.via === "worker").length;
  tabs[0].url = "https://example.com/";
  const gone = await call({ type: "refresh", tabId: 2 });
  check(
    "no tab in that window -> no data, no fallback to the worker",
    gone.usage === null &&
      gone.lastError &&
      gone.lastError.error === "no_tab_for_context" &&
      gone.ctx === "incognito" &&
      fetchLog.filter((f) => f.via === "worker").length === workerCalls,
    { gone: gone.usage, err: gone.lastError }
  );

  // 7) the page reports no identity at all: still isolated per tab/window
  tabs[0].url = "https://gemini.google.com/app";
  tabs.unshift({ id: 1, url: "https://gemini.google.com/app", incognito: false, active: true });
  delete store["session_tabs"];
  jars.default = { who: null, short: 15, weekly: 5 };
  jars.incognito = { who: null, short: 85, weekly: 20 };
  await pageLoads(1, null);
  await pageLoads(2, null);
  await poll();
  await settle();
  check(
    "no identity: windows still don't mix",
    pct(await askState(1)) === 15 && pct(await askState(2)) === 85,
    { n: pct(await askState(1)), i: pct(await askState(2)), keys: usageKeys() }
  );

  // 8) TWO DIFFERENT ACCOUNTS IN THE SAME WINDOW (tab 1 = MAIN, tab 3 = THIRD, both normal window)
  tabs.push({ id: 3, url: "https://gemini.google.com/app", incognito: false, active: false });
  tabAccounts.set(1, { who: MAIN, short: 28, weekly: 9 });
  tabAccounts.set(3, { who: THIRD, short: 64, weekly: 40 });
  await pageLoads(1, MAIN);
  await pageLoads(3, THIRD);
  await poll();
  await settle();
  const t1 = await askState(1), t3 = await askState(3);
  check(
    "two accounts in the SAME normal window stay isolated per tab",
    pct(t1) === 28 && pct(t3) === 64 && t1.acct === kMain && t3.acct === kThird,
    { t1: pct(t1), t3: pct(t3) }
  );

  // 9) tab 3's own read fails, so the worker's fallback runs. It can only see the normal window's
  //    DEFAULT account (MAIN): those numbers are MAIN's, and tab 3 must stay on THIRD with THIRD's numbers.
  failTabs.add(3);
  jars.default = { who: MAIN, short: 29, weekly: 9 };
  tabAccounts.set(1, { who: MAIN, short: 29, weekly: 9 });
  await poll();
  await settle();
  const f1 = await askState(1), f3 = await askState(3);
  check(
    "worker fallback does not re-label a tab: it keeps its own account and numbers",
    f3.acct === kThird && pct(f3) === 64 && f1.acct === kMain && pct(f1) === 29 &&
      store[`acct:${kMain}:usage`].compute.short.pct === 29 && store[`acct:${kThird}:usage`].compute.short.pct === 64,
    { tab3: { acct: f3.acct === kThird ? "THIRD" : f3.acct === kMain ? "MAIN" : f3.acct, pct: pct(f3) }, tab1: pct(f1) }
  );
  failTabs.delete(3);

  // 10) the normal window now has two sessions: MAIN at position 0 and THIRD at position 1. Tab 3's page told the
  //     worker its RPC base; when tab 3's own read fails, the fallback addresses THIRD through it (no email,
  //     no cached token), checks the S06Grb of the fresh /app, and files the reading under THIRD.
  jarList = [{ who: MAIN, short: 31, weekly: 9 }, { who: THIRD, short: 66, weekly: 41 }];
  tabAccounts.set(3, { who: THIRD, short: 64, weekly: 40, rpc: "/u/1/_/BardChatUi" });
  await pageLoads(3, THIRD, "/u/1/_/BardChatUi");
  failTabs.add(3);
  fetchLog.length = 0;
  await poll();
  await settle();
  const g3 = await askState(3);
  check(
    "fallback reads a NON-default account through its reported address; reading filed under that account",
    fetchLog.some((f) => f.via === "worker" && f.url.includes("/u/1/app")) &&
      fetchLog.some((f) => f.via === "worker" && f.url.includes("/u/1/_/BardChatUi/data/batchexecute")) &&
      g3.acct === kThird && pct(g3) === 66 && store[`acct:${kThird}:usage`].compute.short.pct === 66 &&
      store[`acct:${kMain}:usage`].compute.short.pct === 29 && store[`acct:${kThird}:rpc_base`] === "/u/1/_/BardChatUi",
    { acct: g3.acct, pct: pct(g3), worker: fetchLog.filter((f) => f.via === "worker").map((f) => f.url.replace("https://gemini.google.com", "")) }
  );

  // 11) the sessions were re-ordered since (THIRD is now position 0, MAIN position 1), so the stored address now
  //     reaches MAIN. The S06Grb of /app says so: the reading goes to MAIN, tab 3 stays on THIRD, the stale address
  //     is dropped, and the next fallback reads THIRD from where it really is.
  jarList = [{ who: THIRD, short: 70, weekly: 42 }, { who: MAIN, short: 33, weekly: 10 }];
  tabs.splice(tabs.findIndex((t) => t.id === 1), 1);       // only tab 3 (still failing) in the normal window
  await poll();
  await settle();
  const h3 = await askState(3);
  check(
    "stale address: reading goes to the account that really answered; tab keeps its account; address dropped",
    store[`acct:${kMain}:usage`].compute.short.pct === 33 && h3.acct === kThird && pct(h3) === 66 &&
      !(`acct:${kThird}:rpc_base` in store) && store[`acct:${kMain}:rpc_base`] === "/u/1/_/BardChatUi",
    { main: store[`acct:${kMain}:usage`].compute.short.pct, tab3: { acct: h3.acct === kThird ? "THIRD" : h3.acct, pct: pct(h3) }, thirdRpc: store[`acct:${kThird}:rpc_base`] }
  );
  await poll();
  await settle();
  const k3 = await askState(3);
  check("next fallback has no address and reads THIRD where it now is (default position)",
    k3.acct === kThird && pct(k3) === 70 && store[`acct:${kThird}:usage`].compute.short.pct === 70, { acct: k3.acct === kThird ? "THIRD" : k3.acct, pct: pct(k3) });
  // 12) the stored address leads nowhere any more (that session is gone): it is dropped and the fallback reads
  //     the default account instead; the reading is filed under that account, tab 3 stays on THIRD.
  jarList = [{ who: MAIN, short: 35, weekly: 11 }];
  await pageLoads(3, THIRD, "/u/5/_/BardChatUi");
  await poll();
  await settle();
  const m3 = await askState(3);
  check(
    "address of a vanished session is dropped; default account read instead; tab keeps its account",
    !(`acct:${kThird}:rpc_base` in store) && store[`acct:${kMain}:usage`].compute.short.pct === 35 && m3.acct === kThird && pct(m3) === 70,
    { thirdRpc: store[`acct:${kThird}:rpc_base`], main: store[`acct:${kMain}:usage`].compute.short.pct, tab3: pct(m3) }
  );
  failTabs.delete(3);
  jarList = null;

  // 13) the address of a PRIVATE window's page is another session's (its /u/0 is not the normal window's /u/0):
  //     it is never stored.
  await pageLoads(2, SECOND, "/u/0/_/BardChatUi");
  check("an incognito tab's address is not stored", !(`acct:${kSecond}:rpc_base` in store), store[`acct:${kSecond}:rpc_base`]);

  check("no email anywhere in chrome.storage.local", !/@/.test(JSON.stringify(store)), Object.keys(store).filter((k) => /@/.test(JSON.stringify(store[k]))));

  console.log(failures ? "\nRESULT: FAIL (" + failures + ")" : "\nRESULT: PASS - accounts isolated per tab and per account");
  process.exit(failures ? 1 : 0);
})();