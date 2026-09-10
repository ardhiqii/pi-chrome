# pi-chrome

> Let [Pi](https://pi.dev) use your existing signed-in Chrome profile after explicit authorization.

**MIT · 0 runtime deps · loopback-only bridge (`127.0.0.1:17318`) · inspectable unpacked Chrome extension.** Review [`extensions/chrome-profile-bridge/browser-extension/`](./extensions/chrome-profile-bridge/browser-extension) before loading. Verify setup with `/chrome doctor`.

```text
You:    "Find my open GitHub PR tab, summarize review state, and screenshot failing CI."
Agent:  chrome_tab(list) → chrome_snapshot(uid:…) → chrome_screenshot(...)
        ✓ 3 reviewers, 1 change requested, CI red on iOS. Saved → .pi/chrome-screenshots/ci.png
You:    [keeps coding — agent never asked you to log in]
```

`pi-chrome` runs through a small Chrome extension inside the Chrome profile **you already use** — including sites where you're already signed in. Agents can inspect or control Chrome only after you run `/chrome authorize` in current Pi session.

---

## Install

```bash
pi install npm:pi-chrome
```

In Pi:

```text
/chrome onboard
```

This opens `chrome://extensions` and copies bundled extension path. In Chrome Extensions:

1. Turn on **Developer mode**.
2. Click **Load unpacked**.
3. Open path field with **Cmd+Shift+G** on macOS or **Ctrl+L** on Windows/Linux.
4. Paste copied path.
5. Press Enter.

Reload Pi so installed package loads:

```text
/reload
```

Check bridge:

```text
/chrome doctor
```

You should see:

```text
✓ Chrome is connected (...)
```

Authorize current session:

```text
/chrome authorize
/chrome doctor
```

Second doctor run should show all checks passing.

---

## What it can do

- Read and summarize pages you're already signed into.
- Click, type, fill forms, scroll, drag, tap, and upload files.
- Capture screenshots for bugs, PRs, and demos.
- Inspect console logs and captured `fetch`/`XMLHttpRequest` responses.
- Manage tabs without taking over your active window.

Tool parameters and gotchas are documented inline in Pi.

### Typing into rich editors

`chrome_type` and `chrome_fill` use one native CDP `Input.insertText` operation for focused contenteditables. This avoids per-character delays for long text and preserves Unicode/newlines. Ordinary inputs and textareas retain individual key events.

For an editor that needs a `keydown` for every character, pass `perCharacter:true`. Bulk insertion still uses Chrome's input system, but does not emit per-character key events or a clipboard `paste` event. Use `includeSnapshot:true` to verify the result; `chrome_fill` still honors `domFallback:false` when synthetic fallback is unwanted.

---

## Safety model

Chrome control is locked by default. Authorize per Pi session:

```text
/chrome authorize          # 15 minutes
/chrome authorize 30m      # custom duration
/chrome authorize indefinite
/chrome revoke             # lock again
/chrome status
```

Safety properties:

- Extension runs in your real Chrome profile and has broad tab/scripting permissions. Install only from trusted package source.
- Pi side binds to `127.0.0.1:17318` only; no default network exposure.
- Bridge rejects browser-origin command requests, so ordinary web pages cannot drive it through CORS.
- Each Pi session gets its own automation target; user tabs/windows are not closed by cleanup.
- `/chrome revoke` closes only calling session's automation target.

Security details: [`SECURITY.md`](./SECURITY.md). Architecture details: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Commands

```text
/chrome onboard             # guided setup
/chrome doctor              # connectivity + version + eval checks
/chrome status              # connection + auth + background state
/chrome authorize [duration]
/chrome revoke
/chrome background on       # default: hard background policy
/chrome background off      # foreground/watch mode
/chrome background status
```

If loaded extension is older than installed `pi-chrome`, `/chrome doctor` tells you to reload it from `chrome://extensions`.

### Background policy

`/chrome background on` is enforced, not an overridable default. Per-call `background:false` cannot bring Chrome forward, new tabs stay inactive, and `chrome_tab activate` is blocked. Use the existing `/chrome background off` for foreground/watch mode; per-call `background:true` still works when that mode is off.

Screenshots use CDP without activating background tabs. Debugger/capture failures return errors, never an activation fallback. Reload both Pi and the Chrome companion after upgrading; old companions reject background tab creation/screenshots rather than silently switching tabs.

This prevents explicit pi-chrome focus/activation, not every Chrome/OS side effect. Trusted input, page popups, native prompts, debugger banners, and macOS Spaces can still affect focus. Inactive pages may throttle rendering or reject focus-gated actions. See [scope and risks](./docs/ARCHITECTURE.md#scope-and-risks).

---

## Limits

`pi-chrome` works best on web-page workflows exposed through DOM, screenshots, tabs, network, console, and Chrome input. It is not full OS automation.

Current limits include native Chrome/OS surfaces, print/save dialogs, permission bubbles, password-manager prompts, cross-origin iframe DOM access, CAPTCHA/bot challenges, passkeys/security keys/biometrics, rich multitouch/pinch/stylus gestures, and arbitrary desktop apps.

For strict-CSP pages, use screenshots + coordinate input when snapshot/evaluate paths are blocked.

---

## Docs

- Examples: [`docs/EXAMPLES.md`](./docs/EXAMPLES.md)
- FAQ: [`docs/FAQ.md`](./docs/FAQ.md)
- Comparison: [`docs/COMPARISON.md`](./docs/COMPARISON.md)
- Security: [`SECURITY.md`](./SECURITY.md)
- Benchmark suite: [`test-suite/README.md`](./test-suite/README.md)
- Architecture: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

---

## License

MIT. See [LICENSE](./LICENSE).
