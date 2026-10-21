# Gemini Usage Meter

A Chrome extension (Manifest V3) that shows your Gemini usage right where you type, by SelectorsHub. It's the Gemini counterpart of Claude Usage Meter.

- **In-composer strip**: a slim pill just above Gemini's chat box showing the **5-hour** and **weekly** limits (percent used, reset time, a thin usage bar), the **chat size** in tokens against your plan's context window, and the current **mode** (Fast / Thinking / Pro). It sheds detail as the composer narrows and collapses to rings when space is tight.
- **Limit forecast**: an "~37m left" chip when your pace says you'll hit a limit before it resets. It needs about 12 minutes of data.
- **Toolbar popup**: 5-hour and weekly cards with exact reset times, per-feature limits for accounts metered that way, plan and mode, strip toggles, and the SelectorsHub tools drawer. Opening it forces a fresh reading.
- **Toolbar badge**: the higher of the two percentages, coloured by level.
- **Desktop alerts**: at thresholds you choose (default 75 / 90 / 100 %), plus a one-time heads-up when you're about to run out.

## Install (unpacked)

1. Unzip the folder.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `Gemini-Usage-Meter` folder.
5. Sign in at gemini.google.com in the same browser profile and open a chat.

## Where the numbers come from

Gemini's own **Settings › Usage limits** page and its in-chat usage badge read an internal RPC, `BardFrontendService.CheckGeminiQuota` (batchexecute rpcid `qpEbW`). Each reply row looks like this:

```
[ [mode, action, ?],  unit,  percentUsed,  [resetEpochSec, nanos],  remaining,  limit ]
```

- **`action 2` is the compute-based usage meter.** It comes back once per window: the short window that refreshes every 5 hours, and the weekly limit. Gemini's badge shows the higher of the two, and so does this extension's toolbar badge. The extension asks for it with the same context the app uses (`[[1,2]]`).
- **Other actions are per-feature counters**: limit / remaining / reset time, used by some Workspace and older plans. Gemini doesn't name them in the data, so the popup lists them as "Limit #N" rather than guessing. The strip shows the tightest one as "Top limit".
- The window type (`unit`) is cross-checked against reset distance, so a renumbering on Google's side can't swap the 5-hour and weekly labels.

### How the call is made

1. **Through an open Gemini tab (preferred).** `page-injector.js` runs in the page's main world and calls `qpEbW` with the page's own XSRF token (`WIZ_global_data.SNlM0e`), build label and session id. It's the same origin, cookies and headers the app itself uses.
2. **Listening in.** When Gemini fetches its quota for its own UI, the injector copies the rows (read-only, from a clone), so the meter moves when Gemini's own badge would. When a reply finishes (a `StreamGenerate` request closes), the worker re-reads usage 2.5 s later and the chat size is recounted.
3. **No Gemini tab open (fallback).** The service worker reads the tokens out of `/app`, then calls `qpEbW` directly. A session `declarativeNetRequest` rule gives only those extension-initiated requests a `gemini.google.com` Origin. With no Gemini tab, polling slows to every 5 minutes.

Multiple Google accounts are followed through the `/u/N/` path of the tab you're using.

## Chat size

Gemini re-reads the whole conversation with each message, so the chat's size is the usage number you can act on: start a new chat. It's counted from the turns on the page (prompts, replies excluding the thinking panel, and images at 258 tokens each) with the same word/symbol-piece estimator as Claude Usage Meter. The denominator comes from the plan badge in Gemini's sidebar: 32K with no plan, 128K on AI Plus, and 1M on AI Pro / Ultra. Attached files, Gem instructions and turns not yet loaded aren't counted, which the tooltip notes.

## Files

```
Gemini-Usage-Meter/
├── manifest.json        MV3 manifest (host: gemini.google.com)
├── background.js        Service worker: polling, parsing, forecast, alerts, badge, fallback fetch
├── page-injector.js     Main world: makes the quota call, sniffs the app's own quota + reply traffic
├── content-script.js    Isolated world: bridge, page facts (account, mode, plan), strip, chat size
├── overlay.css          Strip + popover styles (follows Gemini's light/dark theme)
├── popup/               Toolbar popup (+ tools drawer)
├── options/             Settings page
└── icons/               Gauge icons; icons/tools/ for the SelectorsHub menu
```

## Store links, welcome and goodbye pages (v1.0.1)

- Review page: the Chrome Web Store listing's `/reviews` page (`CHROME_REVIEW_URL`). Set `EDGE_REVIEW_URL` once the Edge Add-ons listing exists; until then Edge users are sent to the Chrome listing.
- Welcome page on fresh install: `https://www.selectorshub.com/gemini-usage-meter-installed/`
- Goodbye page on uninstall: `https://www.selectorshub.com/gemini-usage-meter-uninstalled/?v=<version>&b=<chrome|edge>&d=<days installed>`

## Rating prompt (same concept as Claude Usage Meter)

- **Rate us button** in the strip, 2 days after install. Tooltip: "Pls Rate us & this button disappears forever after you review."
- **Rating card** pointing at that button, from 3 days after install, then every 2 days until the person rates. 5 stars and "Write a review" open the review page; "Maybe later", × and Esc dismiss it. The button pulses while the card is open. It never covers another popover, waits until the tab is visible, and only one Gemini tab shows it.
- **Rate us in the toolbar popup**, until rated.
- Rating anywhere (`rate_us_clicked`) hides all three for good.

**Test build:** set `PROMPT_TEST = true` in `background.js` and `RATE_TEST = true` in `content-script.js`. The button shows straight away, the card pops 3 seconds after Gemini loads and returns 1 minute after a dismissal, and every Reload in `chrome://extensions` resets the rating state. Set both back to `false` before packaging for the store.

## Caveats

- `CheckGeminiQuota` and its row shape are undocumented and can change. The parser tolerates missing fields; if Google moves the RPC, the strip says it's waiting for data instead of showing wrong numbers.
- Gemini rolled out the compute-based 5-hour and weekly limits in May 2026 for personal accounts. Workspace accounts may still only report per-feature counters, and they get the "Top limit" view.
- Tracks the Gemini web app, not Gemini API keys or the Gemini CLI.

## Permissions

- `storage`, `alarms`, `notifications`, `tabs`: local state, polling, alerts, and finding open Gemini tabs.
- `declarativeNetRequestWithHostAccess`: the single session rule for the no-tab fallback.
- `host_permissions: gemini.google.com`: to read usage and draw the strip.

Nothing leaves your browser.
