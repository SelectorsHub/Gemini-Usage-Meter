// page-injector.js — runs in gemini.google.com's MAIN world (document_start).
//
// Two jobs:
//
// 1. Ask Gemini for its quota. Gemini's own "Usage limits" page and usage badge
//    read BardFrontendService.CheckGeminiQuota (batchexecute rpcid "qpEbW").
//    The call needs the page's XSRF token (WIZ_global_data.SNlM0e), build label
//    (cfb2h) and session id (FdrFJe), which only exist in the page's own JS
//    world, so the content script asks us to make the call and we hand back the
//    raw rows. Same origin, same cookies, same headers as the app itself.
//
// 2. Listen in. When the app fetches qpEbW for its own UI, we copy the rows
//    (free, instant updates). When a StreamGenerate request (a prompt being
//    answered) finishes, we say so, so the meter can refresh right after a reply
//    instead of waiting for the next poll.
//
// Nothing is modified: responses are read from clones / after load.
(() => {
  "use strict";
  if (window.__gumInjected) return;
  window.__gumInjected = true;

  const SRC_OUT = "gum-injector";
  const SRC_IN = "gum-cs";
  const RPC_QUOTA = "qpEbW";            // BardFrontendService.CheckGeminiQuota
  const GEN_RE = /\/StreamGenerate\b/;
  const BATCH_RE = /\/batchexecute\b/;

  // Contexts we ask for. {mode:1, action:2} is the compute-based usage meter
  // (the 5-hour window and the weekly limit) that Gemini's own badge shows.
  // The empty request returns every per-feature counter the account has.
  const ARGS_COMPUTE = JSON.stringify([[[1, 2]]]);
  const ARGS_ALL = "[]";

  // v1.0.3: WHO is signed in. The 21-digit Google user id (S06Grb) lives in the
  // same WIZ_global_data object that supplies the XSRF / session tokens used for
  // the call below, so the account and the call can never disagree. Nothing
  // here looks at /u/N: the account is identified by its user id only.
  function acctId() {
    try {
      const v = (window.WIZ_global_data || {}).S06Grb;
      if (typeof v === "string" && /^\d{10,25}$/.test(v.trim())) return v.trim();
    } catch (_) {}
    return null;
  }

  // The page's RPC base (e.g. "/u/1/_/BardChatUi"), reported so the background's fallback request can address this
  // same session later. It is only an address: the account is identified by S06Grb, never by this.
  function rpcOrNull() {
    try { return rpcBase(); } catch (_) { return null; }
  }

  function post(type, payload) {
    try {
      window.postMessage(Object.assign({ source: SRC_OUT, type, acct: acctId(), rpc: rpcOrNull() }, payload || {}), location.origin);
    } catch (_) {}
  }

  // The batchexecute endpoint is the page's own RPC base (WIZ_global_data.Im6cmf).
  // It is used verbatim: on /u/0/app it is "/u/0/_/BardChatUi", so the call goes to
  // the same session the page is on, and this code never parses the path. If the
  // page doesn't expose it, fail rather than guess a session.
  function rpcBase() {
    const b = (window.WIZ_global_data || {}).Im6cmf;
    if (typeof b === "string" && b.startsWith("/")) return b.replace(/\/+$/, "");
    throw new Error("no_rpc_base");
  }

  // ---- batchexecute response parsing -------------------------------------
  // Body: ")]}'" then length-prefixed JSON chunks (rt=c). Each chunk is an
  // array of envelopes; a result envelope is ["wrb.fr", rpcid, payloadJson,
  // null, null, errorStatus?, tag].
  function parseBatch(text) {
    const out = [];
    if (typeof text !== "string") return out;
    const lines = text.split("\n");
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("[")) continue;
      let arr;
      try { arr = JSON.parse(s); } catch (_) { continue; }
      if (!Array.isArray(arr)) continue;
      for (const env of arr) {
        if (!Array.isArray(env) || env[0] !== "wrb.fr") continue;
        let data = null;
        if (typeof env[2] === "string") { try { data = JSON.parse(env[2]); } catch (_) {} }
        out.push({ rpc: env[1], data, error: Array.isArray(env[5]) ? env[5][0] : null });
      }
    }
    return out;
  }

  function quotaRowsFrom(text) {
    const rows = [];
    let sawQuota = false;
    let error = null;
    for (const e of parseBatch(text)) {
      if (e.rpc !== RPC_QUOTA) continue;
      sawQuota = true;
      if (e.error != null) { error = e.error; continue; }
      if (Array.isArray(e.data) && Array.isArray(e.data[0])) rows.push(...e.data[0]);
    }
    return { sawQuota, rows, error };
  }

  // ---- making the call ---------------------------------------------------
  let reqSeq = Math.floor(Math.random() * 9000) + 1000;

  async function callQuota(args) {
    const W = window.WIZ_global_data || {};
    const at = W.SNlM0e;
    if (!at) throw new Error("signed_out");
    const qs = new URLSearchParams({
      rpcids: RPC_QUOTA,
      "source-path": location.pathname.replace(/^\/u\/\d+/, "") || "/app",
      bl: W.cfb2h || "",
      "f.sid": W.FdrFJe || "",
      hl: document.documentElement.lang || "en",
      _reqid: String((reqSeq += 100000)),
      rt: "c"
    });
    const body = new URLSearchParams({
      "f.req": JSON.stringify([[[RPC_QUOTA, args, null, "generic"]]]),
      at
    });
    const res = await nativeFetch(rpcBase() + "/data/batchexecute?" + qs.toString(), {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1"
      },
      body
    });
    if (res.status === 401 || res.status === 403) throw new Error("signed_out");
    if (!res.ok) throw new Error("http_" + res.status);
    return quotaRowsFrom(await res.text());
  }

  async function fetchQuota() {
    const [compute, all] = await Promise.allSettled([callQuota(ARGS_COMPUTE), callQuota(ARGS_ALL)]);
    if (compute.status === "rejected" && all.status === "rejected") throw compute.reason;
    const rows = [];
    let error = null;
    let complete = true;
    for (const r of [compute, all]) {
      if (r.status !== "fulfilled") { complete = false; continue; }
      rows.push(...r.value.rows);
      if (r.value.error != null || !r.value.sawQuota) { error = r.value.error != null ? r.value.error : "no_quota"; complete = false; }
    }
    return { rows, error, complete };
  }

  // ---- listening in --------------------------------------------------------
  const nativeFetch = window.fetch.bind(window);

  function urlOf(input) {
    try { return typeof input === "string" ? input : (input && input.url) || String(input); } catch (_) { return ""; }
  }
  function isQuotaUrl(u) { return BATCH_RE.test(u) && u.indexOf(RPC_QUOTA) !== -1; }

  function onQuotaText(text) {
    const { sawQuota, rows } = quotaRowsFrom(text);
    if (sawQuota && rows.length) post("quota_sniffed", { rows, at: Date.now() });
  }

  let genActive = 0;
  function genStart() { genActive++; post("gen_start"); }
  function genDone() { genActive = Math.max(0, genActive - 1); post("gen_done"); }

  window.fetch = function (input, init) {
    const u = urlOf(input);
    const isGen = GEN_RE.test(u);
    if (isGen) genStart();
    const p = nativeFetch(input, init);
    if (isQuotaUrl(u)) {
      p.then((res) => res.clone().text()).then(onQuotaText).catch(() => {});
    }
    if (isGen) {
      p.then((res) => res.clone().text()).then(genDone, genDone).catch(genDone);
    }
    return p;
  };

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__gumUrl = String(url || ""); } catch (_) {}
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const u = this.__gumUrl || "";
    if (isQuotaUrl(u)) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") onQuotaText(this.responseText);
        } catch (_) {}
      });
    } else if (GEN_RE.test(u)) {
      genStart();
      let done = false;
      const fin = () => { if (!done) { done = true; genDone(); } };
      this.addEventListener("loadend", fin);
    }
    return XS.apply(this, arguments);
  };

  // ---- requests from the content script ----------------------------------
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== SRC_IN) return;
    if (d.type === "get_acct") {
      post("acct_result", { id: d.id });
      return;
    }
    if (d.type === "fetch_quota") {
      fetchQuota().then(
        (r) => post("quota_result", { id: d.id, rows: r.rows, error: r.error, complete: r.complete }),
        (e) => post("quota_result", { id: d.id, error: String((e && e.message) || e) })
      );
    }
  });

  post("injector_ready");
})();
