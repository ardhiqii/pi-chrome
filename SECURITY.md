# Security policy

## Reporting a vulnerability

Open a GitHub issue prefixed with `[security]` at
https://github.com/ardhiqii/pi-chrome/issues. If the report needs to include exploit details, keep
the first issue minimal and ask for a private channel; please coordinate before publishing a
working exploit.

## Supported versions

This is a single-maintainer personal fork. Only the tip of the default branch — currently the
`0.15.51-plus.23` build — is supported. There are no backports and no npm release of the fork: the
`pi-chrome` package on npm is upstream's, and this fork is deployed from a checkout (see
[`DEPLOY.md`](./DEPLOY.md)). Security fixes land as ordinary commits on top of the current build.

## Threat model

`pi-chrome` is a developer tool you install knowingly. It is **not** designed to defend against:

- Hostile pages running in your Chrome trying to detect or escape automation. (Standard browser security boundaries still apply, but a hostile page that already runs in your tab can do anything that page can already do.)
- Other processes on your local machine. The bridge binds to `127.0.0.1:17318` by default (loopback only), and chrome_* tools require `/chrome authorize` inside Pi, but the bridge does not authenticate arbitrary non-browser local callers. If your threat model includes hostile local processes running as you, run pi-chrome on a separate user account.

`pi-chrome` **is** designed to:

- Never exfiltrate page state to the network. All communication is loopback (`127.0.0.1`).
- Surface every action with an honest result envelope so the agent can't silently do the wrong thing.
- Keep Chrome control locked until the user explicitly runs `/chrome authorize` in the current Pi session.
- Reject browser-origin command requests to the loopback bridge so ordinary web pages cannot use CORS to drive Chrome.
- Avoid collecting credentials of its own. pi-chrome drives the Chrome profile you are already signed into; it does not ask for, collect or persist site passwords, and password-like field values are redacted from tool results (`valueRedacted: true`, no value).

## Visible footprint

Chrome shows its built-in "Pi Chrome Connector started debugging this browser" banner whenever the
debugger is attached for interactive control (see the
[FAQ](./docs/FAQ.md#why-do-i-see-a-banner-saying-pi-chrome-connector-started-debugging-this-browser)).
pi-chrome does not hide it; the banner is the user's signal that the broad-permission companion is
driving the profile.

## The companion extension

The Chrome extension under `extensions/chrome-profile-bridge/browser-extension/` runs with broad permissions: `tabs`, `scripting`, `debugger`, `webNavigation`, etc. The bundled extension only talks to `http://127.0.0.1:17318`, and the bridge only reaches Chrome through that extension. **Only install it from a package source you trust.** Read the source before loading. Pin a known-good commit if you're security-sensitive.

## Defaults

- Loopback bridge by default (`127.0.0.1:17318`). No remote port. No telemetry.
- Chrome real input layer for interactive controls.
- Chrome control locked by default; `/chrome authorize` unlocks the current Pi session after a terminal confirmation, `/chrome revoke` locks it again.
- Hard background mode is on by default: tools cannot override it to explicitly focus windows or activate tabs. `/chrome background off` allows foreground/watch mode. This is not a security sandbox: trusted input, page scripts, native prompts, and Chrome/OS behavior can still affect focus.

## Custom ports

The bundled Chrome extension polls the hardcoded `http://127.0.0.1:17318`. Custom bridge ports are not supported without editing the extension source and reloading it: the Pi-side `PI_CHROME_BRIDGE_HOST` / `PI_CHROME_BRIDGE_PORT` overrides change where the bridge listens, but the unmodified companion will not connect to it.
