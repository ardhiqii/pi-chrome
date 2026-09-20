# Deploying this fork's build

**Maintainer tooling.** You do not need this, or `deploy.sh`, to install pi-chrome: install it the
normal way (`pi install`) and it works as a released package. This document is only for the fork's
maintainer, who keeps this repository as the master copy and copies changed files into a live
unpacked install. Neither `deploy.sh` nor this file is shipped inside the package.

This folder is a **fork** of [`pi-chrome`](https://github.com/tianrendong/pi-chrome) carrying a
small set of additions (see `CHANGELOG.md`). It is not an official release and is not offered
upstream.

The fork exists because `pi-chrome` installs into a package directory (by default
`~/.pi/agent/npm/node_modules/pi-chrome`), and a normal `npm`/`pi` update overwrites anything
edited in place. This repo is the master copy; `deploy.sh` copies the changed files back into the
live install.

The live browser extension keeps loading from the same unpacked folder it already uses:

```
~/.pi/agent/npm/node_modules/pi-chrome/extensions/chrome-profile-bridge/browser-extension
```

Override that location with `PI_CHROME_INSTALL_DIR` if your install lives elsewhere.

**You never need to re-add the extension in `edge://extensions`, and this build never moves or
reinstalls it.** Deployment only overwrites the files listed below in that existing install.

---

## What this fork adds

| File | Change |
| --- | --- |
| `browser-extension/service_worker.js` | Raw CDP passthrough (`cdp.call`), CDP target diagnostics (`cdp.targets`), best-effort focus emulation on attach, stalled long-poll recovery, unified `Pi Agent` tab group |
| `index.ts` | Pi-side tools `chrome_cdp` and `chrome_cdp_targets`; screenshots default to the OS temp with capture-time retention |
| `package.json`, `browser-extension/manifest.json` | The fork's version (`0.15.51.23`, tagged `0.15.51-plus.23`), so the build is distinguishable from stock |

What you get, in plain terms:

- **`chrome_cdp`** — run any Chrome DevTools Protocol method against a tab (for example
  `Page.captureScreenshot`, `Runtime.evaluate`, `DOM.getDocument`, `Emulation.*`). This is a
  powerful low-level escape hatch; nothing is filtered or validated against a safe list.
  Screenshots and other binary payloads are summarised by size instead of dumping megabytes of
  base64 into the conversation.
- **`chrome_cdp_targets`** — list the CDP targets anchored to a resolved tab (including
  password-manager/autofill/devtools overlay targets), tab-scoped so unrelated tab URLs do not
  leak into the conversation. Use it when input or screenshots fail with
  `Detached while handling command`.
- **Focus emulation on attach** — a best-effort `Emulation.setFocusEmulationEnabled` after
  attaching, so focus-gated pages behave better. It does **not** make hidden tabs produce
  animation frames, so it is not a screenshot fix.
- **Stalled long-poll recovery** — `/next` is a server-side long poll; a half-open socket left by
  a dead Pi process used to park the service worker permanently. It now aborts on a deadline and
  retries by itself.
- **Screenshot retention and location** — `chrome_screenshot` wrote a new timestamped file into
  `<cwd>/.pi/chrome-screenshots/` on every capture and never removed any, so the user's project
  accumulated agent-only files. Captures now default to `<os temp>/pi-chrome-screenshots/`, prune
  their own files older than 7 days once more than 20 are present, and always keep the newest 20.
  Hand-named files are never eligible. Pass an explicit `path:` for a screenshot the *user* should
  keep. `retentionDays: 0` disables pruning.
- **Which connector is being driven** — `chrome_launch`, `/chrome doctor` and `tab.version` report the
  browser family and profile id, so nothing has to assume Chrome. `/chrome connector [list|<key>|auto]`
  chooses between installed connectors; `auto` refuses to guess when more than one is connected.
- **Stray Pi tab groups can be previewed and repaired** — `/chrome groups` previews, and
  `/chrome groups repair` ungroups a leftover `Pi Agent` group outside the window chosen for Pi
  (also offered as **Repair stray Pi groups…** in the bare `/chrome` picker). Only the grouping
  changes: nothing is closed, moved or navigated.

Permissions, install path, authorization rules, and background mode are untouched.

---

## How to deploy

```bash
bash deploy.sh
```

The script copies only the files it needs to, and backs up anything it overwrites with a
timestamped `.pi-backup-<timestamp>` suffix next to the original. Running it twice is harmless:
byte-identical files are skipped, and backups stay unique even within the same second.

The script also runs `node --check` on the outgoing `service_worker.js` before touching the live
install, so a syntax error can never be deployed.

### Safety guard: newer installs are refused

This fork is **0.15.51.23**, tagged **0.15.51-plus.23**, based on upstream **0.15.51**. The 4th
integer keeps it newer than upstream 0.15.51 while still sorting below a future 0.15.52 — and it is
what lets the browser, `tab.version` and `/chrome doctor` tell this build apart from a stock
install.

`deploy.sh` copies four files: `service_worker.js`, `index.ts`, and both version manifests
(`package.json`, `manifest.json`). Copying the manifests matters twice over: `index.ts` re-reads
`package.json` on every `/next` and advertises it as `x-pi-chrome-version`, and the extension
compares that against `chrome.runtime.getManifest().version` and reloads itself when the manifest
is older. Keeping the two in lockstep is what lets a deploy **pick itself up without a manual
Reload** — but it also means they must never drift apart in the live install: a `package.json`
permanently ahead of `manifest.json` would make the extension reload on every poll.

`npm run version` (which runs `scripts/sync-manifest-version.mjs`) re-syncs them, and refuses any
version Chrome would reject. Chrome only accepts 1–4 dot-separated integers in a manifest
`version`, so a prerelease-style suffix such as `0.15.51-plus.23` cannot live there; the fork
derives `version_name` from the same numeric version as `<major>.<minor>.<patch>-plus.<build>`
(`0.15.51.23` → `0.15.51-plus.23`). Both fields are written together, so the display tag cannot
lag the build.

If an update has installed a different `pi-chrome` release, `deploy.sh` refuses to copy:
overwriting would mix a newer release's files with this fork's. Two live `package.json` versions
are accepted — this fork's `0.15.51.23`, and a clean upstream reinstall's `0.15.51`. The script also
refuses when the live `service_worker.js` is neither a known-good 0.15.51 base, nor an
already-deployed fork build, nor already identical to the source. Two 0.15.51 `service_worker.js`
files are accepted as a known-good base: the pristine release file, and the file carrying the
fork's page-target attach fix. A clean reinstall ships the pristine file and therefore deploys
without `--force`; anything else (for example a newer release) is still refused.

To re-apply this fork on top of a newer release anyway:

```bash
bash deploy.sh --force
```

Every overwritten file is still backed up first either way.

### Step 1 — Reload the extension (only when `service_worker.js` changed)

1. Open `edge://extensions`.
2. Find **Pi Chrome Connector**.
3. Click the **Reload** (circular arrow) button on its card.

**Why this is not optional when it applies:** the browser reads `service_worker.js` when the
extension loads. An unpacked MV3 service worker cannot hot-reload its own code, so the running copy
keeps executing the old file until you press Reload. Any change to `service_worker.js` is inert
until that click.

A **version-only** change is the exception: the extension notices the newer manifest version on its
next `/next` poll and reloads itself within seconds, so no click is needed. `deploy.sh` prints
which case you are in rather than always telling you to Reload.

### Step 2 — `/reload` in Pi (only when `index.ts` changed)

```
/reload
```

`index.ts` defines the Pi-side tool surface. Pi reads it when the extension module loads, so tool
changes need `/reload` (or a Pi restart). If you skip it, the new tools do not appear.

If Pi reports that Chrome control is locked, run `/chrome authorize` once, then retry.

### Quick check that it worked

- `chrome_cdp_targets` should return a list of CDP targets for the tab.
- `chrome_cdp` with `method: "Runtime.evaluate"`, `params: { expression: "document.title" }`
  should return the tab title.
- `chrome_tab` with `action: "version"` should report the fork's version (`0.15.51.23`, tagged
  `0.15.51-plus.23`).

---

## Rolling back

Every overwritten file is backed up next to itself with a `.pi-backup-<timestamp>` suffix. Copy the
backup over the live file, then Reload the extension (and `/reload` Pi if `index.ts` was involved):

```bash
cd "$HOME/.pi/agent/npm/node_modules/pi-chrome/extensions/chrome-profile-bridge"
ls browser-extension/service_worker.js.pi-backup-*
cp browser-extension/service_worker.js.pi-backup-<timestamp> browser-extension/service_worker.js
```

To drop the fork entirely, reinstall `pi-chrome`
(`pi update` / `npm i -g pi-chrome`) and re-add the extension from the fresh install.

---

## Files in this repo

- `deploy.sh` — the deploy helper described above.
- `DEPLOY.md` — this document.
- `CHANGELOG.md` — upstream's changelog, with a `FORK ADDITIONS` section at the top.
- `scripts/sync-manifest-version.mjs` — keeps `manifest.json`'s version in lockstep with
  `package.json`.
- `test-suite/unit/` — unit tests, including coverage for this fork's additions.

Run the tests with `npm test`.
