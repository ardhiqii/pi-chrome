# pi-chrome

[![CI](https://github.com/ardhiqii/pi-chrome/actions/workflows/ci.yml/badge.svg)](https://github.com/ardhiqii/pi-chrome/actions/workflows/ci.yml)

**Give Pi the Chrome you're already signed into.**

Debug your app, inspect signed-in dashboards, and capture screenshots using your existing Chrome profile—without setting up a separate automation browser.

Built for the [Pi coding agent](https://pi.dev).

> ## ⚠️ This is a personal fork
>
> This repository is the **pi-chrome PLUS** fork of
> [`tianrendong/pi-chrome`](https://github.com/tianrendong/pi-chrome). It is **not an official
> release**, and is not affiliated with or endorsed by upstream. Its version (`0.15.51.24`, tagged
> `0.15.51-plus.24`) sorts above upstream's `0.15.51` and below a future `0.15.52`.
>
> `CHANGELOG.md` lists exactly what this fork changes; `DEPLOY.md` explains how the fork is put
> onto a local `pi-chrome` install.
>
> **Installing this fork** (it is not on npm, so `pi install npm:pi-chrome` — the line in upstream's
> README further down — installs upstream's package, without these additions):
>
> ```
> pi install git:github.com/ardhiqii/pi-chrome    # straight from this repository
> pi install ./pi-chrome                          # from a local checkout's parent folder
> pi install /absolute/path/to/pi-chrome          # from anywhere
> ```
>
> The fork's `package.json` is marked `private`, which only prevents publishing it to the npm
> registry; installing from git or a local path is unaffected.
>
> The fork sections immediately below say what makes this one different and what it adds;
> everything from the marker further down to the footer is upstream's own README, unchanged.

## What makes it different

pi-chrome is not a browser launcher. It is a connector that lets Pi drive **the Chromium window you
already have open**, in the profile you are already signed into.

| | A launched automation browser (Playwright, Puppeteer, Selenium) | **pi-chrome** |
| --- | --- | --- |
| Which browser | a fresh Chromium the library starts | **a Chromium browser already open on your desktop — Chrome, Edge, Brave, Vivaldi or Opera** |
| Sign-in state | throwaway profile — log in again, pass MFA again, extensions absent | **your real profile: cookies, extensions, history, device trust** |
| Reusing your profile | you must quit Chrome first; it will not share `user-data-dir` | **nothing to quit — the connector lives inside the running browser** |
| Transport | the library's own driver | **`127.0.0.1:17318` only — no debug port, no remote service** |
| Where it runs | a window you did not open | **the window you pick with `/chrome window`, and it does not steal focus** |
| What it is | a driver | **a driver for your agent, plus a boundary around what it may touch** |

The difference you actually feel is the login wall. An internal admin tool behind SSO, a dashboard
behind Okta, a staging app you are signed into, a page that only renders in your own window — the
other tools ask you to reproduce that state, and pi-chrome starts from it.

**Honest limits.** Browser input goes through `chrome.debugger`, so Chrome shows its automation
banner while input is attached; this is your real profile, not an invisible one. Incognito is
invisible to pi-chrome unless you allow the connector there, and native OS dialogs, passkeys,
CAPTCHA and cross-origin iframe DOM access stay outside the reliable surface — see [Limits](#limits)
and the [FAQ](./docs/FAQ.md).

**It is primitives, not an agent.** 23 `chrome_*` tools — snapshot with stable uids, find/inspect,
navigate, click, type, fill, key, hover, drag, tap, scroll, upload, evaluate, screenshots, console
and network capture, wait-for, tab and window control, and raw CDP passthrough for anything not
covered. There is no LLM loop: Pi plans, pi-chrome executes, so it can sit under any agent framework
without making you pay for an opinion you did not ask for. The [comparison page](./docs/COMPARISON.md)
lays out the three layers of this market — drivers, agent frameworks, cloud browser providers — and
where pi-chrome deliberately does not compete.

### What this fork changes about that

Upstream [`tianrendong/pi-chrome`](https://github.com/tianrendong/pi-chrome) is the base. This fork
does not add a different product; it adds strictness, evidence and repair:

- **A boundary that is enforced, not assumed.** Pi may only create, group, move or close tabs in the
  window you picked with `/chrome window`. Acting on one of your tabs in another window is still
  allowed — inspecting your own page is the point of the tool — but it is reported, not silently
  grouped: `⚠ acted on a tab in window <w>, not Pi's window <picked>`.
- **Results that carry evidence.** `chrome_type` reports `valueBefore`/`valueAfter` and `insertedAt`,
  so a mid-string splice shows up instead of a silent success; snapshot-returning actions wait for an
  in-flight navigation and say whether it settled.
- **Repairs that cannot make things worse.** `/chrome groups repair` previews first, only ever
  ungroups tabs in a stray group, never touches Pi's window, and never moves, closes or navigates a
  tab.
- **Every behaviour change ships a test that fails without it**, run in plain Node with no live
  browser (`npm test`), plus a guard that refuses to load a build whose `index.ts` is not valid as a
  Pi extension.

## What this fork adds

This fork builds on upstream's tools rather than replacing them; the additions below also change a
few existing behaviours (for example, where a new tab lands and what `chrome_type` reports). Every
item's full detail, including its limits, is in [`CHANGELOG.md`](./CHANGELOG.md).

| Addition | What it does |
| --- | --- |
| **Window pick is authoritative** | `/chrome window` records one window machine-wide; a new session starts there, Pi moves its own tab into that window, and it never creates a window or falls back to the focused one. |
| **Tab-group containment** | Pi only groups tabs in the chosen window; `/chrome groups` previews and `/chrome groups repair` ungroups a stray `Pi Agent` group elsewhere — preview first, ungroup only, and never close, move or navigate a tab. |
| **`chrome_type` reports what it did** | Results carry `valueBefore`/`valueAfter` and an `insertedAt` position; tool text warns when text was spliced into existing content, or when `pressEnter` submitted the spliced value. |
| **Fill vs. type is explicit** | `chrome_fill` replaces the field; `chrome_type` types at the caret; `chrome_type({ replace: true })` selects all first and reports `replaced: true`. |
| **Settled observations** | Snapshot-returning actions wait (bounded) for an in-flight navigation and report `navigation.settled`; `chrome_tab action=new` reports `loadStatus: complete / timedOut`. |
| **Window-aware resolution** | When a selector matches several tabs, one in the chosen window wins; page tools that report it warn with `acted on a tab in window X, not Pi's window Y` when acting on your tab in another window. |
| **Broken builds cannot load or deploy** | `scripts/check-extension-load.mjs` parses `index.ts` as an ES module (a duplicate top-level declaration once killed `/chrome` entirely); `deploy.sh` refuses a build that fails it and refuses to mix a newer install with this fork. |
| **Raw CDP passthrough** | `chrome_cdp` runs any Chrome DevTools Protocol method against a resolved tab (binary payloads are summarised, not dumped); `chrome_cdp_targets` lists that tab's CDP targets. |
| **Stalled long-poll recovery** | A half-open `/next` socket from a dead Pi process aborts on a deadline and retries by itself instead of parking the service worker. |
| **Self-maintaining screenshots** | Captures default under the OS temp folder and prune their own files (older than 7 days once more than 20 exist; the newest 20 are always kept). Pass an explicit `path:` to keep a capture. |
| **The connector is identified** | `chrome_launch` and `/chrome doctor` name the browser family and profile; `/chrome connector` (`list`, a key, or `auto`) chooses between installed connectors. |
| **`/chrome revoke` deactivates every tool** | Revoking, or authorization expiring, removes every registered `chrome_*` tool from the session's active set; a unit test asserts set equality against every registration so a new tool cannot drift out of it. Calls were always authorization-checked — this fixes the listing, not a bypass. |
| **Attach keeps focus-gated pages working** | Every fresh debugger attach asks the page to report itself focused (`Emulation.setFocusEmulationEnabled`), best-effort: it never fails or detaches the attach, and it is not a fix for hidden-tab rendering. |
| **Edge and blank-tab faults fixed** | A fresh automation tab now runs page actions on Edge and on `about:blank`; a session that does not own the bridge names the real reason instead of "no connector"; a `/reload` can no longer silently load nothing. |

### Versioning

The numeric `version` in `package.json` is what the extension's self-reload check compares (it is
advertised to the companion as `x-pi-chrome-version`), so Chrome requires it to be 1–4
dot-separated integers. The fork's display tag lives in `manifest.json`'s `version_name` as
`0.X.Y-plus.N`. `npm run version` (`scripts/sync-manifest-version.mjs`) derives and writes both from
the one `package.json` version, so the tag cannot lag the build.

### Pi tab groups and `/chrome groups repair`

A Pi tab group is the `Pi Agent` group Pi creates around its own automation tab — and around a tab
it adopts — to keep its pages visually separate from yours. A group belongs in the window chosen
with `/chrome window`; a `Pi Agent` group in any other window is a stray (it can be left behind
by an older build that adopted a tab there). `/chrome groups` previews the repair as a read-only
dry run, and `/chrome groups repair` — also offered as **Repair stray Pi groups…** in the bare
`/chrome` picker — lists exactly which tabs would be ungrouped and asks for confirmation first.
Repair only ungroups: it never closes, moves or navigates a tab, and it never touches Pi's window.
`chrome_tab` exposes the same two reads under `action: "groups"` and `action: "repair-groups"`
(`apply: true` applies after previewing).

### Repository layout

| Path | What it is |
| --- | --- |
| `extensions/chrome-profile-bridge/` | The Pi extension (`index.ts`) and its unpacked MV3 companion under `browser-extension/`. |
| `test-suite/` | Plain-Node unit tests (`unit/`) plus the static benchmark pages and manifests used to grade browser control; see [`test-suite/README.md`](./test-suite/README.md). |
| `scripts/` | `sync-manifest-version.mjs` (keeps the package and extension manifest versions in lockstep) and `check-extension-load.mjs` (the ES-module parse guard). |
| `docs/` | Documentation index, architecture, examples, FAQ and comparisons — start at [`docs/README.md`](./docs/README.md). |
| `deploy.sh` | Maintainer tooling (not shipped in the package): copies this fork's changed files into a live `~/.pi/agent/npm/node_modules/pi-chrome` install. Installing pi-chrome normally does not need it. |
| `DEPLOY.md` | Maintainer guide: deploy, reload and rollback for a live unpacked install. |
| `CHANGELOG.md` | Upstream's changelog with the `FORK ADDITIONS` section at the top. |
| `package.json` | The Pi package manifest: scripts, metadata and the `pi.extensions` entry. |

---

*The remainder of this file — from the next section to the footer — is upstream's README, unchanged.*

## What you can do

Try prompts like these after setup:

| Use case | Ask Pi |
| --- | --- |
| **Debug a signed-in app** | “Reproduce the filter bug in my staging app. Inspect captured console and network errors, then save a screenshot.” |
| **Understand an existing page** | “Find my open dashboard tab and summarize what's on the page. Don't change anything.” |
| **Create evidence for a PR** | “On my local app, capture the empty, loading, and populated states of this feature for my PR.” |

Pi gets tools to inspect pages, click, type, fill forms, scroll, upload files, capture screenshots, and inspect captured console logs and `fetch`/`XMLHttpRequest` responses. You describe the task; Pi handles the agent loop.

**Best fit:** interactive workflows in the Chrome profile you already use. For deterministic CI tests, consider a test framework such as Playwright; for fleets of isolated browsers, consider a hosted browser service. See [more workflows](./docs/EXAMPLES.md) and [browser-tool comparisons](./docs/COMPARISON.md).

## Quick start

**Requirements:** [Pi](https://pi.dev) and Google Chrome. Setup includes a one-time manual installation of the bundled Chrome companion extension.

> **Trust and privacy:** The companion has broad browser permissions and runs in your real Chrome profile. Review [its source](./extensions/chrome-profile-bridge/browser-extension/) before loading it, and authorize only tasks you trust. The browser bridge is local, but page content returned to Pi may be sent to your configured model provider.

### 1. Install and load the Pi package

In your terminal:

```bash
pi install npm:pi-chrome
```

Start Pi with `pi`. If Pi is already running, run `/reload` in that session **before** using the `/chrome` commands.

### 2. Connect Chrome

In Pi:

```text
/chrome onboard
```

The setup dialog shows the companion extension's folder path.

- **macOS:** after confirmation, Pi opens `chrome://extensions`, reveals the companion folder in Finder, and copies its path to your clipboard.
- **Windows/Linux:** copy the folder path shown in the dialog and open `chrome://extensions` manually. Automatic desktop opening and clipboard setup are currently macOS-only.

In Chrome:

1. Turn on **Developer mode**.
2. Click **Load unpacked**.
3. Select the companion folder shown by `/chrome onboard`. On macOS, press **Cmd+Shift+G** in the folder picker and paste the copied path.

### 3. Authorize and verify

In Pi:

```text
/chrome authorize
/chrome doctor
```

Approve the authorization prompt for a task you trust. The default authorization lasts **15 minutes**. Doctor should report `✓ Chrome is connected (...)`; follow its instructions if any checks fail.

Then try a read-only first task:

```text
List my open Chrome tabs without navigating, clicking, or changing anything.
```

Run `/chrome revoke` when finished. Use `/chrome authorize` again whenever you want to grant access for another task or session.

## Safety

- **Per-session approval.** Pi's Chrome tools require `/chrome authorize`. `/chrome revoke` locks them and requests cleanup of that session's owned automation tabs. Cleanup preserves existing user tabs.
- **Separate targets by default.** Page actions without an explicit target use a session-owned automation tab inside the window you chose with `/chrome window`. The agent can deliberately target an existing tab when your task calls for it, and when that tab is outside Pi's window the result says so instead of grouping or moving it.
- **Local transport, not a sandbox.** The bridge binds to `127.0.0.1:17318` and rejects browser-origin command requests. It does not authenticate arbitrary non-browser local callers; it is not protection against hostile processes on your machine.
- **Background mode:** `/chrome background on` (default) blocks pi-chrome tools from directly bringing Chrome to the front or switching your selected tab. Use `/chrome background off` to allow those actions, and `/chrome background status` to check the setting.

### Limits

This is browser automation, not full OS control. Native Chrome/OS dialogs, password-manager prompts, passkeys/security keys/biometrics, CAPTCHA challenges, cross-origin iframe DOM access, rich multitouch/stylus gestures, and arbitrary desktop apps are outside its reliable tool surface. Some workflows need human assistance.

If page inspection or evaluation is blocked, use screenshots and coordinate input where possible. Background pages can throttle rendering or reject focus-gated actions. See the [FAQ](./docs/FAQ.md) for details.

## Commands

```text
/chrome                      # quick connection/auth/background dashboard and controls
/chrome onboard              # one-time companion setup
/chrome authorize            # authorize this Pi session for 15 minutes
/chrome authorize 30m        # choose a duration
/chrome authorize indefinite # no time limit; revoke when finished
/chrome revoke               # lock tools and request session cleanup
/chrome doctor               # full diagnostics, including authorization/background state
/chrome background on        # default: block explicit focus/tab activation
/chrome background off       # allow foreground/watch mode
/chrome background status
```

Bare `/chrome` checks the connection without running page probes. Use `/chrome doctor` for version and page checks, troubleshooting hints, and authorization/background state.

Tool parameters are documented inline in Pi. See [architecture](./docs/ARCHITECTURE.md) for target ownership, screenshot behavior, and background-policy details.

### Updating and troubleshooting

After `pi update npm:pi-chrome`, run `/reload` in Pi and reload **Pi Chrome Connector** in `chrome://extensions`. Run `/chrome doctor` to check the connection and companion version.

---

[Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Changelog](./CHANGELOG.md) · [License](./LICENSE) · [Docs index](./docs/README.md)
