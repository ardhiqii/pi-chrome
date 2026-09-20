# pi-chrome documentation

These documents explain how pi-chrome is built, how it compares to other browser-automation tools,
and how to use it.

| Document | What it covers |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Components, the session model and target ownership, tab management guards, background mode, authorization, and why the extension ships unpacked. |
| [COMPARISON.md](./COMPARISON.md) | The honest "which tool when" page: pi-chrome against drivers, agent frameworks, and cloud browser providers, plus interop and public benchmarks. |
| [EXAMPLES.md](./EXAMPLES.md) | Real agent prompts for daily workflows, debugging, admin operations, framework forms, and multi-session patterns. |
| [FAQ.md](./FAQ.md) | Answers to common questions about browser support, detection, incognito, updates, install footprint, and known limits. |

Top-level documents:

- [README.md](../README.md) — what pi-chrome is, the PLUS fork's additions, setup, commands, and safety.
- [CHANGELOG.md](../CHANGELOG.md) — upstream's changelog, with the fork's additions at the top.
- [DEPLOY.md](../DEPLOY.md) — how the PLUS fork is deployed onto a local pi-chrome install.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — non-negotiables, local dev, adding a tool, and filing a bug.
- [SECURITY.md](../SECURITY.md) — the threat model, reporting a vulnerability, defaults, and supported versions.

The browser-control benchmark suite documents itself in [test-suite/README.md](../test-suite/README.md).
