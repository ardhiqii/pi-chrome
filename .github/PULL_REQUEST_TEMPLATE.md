# Pull request

## What changes

<!-- One or two paragraphs. Link the issue if there is one. -->

## Verification

- [ ] `npm test` is green.
- [ ] `node scripts/check-extension-load.mjs` is green. This is required for any change to
      `extensions/chrome-profile-bridge/index.ts`; `deploy.sh` runs the same check before copying
      the file into a live install.
- [ ] `CHANGELOG.md` entry added (a `FORK ADDITIONS` bullet in this fork).
- [ ] For behaviour changes: red-on-revert evidence is stated below. A new or updated test must fail
      without the fix and pass with it; `CONTRIBUTING.md` treats this as a non-negotiable.
- [ ] User-visible claims are measured, not inferred. Every number and pass/fail statement comes
      from a run, not from reading the code.
- [ ] No credentials, session data, or private page content appears in the diff, logs, or
      screenshots.

## Red-on-revert evidence

<!--
For behaviour changes, name the test, the command, and the result before and after the fix:

  test-suite/unit/input-reliability.test.mjs "<test name>" — fails without the fix, passes with it.
  Command: npm test

For changes with no runtime behaviour, write "not applicable" and say why.
-->

## Live vs unit-only

<!--
What was verified live (a real browser and profile, with the extension loaded), and what is
unit-only? Also state what was not verified and why, so a reviewer knows what confidence to place
in the change.
-->

## Notes for reviewers

<!-- Deliberate trade-offs, follow-ups, or parts you want a second look at. -->
