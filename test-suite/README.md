# pi-chrome browser-control benchmark

Static benchmark pages for evaluating tools that let agents control Chrome. The suite has two layers:

1. **Unit challenges** (`manifest.json`) — MiniWoB-style capability probes for
   forms, scroll containers, contenteditable, files, frames, Shadow DOM,
   network/console inspection, `isTrusted`, user activation, pointer paths, key
   cadence, native controls, drag/drop, touch, paste, and scroll momentum.
2. **Long-horizon hermetic tasks** (`task-manifest.json`) — WebArena /
   BrowserGym-inspired multi-step tasks with fresh run IDs and deterministic
   programmatic graders.

## Run

```bash
cd test-suite
python3 -m http.server 8765
# open http://127.0.0.1:8765/ in the Chrome window pi-chrome controls
```

Each challenge page exposes:

- `window.__challenge` — id
- `window.__verdict` — `"PENDING" | "PASS" | "FAIL" | "SKIP" | "WARN"`
- `window.__reason` — array of reasons
- `window.__events` — raw event log for forensics

`manifest.json` is the source of truth for unit-challenge metadata: category,
gate bucket, goal, expected result per mode, prerequisites, flake risk, manual
baseline status, and canonical tool recipe. `manifest.schema.json` documents the
manifest shape. Recipes express tool intent; runners may need to adapt
descriptive selectors (e.g. shadow/iframe notation), dynamic tab ids, and expand
path placeholders like `$PWD`.

`task-manifest.json` is the source of truth for long-horizon tasks: BrowserGym-style
`taskId`, seed, viewport, goal object, difficulty tier, max steps, declared
action subsets, reset/setup URL, validate hook, optional cheat recipe, and
programmatic grader expression. `task-manifest.schema.json` documents this shape.
`browsergym-action-space.json` records BrowserGym-compatible action subsets.

## Modes / expected outcomes

The same page can have different expected results depending on tool capability:

- `synthetic` — DOM-dispatched events / framework-aware setters. Fast and quiet.
- `trusted` — browser-trusted input, usually via `chrome.debugger`/CDP. Can show
  Chrome's debugging banner.
- `manual` — human baseline in same browser/profile.

Expected values in `manifest.json`:

- `PASS` / `FAIL` — deterministic target for that mode.
- `CONDITIONAL` — depends on browser policy, OS, device capability, permissions,
  or an unreleased tool primitive. Inspect `prerequisites`, `notes`, and
  `flakeRisk`.

Manual baselines are tracked separately with `manualBaseline`. `unverified`
means the manual expectation is a target, not a recorded contract.

## Gate buckets

Each unit challenge has a `gate` field:

- `core` — required release blocker for normal trusted-mode pi-chrome shipping.
- `conditional` — blocks only when declared prerequisites/capabilities are present
  (clipboard, touch, dialogs, native UI, etc.).
- `quality` — adversarial humanization/fingerprint signal. Track regressions, but
  do not block general ship without an explicit product decision.

## Recommended unit-challenge agent flow

1. Navigate to dashboard:
   `http://127.0.0.1:8765/`.
2. Pick mode (`synthetic`, `trusted`, or `manual`) and clear local verdicts.
3. For each manifest row:
   - `chrome_navigate` to `http://127.0.0.1:8765/<file>`.
   - `chrome_snapshot` before acting; prefer snapshot `uid` over raw selector.
   - Execute the listed `recipe`, adapting descriptive frame/shadow selectors to
     whatever selectors/uids the tool exposes.
   - Read:
     ```js
     JSON.stringify({
       v: window.__verdict,
       r: window.__reason,
       e: window.__events?.slice(-20)
     })
     ```
4. Return to dashboard and compare actual verdicts with expected values.
5. Copy JSON report from dashboard for PRs or regression notes.

## Recommended long-horizon task flow

1. Load `task-manifest.json`.
2. Replace `$RUN_ID` in `startUrl` with a fresh value.
3. Navigate to the start URL and read the visible task instruction.
4. Solve using normal browser tools only; avoid direct state mutation unless the
   benchmark mode explicitly allows evaluate-based actions.
5. Click **Grade now** or evaluate the task grader expression:
   ```js
   JSON.stringify({ v: window.__taskVerdict, r: window.__taskReason })
   ```
6. Record action count, observations used, tools used, verdict, and reason.

## Design principles copied from browser-agent benchmarks

- Prefer hermetic sites and deterministic graders over live sites and LLM judges.
- Report action API and observation format; these strongly affect scores.
- Use difficulty tiers: L1 atomic, L2 compositional, L3 cross-page/context-rich.
- Include tedious cross-page memory and exact-value transfer tasks; short unit
  probes hide these failures.
- Keep synthetic-event-gated tests because extension bridges face failures that
  CDP/Playwright-style benchmarks usually do not measure.

## Challenge categories

- `trusted-input` — browser-trusted click/key events.
- `pointer-humanization` — paths, coordinates, movement continuity/rate.
- `keyboard` / `focus-keyboard` — typing fidelity, modifiers, Tab flows.
- `activation-gates` — clipboard/fullscreen/user activation.
- `scroll` / `scroll-visibility` — wheel events, momentum, IntersectionObserver.
- `drag-drop` — HTML5 drag/drop + `DataTransfer`.
- `clipboard` — OS/browser paste path.
- `native-controls` — controls that should use browser UI/keyboard semantics.
- `frameworks` / `editing` — React-style value tracking, contenteditable.
- `dom-complexity` / `frames` — Shadow DOM and iframe targeting.
- `files` — file attachment to `<input type=file>`.
- `observability` — console/network capture tools.
- `csp` — strict Content Security Policy: screenshot/coordinate fallback (39) and the CDP eval/snapshot bypass that works under `script-src 'self'` without `unsafe-eval` (42).
- `lazy-loading` — dynamic DOM readiness and wait behavior.
- `fingerprint` — environment and stack fingerprint probes.
- `agent-safety` — hidden honeypots and safe target selection.

## Current challenge inventory

The dashboard renders this from `manifest.json`. In brief:

1. trusted click
2. trusted keyboard
3. webdriver/runtime flags
4. mouse entropy before click
5. click timing
6. click coordinate variation
7. pointer event properties
8. keyboard cadence
9. beforeinput/input order
10. user activation gates
11. honeypot safety
12. fingerprint consistency
13. focus order
14. wheel scroll
15. drag/drop `DataTransfer`
16. contenteditable selection
17. paste clipboard
18. native select
19. hover dwell
20. React value tracker
21. keyboard modifiers
22. touch events
23. stack trace fingerprint
24. viewport click coordinates
25. pointer continuity
26. mousemove rate
27. scroll momentum
28. intersection visibility
29. Shadow DOM controls
30. iframe targeting
31. file upload
32. keyboard Tab navigation
33. network/console capture
34. dialog handling
35. target blank popup
36. modal focus trap
37. autocomplete combobox
38. SPA route change
39. strict CSP screenshot/coordinate fallback
40. dynamic wait/readiness
41. explicit tab lifecycle
42. strict CSP eval/snapshot via CDP (regression guard for the CSP bypass)
43. hard background: inactive-tab visibility and trusted input
44. input reliability: native rich-editor insertion, full replacement, per-character override, Shift chords, single Enter, and file upload

### Input regressions (16, 21, 31, 44)

Challenge 44 exercises `chrome_type`/`chrome_fill` bulk insertion into contenteditables, including long Unicode text and multiple paragraphs. It also checks `perCharacter:true`, Shift-only printable keys, one Enter per `pressEnter`, and real file contents. Read `window.__inputFixture.caption` and follow its manifest recipe. Use `domFallback:false` to ensure failures are not hidden by synthetic events.

Challenge 16 intentionally requests `perCharacter:true`: its grader requires a caret update for each keystroke. Challenge 21 focuses its field before sending Shift+a and grades after Shift release, not during the earlier input event. Challenge 31 retains standalone upload coverage.

`npm test` also fault-injects zero/missing/rejected upload node IDs, attachment/cleanup failures, stale UIDs, insertion failures, shortcut suppression, and authorization/option forwarding. These mocked tests cannot prove `isTrusted` or real browser selection behavior; run the browser challenges too.

### Hard-background regression (43)

Keep `/chrome background on`. Open challenge 43, then manually select a different tab in the **same window** and return to Pi. Target the challenge URL explicitly, arm its probe, and run its manifest recipe without selecting the target again. Inspect the saved screenshot for the colored target. The page detects visibility changes and synthetic input; it cannot establish OS focus or macOS Spaces behavior.

Separately live-test with Chrome behind another app, a minimized window, multiple windows, and macOS Spaces. Confirm the foreground app/window and each active tab stay unchanged during background new-tab creation, viewport/full-page screenshots, and trusted input. Confirm `/chrome background off` permits explicit activation. Native prompts/page popups are outside this focus policy, not a zero-focus guarantee.

`npm test` runs mocked regressions for every registered tool's policy, old-companion rejection, worker focus writes, CDP capture success/failure, trusted input, and full-page scroll restoration. No live Chrome is required; Node.js 22.13+ is required for TypeScript stripping.

## Design notes

- A failure is useful only when compared to expected mode. Example: synthetic
  `isTrusted` failing is expected and validates that the test detects quiet DOM
  events.
- Some tests are capability-gated. Example: touch tests should be `SKIP`/manual
  conditional on non-touch hardware.
- Fingerprint tests should warn before blocking. Real Chrome profiles can use
  software WebGL in VMs, remote desktops, or policy-constrained environments.
- `notes/bypass-ideas.md` is historical guidance for older synthetic-only
  versions. Prefer `manifest.json` for current expected outcomes.
- `notes/browsergym-compat.md` defines the reset/step/validate/observation/BID
  contract for external BrowserGym-style agents.
- `notes/runner-spec.md`, `notes/scoring.md`, and `notes/profiles.md` define
  runner output, scoring, retry policy, and environment metadata.
