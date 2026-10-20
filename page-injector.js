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

  function post(type, payload) {
    try { window.postMessage(Object.assign({ source: SRC_OUT, type }, payload || {}), location.origin); } catch (_) {}
  }

  function authPrefix() {
    const m = location.pathname.match(/^\/u\/(\d+)(?=\/|$)/);
    return m ? m[0] : "";
  }
  function authIndex() {
    const m = location.pathname.match(/^\/u\/(\d+)(?=\/|$)/);
    return m ? Number(m[1]) : 0;
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
    const res = await nativeFetch(authPrefix() + "/_/BardChatUi/data/batchexecute?" + qs.toString(), {
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
    if (sawQuota && rows.length) post("quota_sniffed", { rows, authuser: authIndex(), at: Date.now() });
  }

  let genActive = 0;
  function genStart() { genActive++; post("gen_start", { authuser: authIndex() }); }
  function genDone() { genActive = Math.max(0, genActive - 1); post("gen_done", { authuser: authIndex() }); }

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
    if (d.type === "fetch_quota") {
      fetchQuota().then(
        (r) => post("quota_result", { id: d.id, rows: r.rows, error: r.error, complete: r.complete, authuser: authIndex() }),
        (e) => post("quota_result", { id: d.id, error: String((e && e.message) || e), authuser: authIndex() })
      );
    }
  });

  post("injector_ready", { authuser: authIndex() });
})();
