# Contributing to pi-chrome

Thanks for considering a contribution. pi-chrome aims to be a dependable browser-control toolkit
for Pi agents — that means a few non-negotiables.

## Non-negotiables

1. **No re-login.** Every change must keep working against the user's already-signed-in Chrome profile. Anything that requires a fresh profile or extra auth steps is out of scope.
2. **Verifiable action results.** Input tools must return structured details and support `includeSnapshot` where verification matters. Agents need enough evidence to avoid blind retries.
3. **Chrome real input.** Interactive controls use Chrome's input layer through `chrome.debugger`; do not re-expose synthetic/untrusted input as public UX.
4. **Evidence gates features.** A behaviour change lands with a test that fails without it — see [Tests and evidence](#tests-and-evidence) below. Add benchmark coverage in `test-suite/` when the change is about what Pi can do on a page; we accept PRs faster when there is a green/red verdict to point at.

## Tests and evidence

- **Every behaviour change ships a test that fails without the fix.** Put the red-on-revert
  evidence in the PR description or commit message: run the new test against the pre-fix build,
  paste the failure, then show it green after the change. A test that passes both before and after
  is a guard on existing behaviour, not new evidence — label it as such.
- Unit tests are plain Node scripts under `test-suite/unit/`, run by `npm test`; no live Chrome or
  extra dependencies are required.
- **The extension-load guard must pass.** Pi loads `extensions/chrome-profile-bridge/index.ts` as a
  strict ES module, and a duplicate top-level declaration is a syntax error that kills the whole
  extension — no `/chrome` command and no `chrome_*` tools. That shipped once (a repeated
  `function readPreferredWindow()`), and the other harnesses could not see it because they slice
  sections of the source into sloppy-mode `vm` scripts, where redeclaring a function is legal. Run:

  ```bash
  node scripts/check-extension-load.mjs
  ```

  `npm test` and `deploy.sh` both run this check; a build that fails it is not deployable.

## Local dev

```bash
# Link from a checkout
pi install ./pi-chrome

# Run unit regressions (Node.js 22.13+; no live Chrome required)
# Lifecycle tests use Node's built-in TypeScript stripping.
npm test

# Run the benchmark dashboard
cd test-suite
python3 -m http.server 8765
# open http://127.0.0.1:8765/ in the Chrome window pi-chrome controls
```

## Adding a new tool

1. Register it in `extensions/chrome-profile-bridge/index.ts` (search for `pi.registerTool`).
2. Implement the handler in `extensions/chrome-profile-bridge/browser-extension/service_worker.js`.
3. Return structured details and support `includeSnapshot` for user-visible state changes when relevant.
4. Add a unit test under `test-suite/unit/` that fails without the tool, and a benchmark page under
   `test-suite/challenges/` with a manifest entry when page behaviour is involved.
5. Update the relevant `README.md` or `docs/` page. Tool descriptions in `index.ts` are the agent's
   primary documentation — keep them accurate.
6. Add a `CHANGELOG.md` entry (in this fork, a `FORK ADDITIONS` bullet).

## Filing a bug

Include:

- `/chrome doctor` output
- `pi-chrome` version + extension version (the `doctor` output prints both)
- The exact tool call + the result envelope you got
- Page URL or a minimal repro page in `test-suite/`

## Releasing (this fork)

This fork is not published to npm; a release is a local deploy plus a commit.

1. Bump `package.json`'s `version` and add the matching `CHANGELOG.md` entry.
2. `npm run version` — writes the numeric version into
   `extensions/chrome-profile-bridge/browser-extension/manifest.json` and derives the
   `0.X.Y-plus.N` display tag, so the version and the tag stay in lockstep.
3. `npm test` — every unit suite must be green, including the extension-load guard.
4. `bash deploy.sh` — maintainer tooling, not part of the published package: it copies the changed
   files into `~/.pi/agent/npm/node_modules/pi-chrome` (override with `PI_CHROME_INSTALL_DIR`),
   refuses a live install it does not recognise, and prints the reload steps. Contributors who only
   want to try the fork do not need it: `pi install` this repo's path instead.
5. `/reload` in Pi when `index.ts` changed; reload **Pi Chrome Connector** at
   `chrome://extensions` when `service_worker.js` changed (a version-only change reloads itself).
   See `DEPLOY.md`.
6. Commit and push the version bump and the changelog together.

Do not run `npm publish` for this fork.

## Code of conduct

Be kind, be precise, ship things. See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). PRs that break
the "no re-login" promise will be closed with a note explaining which non-negotiable they hit.
