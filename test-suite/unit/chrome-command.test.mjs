// Exercise the shipped /chrome command registration and handlers without opening Chrome or a bridge.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");
const { version } = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const now = 1_000_000;
// The display tag this fork shows everywhere: <x>.<y>.<z>-plus.<build>. manifest.version has to stay
// integers-only (Chrome rejects letters), so the label is derived from the numeric version exactly
// as scripts/sync-manifest-version.mjs derives version_name.
const plusTag = (numeric) => {
  const parts = String(numeric).split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part))
    ? `${parts[0]}.${parts[1]}.${parts[2]}-plus.${parts[3]}`
    : String(numeric);
};
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}
const commandSource = stripTypeScriptTypes([
  section("const authSummary =", "\n\tconst chromeControlAuthorized ="),
  // The connector menu's own helpers: the picker entry constant, the label->key mapping, and the status
  // reporter the connector handler calls.
  section("const RENAME_CONNECTOR_ENTRY =", "\nconst PI_CHROME_GLOBAL_KEY"),
  // The real report renderer for /chrome groups: the wording is the only place that promises a repair
  // leaves pages and tabs alone, so it must be tested, not stubbed.
  section("function describeGroupRepair(", "\ntype ClientSummary ="),
  section("// Shared handlers,", "\n\tfunction registerChromeTools("),
].join("\n"));

function healthyResponse(action) {
  switch (action) {
    case "tab.version": return { extensionVersion: version, extensionVersionName: plusTag(version) };
    case "page.evaluate": return 2;
    case "page.probe": return { arithmetic: 2, location: "https://fixture.test/", webdriver: false };
    case "window.list": return { windows: [], workingWindowId: null, strayPiGroups: 0 };
    default: throw new Error(`Unexpected bridge action: ${action}`);
  }
}

function harness({ until, background = true, mode = "server", choices = [], confirmAnswers = [], send = healthyResponse, clientLabel, clientKey = "edge:unittest", connectors, connectorNames = {}, profileSuggestions = [], preferredWindow, writePreferredWindowFails = false } = {}) {
  const calls = [], notices = [], menus = [], confirms = [], namesWritten = [], preferredWindowsWritten = [], pickedAtWritten = [], pickedKeysWritten = [];
  let savedPreferredWindow = preferredWindow;
  let savedPreferredWindowAt;
  // Client-mode shape by default: the connector key is only known after a status refresh (the real
  // bridge populates ownerStatus there), so a picker that saves a pick without refreshing first saves it
  // keyless — measured live as "preferredWindowKey": null, which disables the extension's connector
  // attribution and keeps the remembered machine-wide pick empty for callers that forward nothing.
  let statusRefreshed = false;
  let command;
  const ctx = {
    ui: {
      notify: (...args) => notices.push(args),
      async select(title, items) {
        const labels = Array.from(items);
        menus.push({ title, items: labels });
        const choice = choices[menus.length - 1];
        // A real host can only return a listed item, so a test that queues anything else would certify an
        // interaction the user cannot perform. Fail loudly instead.
        assert.ok(choice === undefined || labels.includes(choice),
          `queued choice is not in the menu: ${JSON.stringify(choice)}`);
        return choice;
      },
      async input() { return undefined; },
      // The /chrome groups repair path confirms before it applies. A harness that silently declined would
      // certify a repair that never ran, so the answer queue is explicit and every prompt is recorded.
      async confirm(title, message) { confirms.push({ title, message }); return confirmAnswers.length ? confirmAnswers.shift() : false; },
    },
  };
  const sandbox = {
    Date: { now: () => now }, PI_CHROME_VERSION: version,
    chromeAuthorizedUntil: until, backgroundEnabled: background,
    hostnameOf: (url) => new URL(url).hostname,
    // The connector menu's collaborators: the real ones read the user's state file and the browser's
    // profile folders, which a test must neither touch nor depend on.
    readConnectorNames: () => connectorNames,
    writeConnectorName: (key, name) => namesWritten.push([key, name]),
    suggestBrowserProfileNames: () => profileSuggestions,
    // The real one derives the key from the session context; the command section reads it as a free
    // variable, so the harness supplies a fixed one and asserts it reaches the wire.
    sessionKeyFor: () => "session:test",
    // The machine-wide window default is disk state: the real helpers read/write the user's
    // ~/.pi/agent/pi-chrome.json, which a test must never touch. The stubs keep the value in memory
    // so the picker's save path and the injected wire parameter can still be asserted.
    readPreferredWindow: () => savedPreferredWindow,
    readPreferredWindowAt: () => savedPreferredWindowAt,
    writePreferredWindow: (value, at, key) => {
      const stamp = typeof at === "number" ? at : Date.now();
      preferredWindowsWritten.push(value);
      pickedAtWritten.push(stamp);
      pickedKeysWritten.push(key);
      savedPreferredWindow = value;
      savedPreferredWindowAt = value === undefined ? undefined : stamp;
      return !writePreferredWindowFails;
    },
    preferredWindowParams: () => (typeof savedPreferredWindow === "number"
      ? { preferredWindow: savedPreferredWindow, ...(typeof savedPreferredWindowAt === "number" ? { preferredWindowAt: savedPreferredWindowAt } : {}) }
      : {}),
    bridge: {
      status: () => ({ mode }),
      refreshStatus: async () => { statusRefreshed = true; return { mode, clients: connectors }; },
      clientLabel: () => clientLabel,
      clientKey: () => (statusRefreshed ? clientKey : undefined),
      async send(action, params, timeout) {
        calls.push({ action, params: JSON.parse(JSON.stringify(params)), timeout });
        return send(action, params, timeout);
      },
    },
    pi: { registerCommand(name, definition) { assert.equal(name, "chrome"); command = definition; } },
  };
  vm.runInNewContext(commandSource, sandbox);
  return { command, calls, notices, menus, confirms, namesWritten, preferredWindowsWritten, pickedAtWritten, pickedKeysWritten, sandbox, run: (args = "") => command.handler(args, ctx) };
}

test("command help and root completion omit status; nested background status remains available", () => {
  const h = harness();
  assert.doesNotMatch(h.command.description, /\/chrome status\b/);
  assert.match(h.command.description, /\/chrome doctor/);
  assert.deepEqual(Array.from(h.command.getArgumentCompletions(""), (item) => item.value), [
    "authorize", "revoke", "doctor", "onboard", "background", "connector", "window", "groups",
  ]);
  assert.equal(h.command.getArgumentCompletions("sta"), null);
  assert.equal(h.command.getArgumentCompletions("doctor")[0].value, "doctor");
  assert.equal(h.command.getArgumentCompletions("background st")[0].value, "background status");
  assert.equal(h.command.getArgumentCompletions("authorize 15")[0].value, "authorize 15m");
  // Choosing a connector is offered both as an interactive picker (no argument) and as these explicit
  // forms, so the completions must exist even though the picker is the intended path.
  assert.deepEqual(Array.from(h.command.getArgumentCompletions("connector "), (item) => item.value), [
    "connector list", "connector auto",
  ]);
  assert.deepEqual(Array.from(h.command.getArgumentCompletions("window "), (item) => item.value), [
    "window list",
  ]);
  assert.deepEqual(Array.from(h.command.getArgumentCompletions("groups "), (item) => item.value), [
    "groups repair",
  ]);
  assert.match(h.command.description, /\/chrome groups \[repair\]/);
});

test("removed status command returns a warning without probing Chrome", async () => {
  const h = harness();
  await h.run("status");
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0][0], /Unknown subcommand 'status'/);
  assert.doesNotMatch(h.notices[0][0], /\| status \|/);
  assert.equal(h.notices[0][1], "warning");
});

test("bare chrome shows loading immediately, then a lightweight dashboard without page probes", async () => {
  let finish;
  const h = harness({ send: () => new Promise((resolve) => { finish = resolve; }) });
  const done = h.run();
  assert.deepEqual(h.notices, [["Checking Chrome connection…", "info"]]);
  assert.equal(h.menus.length, 0);
  assert.deepEqual(h.calls, [{ action: "tab.version", params: {}, timeout: 5_000 }]);
  finish({ extensionVersion: version });
  await done;
  assert.match(h.menus[0].title, /Chrome connected.*auth: locked.*background: on \(hard\)/);
  assert.ok(h.menus[0].items.includes("Doctor / troubleshoot"));
  assert.ok(!h.menus[0].items.some((item) => /status/i.test(item)));
  assert.equal(h.calls.length, 1);
});

test("dashboard retains authorization/background state when Chrome is offline or outdated", async () => {
  for (const [send, expected] of [
    [() => { throw new Error("offline"); }, /Chrome not responding/],
    [() => ({ extensionVersion: "0.0.0" }), /Chrome extension v0\.0\.0.*reload extension/],
  ]) {
    const h = harness({ until: "indefinite", send });
    await h.run("background off");
    await h.run("background status");
    assert.match(h.notices.at(-1)[0], /background is off/);
    await h.run();
    assert.match(h.menus[0].title, expected);
    assert.match(h.menus[0].title, /auth: authorized indefinitely.*background: off/);
    assert.deepEqual(h.calls, [{ action: "tab.version", params: {}, timeout: 5_000 }]);
  }
});

test("Doctor includes locked, timed, indefinite, and expired authorization plus background state", async () => {
  for (const [until, expected] of [
    [undefined, "locked"], [now + 15 * 60_000, "authorized for ~15m"],
    ["indefinite", "authorized indefinitely"], [now, "locked"],
  ]) {
    for (const background of [true, false]) {
      const h = harness({ until, background });
      await h.run("doctor");
      assert.equal(h.notices[0][0], "Checking pi-chrome…");
      const report = h.notices.at(-1)[0];
      assert.ok(report.includes(`pi-chrome v${plusTag(version)}`));
      assert.doesNotMatch(report, new RegExp(`pi-chrome v${version.replace(/\./g, "\.")}(?![-\w])`),
        "the bare 4-part machine version must not be the user-facing label");
      assert.ok(report.includes(`Authorization: ${expected}`));
      assert.ok(report.includes(`Background: ${background ? "on (hard)" : "off"}`));
      assert.match(report, /Connected/);
      assert.match(report, /can run code/);
      assert.match(report, /fixture\.test/);
      assert.deepEqual(h.calls.map(({ action, timeout }) => [action, timeout]), [
        ["tab.version", 35_000], ["page.evaluate", 10_000], ["page.probe", 10_000], ["window.list", 10_000],
      ]);
      assert.ok(h.calls.filter((call) => call.action.startsWith("page.")).every((call) => call.params.foreground === false));
      assert.ok(h.calls.filter((call) => call.action.startsWith("page.")).every((call) => call.params.sessionKey === "session:test"),
        "the probes are scoped to this session: unscoped, they resolve the extension's default bucket and can open or drive a Pi tab in a window the user did not choose");
      assert.equal(h.sandbox.chromeAuthorizedUntil, until, "diagnostics do not grant or change authorization");
      assert.equal(h.sandbox.backgroundEnabled, background);
    }
  }
});

test("Doctor shows the fork's plus tag, not the bare machine version", async () => {
  // manifest.version must stay integers-only, so the extension reports its display tag separately
  // (version_name). Doctor must label both sides with it: the numeric form is plumbing, and a report
  // that showed only "0.15.51.24" made the build look like an upstream one.
  const h = harness({ send: (action) => action === "tab.version"
    ? { extensionVersion: version, extensionVersionName: plusTag(version) }
    : healthyResponse(action) });
  await h.run("doctor");
  const report = h.notices.at(-1)[0];
  assert.ok(report.includes(`pi-chrome v${plusTag(version)}`), "pi-chrome is labelled with its plus tag");
  assert.ok(report.includes(`companion extension v${plusTag(version)}`), "the extension is labelled with the tag it reported");
  // An extension that reports a tag of its own (an older or newer build) must be named as it reported,
  // and a version without a tag (upstream install) must stay plain rather than gaining a fake -plus.
  const stale = harness({ send: () => ({ extensionVersion: "0.0.0", extensionVersionName: "0.0.0-plus.7" }) });
  await stale.run("doctor");
  assert.match(stale.notices.at(-1)[0], /old version \(0\.0\.0-plus\.7\)/);
  const upstream = harness({ send: () => ({ extensionVersion: version.slice(0, version.lastIndexOf(".")) }) });
  await upstream.run("doctor");
  const upstreamReport = upstream.notices.at(-1)[0];
  const upstreamVersion = version.slice(0, version.lastIndexOf("."));
  // A 3-part upstream extension differs from this build, so doctor reports it as outdated — named as it
  // reported itself, with no invented -plus tag.
  assert.ok(upstreamReport.includes(`old version (${upstreamVersion})`),
    "an extension reporting a 3-part upstream version is named as reported, not with a fake -plus tag");
  assert.ok(!upstreamReport.includes(`old version (${upstreamVersion}-plus`),
    "only the extension's own label is checked here: the pi-chrome side legitimately shows its plus tag");
});

test("Doctor retains local state and repair hints when connection/version checks fail", async () => {
  for (const [send, expected] of [
    [() => { throw new Error("offline"); }, /Chrome isn't responding: offline/],
    [() => ({ extensionVersion: "0.0.0" }), /old version \(0\.0\.0\)/],
  ]) {
    const h = harness({ until: "indefinite", background: false, mode: "client", send });
    await h.run("doctor");
    const report = h.notices.at(-1)[0];
    assert.match(report, /Authorization: authorized indefinitely/);
    assert.match(report, /Background: off/);
    assert.match(report, /sharing another pi session's connection/);
    assert.match(report, expected);
    assert.match(report, /Fix:/);
    assert.deepEqual(h.calls.map((call) => call.action), ["tab.version"]);
  }
});

test("choosing Doctor explicitly from the dashboard runs full diagnostics", async () => {
  const h = harness({ choices: ["Doctor / troubleshoot"] });
  await h.run();
  assert.deepEqual(h.calls.map((call) => call.action), ["tab.version", "tab.version", "page.evaluate", "page.probe", "window.list"]);
  assert.match(h.notices.at(-1)[0], /Authorization: locked/);
  assert.match(h.notices.at(-1)[0], /Background: on \(hard\)/);
});

test("Doctor warns about a stray Pi tab group with the fix, and stays quiet without one", async () => {
  // The leak report has to reach the user through the diagnostics command too, not only the picker.
  const send = (action) => {
    if (action === "tab.version") return { extensionVersion: version };
    if (action === "page.evaluate") return 2;
    if (action === "page.probe") return { arithmetic: 2, location: "https://fixture.test/", webdriver: false };
    if (action === "window.list") {
      return {
        windows: [{ windowId: 22, tabCount: 3, title: "Extensions", focused: true, holdsTargetTab: false, groups: [{ id: 9, title: "Pi Agent", piGroup: true, tabCount: 2, leak: true }] }],
        workingWindowId: 11,
        strayPiGroups: 1,
      };
    }
    throw new Error(`Unexpected bridge action: ${action}`);
  };
  const h = harness({ until: "indefinite", send });
  await h.run("doctor");
  const report = h.notices.at(-1)[0];
  assert.match(report, /⚠ A stray Pi tab group is in one of your windows \(2 tabs\)/);
  assert.match(report, /\/chrome groups repair/);

  const clean = harness({ until: "indefinite" });
  await clean.run("doctor");
  assert.doesNotMatch(clean.notices.at(-1)[0], /stray Pi tab group/);
});

test("doctor names the browser and profile the bridge is talking to", async () => {
  const h = harness({ until: now + 15 * 60_000, clientLabel: "Edge (profile ab12cd34)" });
  await h.run("doctor");
  const report = h.notices.at(-1)[0];
  assert.ok(
    report.includes("Connected to Edge (profile ab12cd34)"),
    `doctor should name the target, got:\n${report}`,
  );
});

const NAMED = [{ key: "edge:9d233ecf", browser: "edge", profileId: "9d233ecf", label: "Edge — Profile 1" }];

test("Esc in the connector menu steps back one level instead of closing the whole flow", async () => {
  // The picker loops so a cancelled sub-step returns to it. It used to return from every depth, so
  // pressing Esc while choosing a name abandoned the flow entirely.
  const h = harness({
    connectors: NAMED,
    profileSuggestions: ["Profile 1", "Clover Agent"],
    // rename -> the name prompt is cancelled -> back to the picker -> Esc there closes it.
    choices: ["Rename a browser…", undefined, undefined],
  });
  await h.run("connector");
  const titles = h.menus.map((menu) => menu.title);
  assert.equal(titles[0], "Which browser should Pi drive?");
  assert.equal(titles[1], "What should “Edge — Profile 1” be called?", "the name prompt was reached");
  assert.equal(titles[2], "Which browser should Pi drive?", "Esc returned to the picker");
  assert.equal(titles.length, 3, "and the next Esc closed it — not an endless loop");
  assert.deepEqual(h.namesWritten, [], "cancelling writes nothing");
});

test("naming a connector stores it and returns to the picker with the new name", async () => {
  const h = harness({
    connectors: NAMED,
    // Already named, so the suggestions exclude the current name and "Remove name" is offered.
    connectorNames: { "edge:9d233ecf": "Profile 1" },
    profileSuggestions: ["Profile 1", "Clover Agent"],
    choices: ["Rename a browser…", "Clover Agent", undefined],
  });
  await h.run("connector");
  assert.deepEqual(h.namesWritten, [["edge:9d233ecf", "Clover Agent"]]);
  const namePrompt = h.menus.find((menu) => menu.title.includes("be called?"));
  assert.deepEqual(namePrompt.items, ["Clover Agent", "Type a name…", "Remove name"]);
  assert.equal(h.menus.at(-1).title, "Which browser should Pi drive?", "the picker returns so the new name is visible");
});

test("a name can be removed, falling back to the profile id", async () => {
  const h = harness({
    connectors: NAMED,
    connectorNames: { "edge:9d233ecf": "Profile 1" },
    profileSuggestions: [],
    choices: ["Rename a browser…", "Remove name", undefined],
  });
  await h.run("connector");
  assert.deepEqual(h.namesWritten, [["edge:9d233ecf", undefined]], "the name is cleared");
});

test("/chrome window is routed, carries this session's key, and saves the pick machine-wide", async () => {
  // Both of these were review findings. The subcommand was missing from the /chrome switch entirely, and
  // the wire calls omitted sessionKey — so the extension fell back to its default bucket and the feature
  // silently configured a DIFFERENT session's target. Neither is visible without asserting on what was
  // actually dispatched, which is why the earlier completion-only test passed while the feature was dead.
  const windowResponse = (action) =>
    action === "window.list"
      ? { windows: [{ windowId: 11, tabCount: 2, title: "T", focused: false, holdsTargetTab: true }], ownsTargetWindow: false, targetWindowId: null }
      : { windowId: 11, reused: false, pickedAt: 4242 };
  const h = harness({ send: windowResponse, preferredWindow: 11 });

  await h.run("window list");
  assert.equal(h.calls[0].action, "window.list", "window must be a real subcommand, not an unknown one");
  assert.doesNotMatch(String(h.notices[0][0]), /Unknown subcommand/);
  assert.equal(h.calls[0].params.sessionKey, "session:test", "the read is scoped to this session");
  assert.equal(h.calls[0].params.preferredWindow, 11, "the read carries the saved pick, so the extension marks the window Pi will really use");
  assert.match(String(h.notices[0][0]), /Saved default/, "window list shows the saved machine-wide default");

  // Picking a specific window sends that window's id with the same session scope, and saves the id
  // as the machine-wide default so a new session inherits it without being asked again.
  const picked = harness({ send: windowResponse, preferredWindow: 11, choices: ["✓ Window 11 — 2 tabs, saved default — T"] });
  await picked.run("window");
  assert.equal(picked.calls[0].action, "window.list");
  assert.equal(picked.calls[1].action, "window.select");
  assert.equal(picked.calls[1].params.windowId, 11);
  assert.equal(picked.calls[1].params.sessionKey, "session:test");
  assert.equal(picked.calls[1].params.pickSource, "user",
    "the picker must declare itself the user, because the extension refuses window.select without pickSource (the measured hand-built POST /command that pinned Pi to a window the user had not chosen)");
  assert.deepEqual(picked.preferredWindowsWritten, [11], "the pick is persisted machine-wide");
  assert.deepEqual(picked.pickedAtWritten, [4242],
    "the file gets the SAME stamp the extension applied, not a locally invented one — two clocks would let a record written moments earlier look newer than the pick");
  assert.deepEqual(picked.pickedKeysWritten, ["edge:unittest"],
    "and the connector that made the pick, so another profile's window id can never match it");
  assert.match(String(picked.notices.at(-1)[0]), /saved, so new sessions use it too/);
});

test("a pick is saved with this connector's key, even from a client-mode session", async () => {
  // Measured live: the saved pick had `"preferredWindowKey": null` because the picker read the connector key
  // before any status refresh (client mode populates it there). A keyless pick silently disables the
  // extension's connector attribution AND never becomes the remembered machine-wide pick, so callers that
  // forward nothing (hand-built POST /command) stay pinned to whatever window they used last. The harness
  // models that shape: clientKey() is undefined until refreshStatus() has run once.
  const windowResponse = (action) =>
    action === "window.list"
      ? { windows: [{ windowId: 11, tabCount: 2, title: "T", focused: false, holdsTargetTab: true }], ownsTargetWindow: false, targetWindowId: null, workingWindowId: 11 }
      : { windowId: 11, reused: false, pickedAt: 4242 };
  const h = harness({ send: windowResponse, preferredWindow: 11, choices: ["✓ Window 11 — 2 tabs, saved default — T"] });
  await h.run("window");
  assert.deepEqual(h.preferredWindowsWritten, [11]);
  assert.deepEqual(h.pickedKeysWritten, ["edge:unittest"],
    "the pick must name the connector that made it: without that key the extension refuses to remember it machine-wide");
});

test("the picker marks the saved default and offers it first, so re-choosing cannot land on the user's window", async () => {
  // The live report this comes from: the picker listed the user's focused window first with the TUI
  // cursor on it, and the ✓ on the other entry. "Re-choose window 2" was one Enter away from picking
  // window 1 — the user's own. The saved default now leads, and the choice the user queues is that label.
  const windowResponse = (action) =>
    action === "window.list"
      ? {
          windows: [
            { windowId: 708, tabCount: 8, title: "Extensions", focused: true, holdsTargetTab: false },
            { windowId: 947, tabCount: 2, title: "New tab", focused: false, holdsTargetTab: true },
          ],
          ownsTargetWindow: false,
          targetWindowId: null,
          workingWindowId: 947,
        }
      : { windowId: 947, reused: true };
  const h = harness({ send: windowResponse, preferredWindow: 947, choices: ["✓ Window 947 — 2 tabs, saved default — New tab"] });
  await h.run("window");
  assert.deepEqual(h.menus[0].items, [
    "✓ Window 947 — 2 tabs, saved default — New tab",
    "  Window 708 — 8 tabs, focused — Extensions",
  ], "the saved default is the first entry, so the default cursor position is the window the user chose");
  assert.equal(h.calls[1].params.windowId, 947, "the pick is the window the user actually chose");
  assert.deepEqual(h.preferredWindowsWritten, [947]);
});

test("a pick that moves other sessions' tabs says so, instead of moving them silently", async () => {
  // The pick is machine-wide, so it can move tabs belonging to sessions the user is not looking at. That is
  // the feature working, but it must not be invisible: the notify names how many others came along.
  const windowResponse = (action) =>
    action === "window.list"
      ? { windows: [{ windowId: 11, tabCount: 2, title: "T", focused: false, holdsTargetTab: true }], ownsTargetWindow: false, targetWindowId: null, workingWindowId: 11 }
      : { windowId: 11, reused: true, moved: false, pickedAt: 777, swept: 2 };
  const h = harness({ send: windowResponse, preferredWindow: 11, choices: ["✓ Window 11 — 2 tabs, saved default — T"] });
  await h.run("window");
  const text = String(h.notices.at(-1)[0]);
  assert.match(text, /2 other Pi sessions' tabs were moved there too/, "the user is told other sessions moved");
  assert.deepEqual(h.pickedAtWritten, [777]);

  const quiet = harness({
    send: (action) => (action === "window.list"
      ? { windows: [{ windowId: 11, tabCount: 2, title: "T", focused: false, holdsTargetTab: true }], ownsTargetWindow: false, targetWindowId: null, workingWindowId: 11 }
      : { windowId: 11, reused: true, moved: false, pickedAt: 777, swept: 0 }),
    preferredWindow: 11,
    choices: ["✓ Window 11 — 2 tabs, saved default — T"],
  });
  await quiet.run("window");
  assert.doesNotMatch(String(quiet.notices.at(-1)[0]), /other Pi session/, "nothing is claimed when nothing moved");
});

test("a pick that cannot be saved says so instead of claiming it was remembered", async () => {
  const windowResponse = (action) =>
    action === "window.list"
      ? { windows: [{ windowId: 11, tabCount: 2, title: "T", focused: false, holdsTargetTab: false }], ownsTargetWindow: false, targetWindowId: null }
      : { windowId: 11, reused: false };
  const h = harness({ send: windowResponse, choices: ["  Window 11 — 2 tabs — T"], writePreferredWindowFails: true });
  await h.run("window");
  const text = String(h.notices.at(-1)[0]);
  assert.match(text, /could not be saved/);
  assert.doesNotMatch(text, /saved, so new sessions use it too/);
});

test("/chrome window own no longer exists and points at the picker instead", async () => {
  // Automatic window creation was removed: /chrome window own used to create (or adopt) a window of
  // Pi's own, which is the path that kept dropping the user's tab into their window. It must not send
  // window.select at all now.
  const h = harness();
  await h.run("window own");
  assert.equal(h.calls.length, 0, "no window.select is attempted for a removed command");
  const text = String(h.notices.at(-1)[0]);
  assert.match(text, /no longer creates a window/, "says why it is gone");
  assert.match(text, /\/chrome window/, "names the way forward");
});

test("/chrome window list names the window Pi is actually a guest in", async () => {
  // targetWindowId is null for a guest tab by design, so this used to print "window ?" in the common case.
  const h = harness({
    send: async (action) =>
      action === "window.list"
        ? { windows: [{ windowId: 42, tabCount: 5, title: "WhatsApp", focused: false, holdsTargetTab: true }], ownsTargetWindow: false, targetWindowId: null }
        : { windowId: 42 },
  });
  await h.run("window list");
  const text = String(h.notices[0][0]);
  assert.match(text, /working in window 42/, "names the window holding Pi's tab");
  assert.doesNotMatch(text, /window \?/);
  assert.match(text, /cleanup closes only Pi's tab/);
});

test("/chrome window list says so plainly when there is nothing else to list", async () => {
  // Only Pi's own window is open: the status used to end in a "Windows open:" header with zero entries,
  // directly under a sentence saying a window is open. Say there is nothing else instead.
  const h = harness({
    send: async (action) =>
      action === "window.list"
        ? { windows: [{ windowId: 33, tabCount: 1, title: "AI news", focused: true, holdsTargetTab: true, ownedByPi: true }], ownsTargetWindow: true, targetWindowId: 33 }
        : {},
  });
  await h.run("window list");
  const text = String(h.notices[0][0]);
  assert.match(text, /working in a window of its own \(window 33\)/);
  assert.match(text, /No other Chrome windows are open right now\./);
});

test("the window picker offers only open windows, never Pi's own or a create-new entry", async () => {
  // The old picker offered "Pi's own window" and "Open a new window of Pi's own". Both are gone for
  // good: automatic window creation is removed, and a window only becomes Pi's workspace when the user
  // picks one of their real windows with /chrome window.
  const report = {
    windows: [
      { windowId: 33, tabCount: 1, title: "AI news", focused: false, holdsTargetTab: true, ownedByPi: true },
      { windowId: 11, tabCount: 5, title: "Terrarium", focused: true, holdsTargetTab: false },
    ],
    ownsTargetWindow: true,
    targetWindowId: 33,
  };
  const send = async (action) => (action === "window.list" ? report : { windowId: 11, reused: false });

  const h = harness({ send, choices: ["  Window 11 — 5 tabs, focused — Terrarium"] });
  await h.run("window");
  assert.deepEqual(h.menus[0].items, ["  Window 11 — 5 tabs, focused — Terrarium"],
    "the owned window and the create-new entry are not offered");
  assert.equal(h.calls[1].action, "window.select");
  assert.equal(h.calls[1].params.windowId, 11);
  assert.equal(h.calls[1].params.fresh, undefined, "the picker has no fresh-window request to send");
});

test("/chrome window list says a saved window that is gone, instead of listing it as a choice", async () => {
  // The saved default points at a window that no longer exists (window ids do not survive a browser
  // restart). Saying "new sessions inherit it" would be a lie, and the picker has nothing to mark, so the
  // user would be left to guess which entry Enter takes.
  const h = harness({
    preferredWindow: 99,
    send: async (action) =>
      action === "window.list"
        ? { windows: [{ windowId: 42, tabCount: 5, title: "WhatsApp", focused: true, holdsTargetTab: false }], ownsTargetWindow: false, targetWindowId: null, workingWindowId: 42 }
        : {},
  });
  await h.run("window list");
  const text = String(h.notices[0][0]);
  assert.match(text, /Saved default: window 99 — no longer open/);
  assert.match(text, /Run \/chrome window to pick another/);
  assert.doesNotMatch(text, /new sessions inherit it/);
});

test("an empty window picker explains how to proceed instead of showing a dead-end dialog", async () => {
  // The realistic state: Pi's dedicated window is the only one open. A zero-item select cannot be confirmed
  // (Enter does nothing; only Esc exits), so the handler must say what to do instead of showing it.
  const report = {
    windows: [{ windowId: 33, tabCount: 1, title: "AI news", focused: true, holdsTargetTab: true, ownedByPi: true }],
    ownsTargetWindow: true,
    targetWindowId: 33,
  };
  const h = harness({ send: async (action) => (action === "window.list" ? report : {}) });
  await h.run("window");
  assert.equal(h.menus.length, 0, "no empty menu is shown");
  assert.equal(h.calls.length, 1, "no window.select is attempted");
  const text = String(h.notices.at(-1)[0]);
  assert.match(text, /Open a window in Chrome/);
  assert.doesNotMatch(text, /own/, "there is no window of Pi's own to fall back to any more");
});

// ===== /chrome groups and /chrome groups repair: the preview is a read-only dry run, and applying is
// confirmed first with the exact number of tabs and the promise that pages/tabs are untouched. =====
function groupsPreview(overrides = {}) {
  return {
    dryRun: true,
    pickedWindowId: 11,
    groups: [{
      groupId: 5,
      windowId: 22,
      title: "Pi Agent",
      tabs: [
        { tabId: 40, title: "Google", url: "https://google.com/", provenance: "adopted-user", action: "ungroup", heldBySession: null },
        { tabId: 41, title: "Pi", url: "about:blank", provenance: "pi-target", action: "skip", heldBySession: "session:other" },
      ],
      groupDisposedAfter: null,
    }],
    ungroupedTabs: [],
    skippedTabs: [41],
    ...overrides,
  };
}

test("/chrome groups previews the repair as a dry run and changes nothing", async () => {
  const h = harness({ send: (action, params) => (action === "groups.repair" && params.dryRun === false ? groupsPreview({ dryRun: false }) : groupsPreview()) });
  await h.run("groups");
  assert.deepEqual(h.calls.map((call) => [call.action, call.params.dryRun]), [["groups.repair", true]]);
  assert.equal(h.confirms.length, 0, "a preview never asks to apply");
  const text = String(h.notices.at(-1)[0]);
  assert.match(text, /Preview: 1 tab would be ungrouped/);
  assert.match(text, /Window 22: "Pi Agent"/);
  assert.match(text, /ungroup tab 40 — adopted-user/);
  assert.match(text, /skip\s+tab 41 — pi-target/);
});

test("/chrome groups repair confirms before applying, and names the count plus the untouched guarantee", async () => {
  const applied = groupsPreview({ dryRun: false, ungroupedTabs: [40], groups: [{ ...groupsPreview().groups[0], groupDisposedAfter: true }] });
  const h = harness({
    confirmAnswers: [true],
    send: (action, params) => (action === "groups.repair" && params.dryRun === false ? applied : groupsPreview()),
  });
  await h.run("groups repair");
  assert.deepEqual(h.calls.map((call) => [call.action, call.params.dryRun]), [["groups.repair", true], ["groups.repair", false]]);
  assert.equal(h.confirms.length, 1, "the user is asked exactly once");
  assert.match(h.confirms[0].message, /1 tab in 1 stray Pi group will be ungrouped/);
  assert.match(h.confirms[0].message, /Pages and tabs are untouched/);
  assert.match(h.confirms[0].message, /nothing is navigated, moved or closed/);
  const text = String(h.notices.at(-1)[0]);
  assert.match(text, /Repaired 1 tab — pages and tabs were left in place/);
  assert.match(text, /Every repaired group is gone/);
});

test("/chrome groups repair declines cleanly: no apply call happens without a confirmation", async () => {
  const h = harness({
    confirmAnswers: [false],
    send: (action, params) => (action === "groups.repair" && params.dryRun === false ? groupsPreview({ dryRun: false }) : groupsPreview()),
  });
  await h.run("groups repair");
  assert.deepEqual(h.calls.map((call) => call.params.dryRun), [true], "only the preview ran");
  assert.match(String(h.notices.at(-1)[0]), /Cancelled — nothing was changed/);
});

test("/chrome groups repair says so plainly when there is nothing to repair", async () => {
  const h = harness({ send: () => groupsPreview({ groups: [], skippedTabs: [] }) });
  await h.run("groups repair");
  assert.deepEqual(h.calls.map((call) => call.params.dryRun), [true]);
  assert.equal(h.confirms.length, 0, "nothing to confirm means no dialog");
  const text = String(h.notices.at(-1)[0]);
  assert.match(text, /No stray Pi tab groups outside window 11/);
  assert.match(text, /Nothing to repair/);
});

// ===== The bare /chrome picker offers the groups repair too. The user could only reach it by knowing
// the /chrome groups repair subcommand; the menu entry must run that exact handler (preview first,
// confirm before applying) rather than any parallel implementation. =====

test("the dashboard menu offers the stray-group repair entry", async () => {
  const h = harness({ choices: [undefined] });
  await h.run();
  assert.ok(
    h.menus[0].items.includes("Repair stray Pi groups…"),
    `the picker must offer the repair, got: ${JSON.stringify(h.menus[0].items)}`,
  );
});

test("choosing the dashboard repair entry with zero strays notifies and never applies", async () => {
  const h = harness({
    choices: ["Repair stray Pi groups…", undefined],
    send: () => groupsPreview({ groups: [], skippedTabs: [] }),
  });
  await h.run();
  assert.deepEqual(
    h.calls.filter((call) => call.action === "groups.repair").map((call) => [call.action, call.params.dryRun]),
    [["groups.repair", true]],
    "only the read-only preview is sent; nothing is applied when there is nothing to repair",
  );
  assert.equal(h.confirms.length, 0, "nothing to repair means no confirm dialog");
  assert.ok(
    h.notices.some((notice) => /Nothing to repair/.test(String(notice[0]))),
    `the user must be told there is nothing to repair, got: ${JSON.stringify(h.notices.map((notice) => notice[0]))}`,
  );
  assert.equal(h.menus.length, 2, "the entry returns to the picker, like the other control menus");
});

test("choosing the dashboard repair entry previews, then applies only after the confirm", async () => {
  const applied = groupsPreview({ dryRun: false, ungroupedTabs: [40], groups: [{ ...groupsPreview().groups[0], groupDisposedAfter: true }] });
  const h = harness({
    choices: ["Repair stray Pi groups…", undefined],
    confirmAnswers: [true],
    send: (action, params) => (action === "groups.repair" && params.dryRun === false ? applied : groupsPreview()),
  });
  await h.run();
  assert.deepEqual(
    h.calls.filter((call) => call.action === "groups.repair").map((call) => call.params.dryRun),
    [true, false],
    "the entry dry-runs first and applies only after the confirmation",
  );
  assert.equal(h.confirms.length, 1, "the user is asked exactly once, exactly like /chrome groups repair");
  assert.match(h.confirms[0].message, /1 tab in 1 stray Pi group will be ungrouped/);
  assert.ok(
    h.notices.some((notice) => /Repaired 1 tab — pages and tabs were left in place/.test(String(notice[0]))),
    `the applied result must be reported, got: ${JSON.stringify(h.notices.map((notice) => notice[0]))}`,
  );
  assert.deepEqual(
    [...new Set(h.calls.map((call) => call.action))].sort(),
    ["groups.repair", "tab.version"],
    "the entry never closes, moves or navigates a tab",
  );
});
