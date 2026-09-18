// Exercise the shipped /chrome command registration and handlers without opening Chrome or a bridge.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");
const { version } = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const now = 1_000_000;
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
  section("// Shared handlers,", "\n\tfunction registerChromeTools("),
].join("\n"));

function healthyResponse(action) {
  switch (action) {
    case "tab.version": return { extensionVersion: version };
    case "page.evaluate": return 2;
    case "page.probe": return { arithmetic: 2, location: "https://fixture.test/", webdriver: false };
    default: throw new Error(`Unexpected bridge action: ${action}`);
  }
}

function harness({ until, background = true, mode = "server", choices = [], send = healthyResponse, clientLabel, connectors, connectorNames = {}, profileSuggestions = [] } = {}) {
  const calls = [], notices = [], menus = [], namesWritten = [];
  let command;
  const ctx = {
    ui: {
      notify: (...args) => notices.push(args),
      async select(title, items) {
        menus.push({ title, items: Array.from(items) });
        return choices[menus.length - 1];
      },
      async input() { return undefined; },
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
    bridge: {
      status: () => ({ mode }),
      refreshStatus: async () => ({ mode, clients: connectors }),
      clientLabel: () => clientLabel,
      async send(action, params, timeout) {
        calls.push({ action, params: JSON.parse(JSON.stringify(params)), timeout });
        return send(action, params, timeout);
      },
    },
    pi: { registerCommand(name, definition) { assert.equal(name, "chrome"); command = definition; } },
  };
  vm.runInNewContext(commandSource, sandbox);
  return { command, calls, notices, menus, namesWritten, sandbox, run: (args = "") => command.handler(args, ctx) };
}

test("command help and root completion omit status; nested background status remains available", () => {
  const h = harness();
  assert.doesNotMatch(h.command.description, /\/chrome status\b/);
  assert.match(h.command.description, /\/chrome doctor/);
  assert.deepEqual(Array.from(h.command.getArgumentCompletions(""), (item) => item.value), [
    "authorize", "revoke", "doctor", "onboard", "background", "connector", "window",
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
    "window list", "window own",
  ]);
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
      assert.ok(report.includes(`pi-chrome v${version}`));
      assert.ok(report.includes(`Authorization: ${expected}`));
      assert.ok(report.includes(`Background: ${background ? "on (hard)" : "off"}`));
      assert.match(report, /Connected/);
      assert.match(report, /can run code/);
      assert.match(report, /fixture\.test/);
      assert.deepEqual(h.calls.map(({ action, timeout }) => [action, timeout]), [
        ["tab.version", 35_000], ["page.evaluate", 10_000], ["page.probe", 10_000],
      ]);
      assert.ok(h.calls.filter((call) => call.action.startsWith("page.")).every((call) => call.params.foreground === false));
      assert.equal(h.sandbox.chromeAuthorizedUntil, until, "diagnostics do not grant or change authorization");
      assert.equal(h.sandbox.backgroundEnabled, background);
    }
  }
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
  assert.deepEqual(h.calls.map((call) => call.action), ["tab.version", "tab.version", "page.evaluate", "page.probe"]);
  assert.match(h.notices.at(-1)[0], /Authorization: locked/);
  assert.match(h.notices.at(-1)[0], /Background: on \(hard\)/);
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

test("/chrome window is routed AND carries this session's key", async () => {
  // Both of these were review findings. The subcommand was missing from the /chrome switch entirely, and
  // the wire calls omitted sessionKey — so the extension fell back to its default bucket and the feature
  // silently configured a DIFFERENT session's target. Neither is visible without asserting on what was
  // actually dispatched, which is why the earlier completion-only test passed while the feature was dead.
  const windowResponse = (action) =>
    action === "window.list"
      ? { windows: [{ windowId: 11, tabCount: 2, title: "T", focused: false, holdsTargetTab: true }], ownsTargetWindow: false, targetWindowId: null }
      : { windowId: 11, reused: false };
  const h = harness({ send: windowResponse });

  await h.run("window list");
  assert.equal(h.calls[0].action, "window.list", "window must be a real subcommand, not an unknown one");
  assert.doesNotMatch(String(h.notices[0][0]), /Unknown subcommand/);
  assert.equal(h.calls[0].params.sessionKey, "session:test", "the read is scoped to this session");

  await h.run("window own");
  assert.equal(h.calls[1].action, "window.select");
  assert.equal(h.calls[1].params.sessionKey, "session:test", "and so is the write");
  assert.equal(h.calls[1].params.windowId, null, "own means null, not an id");

  // Picking a specific window sends that window's id, with the same session scope. The label carries the
  // tick because that window holds Pi's tab, so it IS the current choice.
  const picked = harness({ send: windowResponse, choices: ["✓ Window 11 — 2 tabs — T"] });
  await picked.run("window");
  assert.equal(picked.calls[0].action, "window.list");
  assert.equal(picked.calls[1].action, "window.select");
  assert.equal(picked.calls[1].params.windowId, 11);
  assert.equal(picked.calls[1].params.sessionKey, "session:test");
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
