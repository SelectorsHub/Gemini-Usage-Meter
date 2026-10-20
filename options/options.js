(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (x) => { void chrome.runtime.lastError; r(x); }));
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;

  function parseList(s) {
    return [...new Set(String(s).split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 100).map(Math.round))].sort((a, b) => a - b);
  }

  let timer = null;
  function flash(msg) {
    const el = $("status");
    el.textContent = msg; el.classList.add("show");
    clearTimeout(timer); timer = setTimeout(() => el.classList.remove("show"), 1400);
  }
  async function save(patch) { await send({ type: "save_settings", patch }); flash("Saved"); }

  function fill(s) {
    for (const k of ["stripEnabled", "stripCollapsed", "notificationsEnabled", "forecastNotify"]) $(k).checked = !!s[k];
    $("thresholdsShort").value = s.thresholdsShort.join(", ");
    $("thresholdsWeekly").value = s.thresholdsWeekly.join(", ");
    $("badge").value = s.badge;
    $("pollMinutes").value = s.pollMinutes;
  }

  send({ type: "get_state" }).then((st) => { if (st && st.settings) fill(st.settings); });

  for (const k of ["stripEnabled", "stripCollapsed", "notificationsEnabled", "forecastNotify"]) {
    $(k).addEventListener("change", (e) => save({ [k]: e.target.checked }));
  }
  for (const k of ["thresholdsShort", "thresholdsWeekly"]) {
    $(k).addEventListener("change", (e) => {
      const list = parseList(e.target.value);
      e.target.value = list.join(", ");
      save({ [k]: list });
    });
  }
  $("badge").addEventListener("change", (e) => save({ badge: e.target.value }));
  $("pollMinutes").addEventListener("change", (e) => {
    const v = Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 1)));
    e.target.value = v;
    save({ pollMinutes: v });
  });
})();
