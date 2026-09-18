// Routing tests for the real ChromeProfileBridge, not a stub.
//
// Why a loader shim: every other suite stubs the bridge, and the bridge cannot simply be loaded whole
// because its constructor uses TypeScript parameter properties, which Node's strip-only mode refuses
// ("TypeScript parameter property is not supported in strip-only mode"). Rewriting that one
// constructor signature into plain assignments is the whole shim — the routing logic under test is
// the shipped code.
//
// What this covers: which connector a command is addressed to, the refusal to guess when more than one
// is connected, and — the reason the choice is persisted at all — that a NEW session inherits the
// saved preference instead of starting over in auto. That decides which browser every chrome_* tool
// drives, so it should not ship unverified.
//
// readPreferredConnector / writePreferredConnector are stubbed in the sandbox: the real ones write to
// ~/.pi/agent/pi-chrome.json, and a test must never touch the user's actual preference file.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const indexSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");

function loadBridgeClass() {
  const start = indexSource.indexOf("class ChromeProfileBridge {");
  const end = indexSource.indexOf("\nconst tabActionValues", start);
  assert.ok(start >= 0 && end > start, "could not locate the ChromeProfileBridge class");
  let source = indexSource.slice(start, end);

  const before = source;
  source = source.replace(
    /constructor\(\s*private readonly host: string,\s*private readonly port: number,\s*\) \{\}/,
    "constructor(host, port) { this.host = host; this.port = port; }",
  );
  assert.notEqual(source, before, "the constructor shim did not apply — update it if the class changed");

  const saved = { value: undefined, writes: [] };
  // Controllable stand-in for the owner's HTTP surface: nothing here opens a socket.
  const net = { status: undefined, calls: 0, fail: false };
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Math, JSON, Map, Promise, Error, DEFAULT_TIMEOUT_MS: 1000,
    AbortSignal: { timeout: () => undefined },
    fetch: async () => {
      net.calls += 1;
      if (net.fail) throw new Error("fetch failed");
      return { ok: true, json: async () => net.status };
    },
    readPreferredConnector: () => saved.value,
    writePreferredConnector: (value) => { saved.writes.push(value); saved.value = value; },
  };
  vm.runInNewContext(stripTypeScriptTypes(source) + "\n;globalThis.__Bridge = ChromeProfileBridge;", sandbox);
  return { Bridge: sandbox.__Bridge, saved, net };
}

const { Bridge, saved, net } = loadBridgeClass();

// describeConnectorStatus is pure, so it can be loaded and called on its own.
function loadDescribeConnectorStatus() {
  const start = indexSource.indexOf("function describeConnectorStatus(");
  assert.ok(start >= 0, "could not locate describeConnectorStatus");
  const end = indexSource.indexOf("\n}\n", start);
  assert.ok(end > start, "could not locate the end of describeConnectorStatus");
  const source = indexSource.slice(start, end + 3);
  const sandbox = { console };
  vm.runInNewContext(stripTypeScriptTypes(source) + "\n;globalThis.__d = describeConnectorStatus;", sandbox);
  return sandbox.__d;
}

const describeConnectorStatus = loadDescribeConnectorStatus();

test("status: an older bridge that reports a connection is NOT reported as having none", () => {
  // The bridge belongs to whichever Pi session bound the port first. An older build answers with only
  // connected+clientName and no client list. Reading `clients` alone claimed nothing was connected
  // while a connector was plainly polling, and sent the user to /chrome onboard to repair a working
  // extension. This is the exact shape the running bridge returns.
  const text = describeConnectorStatus({
    connected: true,
    clientName: "Pi Chrome Connector gfcbdfcmfejelnocemdajdhmafhdfkln",
    queuedCommands: 0,
    pendingCommands: 0,
  });
  assert.doesNotMatch(text, /No connector is connected/, "must not deny a connector that is polling");
  assert.doesNotMatch(text, /\/chrome onboard/, "must not send the user to reinstall a working extension");
  assert.match(text, /Connector connected: Pi Chrome Connector/);
  assert.match(text, /\/reload in that session/, "points at the actual fix");
});

test("status: nothing connected is still reported as nothing connected", () => {
  assert.match(describeConnectorStatus({ connected: false, clients: [] }), /No connector is connected/);
  assert.match(describeConnectorStatus({}), /No connector is connected/, "no keys at all means nothing to drive");
  assert.doesNotMatch(describeConnectorStatus({ connected: false, clients: [] }), /\/reload in that session/);
});

test("status: several connectors are listed, with the chosen one marked", () => {
  const text = describeConnectorStatus({
    connected: true,
    clients: [
      { key: "edge:ab12cd34", label: "Edge (profile ab12cd34)" },
      { key: "chrome:11223344", label: "Chrome (profile 11223344)" },
    ],
    selectedClient: "edge",
    selectedKey: "edge:ab12cd34",
  });
  assert.match(text, /Connectors connected \(2\)/);
  assert.match(text, /edge:ab12cd34 — Edge \(profile ab12cd34\) {3}← selected/);
  assert.match(text, /chrome:11223344 — Chrome \(profile 11223344\)\n/, "the unchosen one is unmarked");
  assert.match(text, /edge — saved, so new sessions use it too/);
});

test("status: with nothing saved, the auto rule is explained rather than left implicit", () => {
  const text = describeConnectorStatus({
    connected: true,
    clients: [{ key: "edge:ab12cd34", label: "Edge (profile ab12cd34)" }],
    selectedClient: null,
    selectedKey: null,
  });
  assert.match(text, /Selection: auto \(the only connected connector/);
  assert.doesNotMatch(text, /← selected/, "nothing to mark when nothing is chosen");
});

test("status: a saved browser name does not need to equal the connector key", () => {
  // Choosing by browser name saves "edge"; the live key is edge:<profile>. Marking by key equality
  // alone would show no selection at all.
  const text = describeConnectorStatus({
    connected: true,
    clients: [{ key: "edge:brandnew1", label: "Edge (profile brandnew1)" }],
    selectedClient: "edge",
    selectedKey: "edge:brandnew1",
  });
  assert.match(text, /edge:brandnew1 — Edge \(profile brandnew1\) {3}← selected/);
});
const EDGE = "edge:ab12cd34";
const OTHER_EDGE = "edge:ff99ee88";
const CHROME = "chrome:11223344";

// Construct a bridge the way a fresh Pi session does. `preference` is what is already on disk.
function newBridge(preference) {
  saved.value = preference;
  saved.writes.length = 0;
  net.status = undefined;
  net.calls = 0;
  net.fail = false;
  return new Bridge("127.0.0.1", 17318);
}

// Register connectors the way a real /next poll does.
function withClients(specs, preference) {
  const bridge = newBridge(preference);
  let anyFresh = false;
  for (const spec of specs) {
    const key = bridge.clientKeyOf(spec.browser, spec.profileId, spec.name);
    bridge.clients.set(key, {
      key,
      browser: spec.browser,
      profileId: spec.profileId,
      name: spec.name,
      lastSeenAt: Date.now() - (spec.staleMs ?? 0),
    });
    if (!spec.staleMs) anyFresh = true;
  }
  // A client entry only ever exists because a poll arrived, and a poll stamps the bridge itself. Without
  // this the harness would look like "clients but never polled", which no real bridge can be.
  if (anyFresh) bridge.lastSeenAt = Date.now();
  return bridge;
}

test("clientKeyOf keys on browser+profile, not the client name", () => {
  const bridge = newBridge();
  // The extension id is the same in every installed copy, so the name cannot distinguish them.
  assert.equal(bridge.clientKeyOf("edge", "ab12cd34", "Pi Chrome Connector same-id"), EDGE);
  assert.equal(
    bridge.clientKeyOf("chrome", "ab12cd34", "Pi Chrome Connector same-id"),
    "chrome:ab12cd34",
    "the same profile id under a different browser is a different connector",
  );
  // No browser/profile reported (an older connector): fall back to the name so it still routes.
  assert.equal(bridge.clientKeyOf(undefined, undefined, "legacy-name"), "legacy-name");
  assert.equal(bridge.clientKeyOf(undefined, undefined, undefined), "unknown");
});

test("status lists live connectors with labels and the current selection", () => {
  const bridge = withClients([{ browser: "edge", profileId: "ab12cd34" }, { browser: "chrome", profileId: "11223344" }]);
  const status = bridge.status();
  // Spread into host-realm arrays: values coming out of the vm have different prototypes, which
  // deepStrictEqual would reject even when the contents match.
  const keys = [...status.clients].map((client) => client.key);
  const labels = [...status.clients].map((client) => client.label);
  assert.equal(status.clients.length, 2);
  assert.deepEqual(keys, [EDGE, CHROME]);
  assert.deepEqual(labels, ["Edge (profile ab12cd34)", "Chrome (profile 11223344)"]);
  assert.equal(status.selectedClient, null, "auto is reported as null, not a key");
  assert.equal(status.selectedKey, null);
});

test("a stale connector is not live and is not offered", () => {
  const bridge = withClients([{ browser: "edge", profileId: "ab12cd34", staleMs: 10 * 60_000 }]);
  assert.equal(bridge.status().clients.length, 0, "a connector that stopped polling drops out");
  assert.equal(bridge.resolveTargetClient(), undefined, "nothing live means nothing to route to");
});

test("routing: one connector is unambiguous, several refuse to be guessed", () => {
  const one = withClients([{ browser: "edge", profileId: "ab12cd34" }]);
  assert.equal(one.resolveTargetClient(), EDGE);

  const none = withClients([]);
  assert.equal(none.resolveTargetClient(), undefined, "nothing connected yet waits for the first arrival");

  const two = withClients([{ browser: "edge", profileId: "ab12cd34" }, { browser: "chrome", profileId: "11223344" }]);
  assert.throws(
    () => two.resolveTargetClient(),
    (error) => {
      assert.match(error.message, /2 connectors are connected/);
      assert.match(error.message, /edge:ab12cd34/);
      assert.match(error.message, /chrome:11223344/);
      assert.match(error.message, /\/chrome connector/);
      return true;
    },
  );
});

test("routing: an explicit selection wins, and a vanished selection fails loudly", () => {
  const bridge = withClients([{ browser: "edge", profileId: "ab12cd34" }, { browser: "chrome", profileId: "11223344" }], CHROME);
  assert.equal(bridge.resolveTargetClient(), CHROME, "the selected connector is used even when several are live");

  // The chosen one goes away: report it rather than silently driving the other browser.
  bridge.clients.delete(CHROME);
  assert.throws(
    () => bridge.resolveTargetClient(),
    (error) => {
      assert.match(error.message, /preferred connector \(chrome:11223344\) is not connected/);
      return true;
    },
  );
});

test("selectClient accepts auto, a key, and a unique browser name — and rejects ambiguity", () => {
  const bridge = withClients([{ browser: "edge", profileId: "ab12cd34" }, { browser: "chrome", profileId: "11223344" }]);

  bridge.selectClient(EDGE);
  assert.equal(bridge.selectedClient, EDGE, "an exact key selects");
  assert.equal(bridge.resolveTargetClient(), EDGE);

  bridge.selectClient("chrome");
  assert.equal(bridge.selectedClient, "chrome", "a browser name is saved as the NAME, not the key");
  assert.equal(bridge.resolveTargetClient(), CHROME, "...and still resolves to the right connector");

  bridge.selectClient("auto");
  assert.equal(bridge.selectedClient, undefined, "auto clears the selection");
  bridge.selectClient("");
  assert.equal(bridge.selectedClient, undefined, "an empty argument also means auto");

  assert.throws(() => bridge.selectClient("firefox"), /No connected connector matches 'firefox'/);

  // Two profiles of the same browser: the profile must be named.
  const twoEdges = withClients([{ browser: "edge", profileId: "ab12cd34" }, { browser: "edge", profileId: "ff99ee88" }]);
  assert.throws(() => twoEdges.selectClient("edge"), /2 edge connectors are connected/);
  twoEdges.selectClient(OTHER_EDGE);
  assert.equal(twoEdges.selectedClient, OTHER_EDGE);
});

test("the choice is PERSISTED, so a new session inherits it instead of asking again", () => {
  const first = withClients([{ browser: "edge", profileId: "ab12cd34" }]);
  first.selectClient("edge");
  assert.deepEqual([...saved.writes], ["edge"], "selecting writes the preference to disk");

  // A brand-new session: new bridge, nothing told to it, preference read from disk.
  const nextSession = withClients([{ browser: "edge", profileId: "ab12cd34" }], "edge");
  assert.equal(nextSession.resolveTargetClient(), EDGE, "the new session already knows which connector to drive");

  // ...and with a second connector also live, it still does not ask.
  const withBoth = withClients([{ browser: "edge", profileId: "ab12cd34" }, { browser: "chrome", profileId: "11223344" }], "edge");
  assert.equal(withBoth.resolveTargetClient(), EDGE, "the saved preference beats the refuse-to-guess rule");
});

test("a saved browser name survives the profile id changing", () => {
  // The profile id lives in per-profile extension storage, so clearing it or reinstalling the
  // connector changes it. A saved browser name must keep working anyway.
  const bridge = withClients([{ browser: "edge", profileId: "brandnew1" }], "edge");
  assert.equal(bridge.resolveTargetClient(), "edge:brandnew1", "browser name still matches the new profile");
});

test("a saved preference that is not connected refuses instead of driving another browser", () => {
  const bridge = withClients([{ browser: "chrome", profileId: "11223344" }], "edge");
  assert.throws(
    () => bridge.resolveTargetClient(),
    (error) => {
      assert.match(error.message, /preferred connector \(edge\) is not connected/);
      assert.match(error.message, /chrome:11223344/, "it reports what IS connected");
      return true;
    },
    "preferring Edge must never silently fall through to Chrome",
  );
});

test("selecting auto clears the saved preference too", () => {
  const bridge = withClients([{ browser: "edge", profileId: "ab12cd34" }], "edge");
  bridge.selectClient("auto");
  assert.equal(saved.value, undefined, "auto is persisted as no preference");
  assert.deepEqual([...saved.writes], [undefined]);
});

test("delivery: a command only reaches the connector it is addressed to", async () => {
  const bridge = withClients([{ browser: "edge", profileId: "ab12cd34" }, { browser: "chrome", profileId: "11223344" }]);

  // Both connectors are long-polling.
  let registerEdge;
  let registerChrome;
  const edgePoll = bridge.waitForCommand(5_000, (waiter) => { registerEdge = waiter; }, EDGE);
  const chromePoll = bridge.waitForCommand(5_000, (waiter) => { registerChrome = waiter; }, CHROME);
  assert.equal(typeof registerEdge, "function");
  assert.equal(typeof registerChrome, "function");

  // A command for Chrome must not be handed to the Edge poll that is also waiting.
  bridge.enqueue({ id: "c1", action: "tab.list", params: {}, targetClient: CHROME });
  assert.equal(bridge.queue.length, 0, "a waiting connector takes it immediately");
  const chromeGot = await chromePoll;
  assert.equal(chromeGot.id, "c1", "Chrome received its own command");

  // Now the reverse: Edge is still waiting and must take only its own command.
  bridge.enqueue({ id: "e1", action: "tab.list", params: {}, targetClient: EDGE });
  const edgeGot = await edgePoll;
  assert.equal(edgeGot.id, "e1", "Edge received its own command, not Chrome's");
});

test("delivery: a command for a connector that is not polling waits in the queue for it", () => {
  const bridge = withClients([{ browser: "edge", profileId: "ab12cd34" }, { browser: "chrome", profileId: "11223344" }]);
  bridge.enqueue({ id: "c1", action: "tab.list", params: {}, targetClient: CHROME });
  assert.equal(bridge.queue.length, 1, "queued rather than delivered to nobody");

  // The wrong connector polling must not be handed it...
  assert.equal(bridge.takeQueuedForClient(EDGE), undefined, "Edge must never receive Chrome's command");
  assert.equal(bridge.queue.length, 1, "and it is still waiting");
  // ...but the right one picks it up.
  assert.equal(bridge.takeQueuedForClient(CHROME).id, "c1");
  assert.equal(bridge.queue.length, 0);
});

test("delivery: an unrouted command (nothing connected yet) is taken by the first arrival", () => {
  const bridge = withClients([]);
  bridge.enqueue({ id: "x1", action: "tab.version", params: {} });
  assert.equal(bridge.queue.length, 1);
  assert.equal(bridge.takeQueuedForClient("edge:brandnew").id, "x1", "first connector to poll takes it");
});

test("delivery: a waiter that times out unregisters and does not block later deliveries", async () => {
  const bridge = withClients([{ browser: "edge", profileId: "ab12cd34" }]);
  const timedOut = await bridge.waitForCommand(5, undefined, EDGE);
  assert.equal(timedOut, undefined, "the long poll returns empty rather than hanging");
  assert.equal(bridge.waiters.has(EDGE), false, "the waiter list is cleaned up");

  let register;
  bridge.waitForCommand(5_000, (waiter) => { register = waiter; }, EDGE);
  assert.equal(bridge.waiters.get(EDGE).length, 1);
  bridge.enqueue({ id: "after-timeout", action: "tab.list", params: {}, targetClient: EDGE });
  assert.equal(register !== undefined, true);
  assert.equal(bridge.queue.length, 0, "a fresh waiter still receives deliveries");
});

test("client mode: the connection belongs to the OWNER, not to this empty process", async () => {
  // A Pi session that does not own port 17318 never receives a poll itself, so its own lastSeenAt and
  // client map are empty by design. Reading them locally is what reported "waiting for extension" and
  // "No connector is connected" while commands were routing to a healthy connector through the owner.
  const bridge = newBridge();
  bridge.mode = "client";
  net.status = {
    url: "http://127.0.0.1:17318",
    mode: "server",
    connected: true,
    clientName: "Pi Chrome Connector gfcbdfcmfejelnocemdajdhmafhdfkln",
    clientBrowser: "edge",
    clientProfileId: "9d233ecf",
    clientLabel: "Edge (profile 9d233ecf)",
    clients: [{ key: "edge:9d233ecf", browser: "edge", profileId: "9d233ecf", label: "Edge (profile 9d233ecf)" }],
  };

  // The state that used to be reported to the user, before consulting the owner.
  assert.equal(bridge.connected, false, "local state knows nothing in client mode");
  assert.deepEqual([...bridge.status().clients], []);
  assert.equal(bridge.clientLabel(), undefined);

  const status = await bridge.refreshStatus();
  assert.equal(net.calls, 1, "the owner's /status is consulted");
  assert.equal(bridge.connected, true, "the owner's connection is this session's connection");
  assert.equal(bridge.clientLabel(), "Edge (profile 9d233ecf)", "and it can name the browser it is driving");
  assert.deepEqual([...status.clients].map((client) => client.key), ["edge:9d233ecf"]);

  // status() must agree afterwards, so a caller that forgot to await refreshStatus is not misled either.
  assert.equal(bridge.status().connected, true);
  assert.deepEqual([...bridge.status().clients].map((client) => client.key), ["edge:9d233ecf"]);
});

test("client mode: an unreachable owner keeps the last known view", async () => {
  const bridge = newBridge();
  bridge.mode = "client";
  net.status = { connected: true, clients: [{ key: "edge:9d233ecf", label: "Edge (profile 9d233ecf)" }] };
  await bridge.refreshStatus();
  net.fail = true;
  const status = await bridge.refreshStatus();
  // A transient blip must not read as "no connector connected": that is the false alarm that sent a
  // user to reinstall a working extension.
  assert.equal(status.connected, true);
  assert.equal(bridge.connected, true);
  assert.deepEqual([...bridge.status().clients].map((client) => client.key), ["edge:9d233ecf"]);
});

test("server mode does not fetch its own status over HTTP", async () => {
  const bridge = withClients([{ browser: "edge", profileId: "ab12cd34" }]);
  const status = await bridge.refreshStatus();
  assert.equal(net.calls, 0, "the owner reads local state directly");
  assert.deepEqual([...status.clients].map((client) => client.key), [EDGE]);
  assert.equal(status.connected, true);
});

test("client mode against an OLDER owner: reported as connected, and the gap is named", async () => {
  // An owner running an older pi-chrome answers with only connected+clientName, no client list.
  const bridge = newBridge();
  bridge.mode = "client";
  net.status = { connected: true, clientName: "Pi Chrome Connector gfcbdfcmfejelnocemdajdhmafhdfkln" };
  const status = await bridge.refreshStatus();
  assert.equal(bridge.connected, true, "a connector IS connected and must be reported as such");
  const text = describeConnectorStatus(status);
  assert.doesNotMatch(text, /No connector is connected/);
  assert.match(text, /Connector connected: Pi Chrome Connector/);
  assert.match(text, /\/reload in that session/);
});

test("a preference set while NOTHING is connected waits for a connector instead of failing", () => {
  // A browser restart or an MV3 service-worker suspension leaves zero connectors for a moment. With a
  // preference set this used to throw immediately, while without one it waited — so the same brief
  // absence was survivable or fatal depending on an unrelated setting. It must always wait.
  const bridge = withClients([], "edge");
  assert.equal(bridge.resolveTargetClient(), undefined, "unrouted, so the first arrival takes it");

  // It must still refuse when a DIFFERENT browser is the only one there: that is the case the
  // preference exists to protect, and it is not the same as "nothing connected yet".
  bridge.clients.set("chrome:11223344", {
    key: "chrome:11223344", browser: "chrome", profileId: "11223344", lastSeenAt: Date.now(),
  });
  assert.throws(() => bridge.resolveTargetClient(), /preferred connector \(edge\) is not connected/);

  // And with no preference at all, zero connectors still waits too.
  assert.equal(withClients([]).resolveTargetClient(), undefined);
});

test("the preference is re-read from disk, so another session's change takes effect at once", () => {
  // The bridge can change owner at any moment and the preference is machine-wide state that any session
  // may change. A session holding a stale copy would route by a value the user already replaced.
  // Observed live: a just-reloaded bridge reported no preference while the file said "edge".
  const bridge = withClients(
    [{ browser: "edge", profileId: "ab12cd34" }, { browser: "chrome", profileId: "11223344" }],
    "edge",
  );
  assert.equal(bridge.resolveTargetClient(), EDGE);

  // Another session switches to Chrome. This one was never restarted.
  saved.value = "chrome";
  assert.equal(bridge.resolveTargetClient(), CHROME, "the file wins over the in-memory copy");

  // And clearing it elsewhere means auto everywhere — not the stale value.
  saved.value = undefined;
  assert.throws(() => bridge.resolveTargetClient(), /2 connectors are connected/, "auto, refusing to guess");

  // status() must agree, so the reported selection is never the stale one either.
  saved.value = "edge";
  assert.equal(bridge.status().selectedClient, "edge");
  assert.equal(bridge.status().selectedKey, EDGE);
});

test("pruning a connector that stopped polling must not discard the saved preference", () => {
  // A browser closed for a few minutes is pruned from the client list. That used to also drop the
  // selection whenever it was not a key in the map — and a preference may legitimately be a bare
  // browser name ("edge") rather than a key ("edge:9d233ecf"), so a preference was wiped on the next
  // poll, seconds after being set. File intact, memory empty: exactly the contradiction seen live.
  const bridge = withClients([{ browser: "edge", profileId: "ab12cd34", staleMs: 10 * 60_000 }], "edge");
  bridge.lastSeenAt = Date.now();
  bridge.pruneStaleClients();
  assert.equal(bridge.status().clients.length, 0, "the long-gone connector is forgotten");
  assert.equal(saved.value, "edge", "but the user's choice survives its absence");
  assert.equal(bridge.status().selectedClient, "edge");

  // And when a DIFFERENT browser is the one present, the preference still refuses rather than
  // quietly switching — preferring Edge must never mean driving Chrome.
  bridge.clients.set("chrome:11223344", {
    key: "chrome:11223344", browser: "chrome", profileId: "11223344", lastSeenAt: Date.now(),
  });
  assert.throws(() => bridge.resolveTargetClient(), /preferred connector \(edge\) is not connected/);
});

// The duplicate-load guard, loaded on its own (it is a pure function).
function loadIsDuplicateExtensionRoot() {
  const start = indexSource.indexOf("function isDuplicateExtensionRoot(");
  assert.ok(start >= 0, "could not locate isDuplicateExtensionRoot");
  const end = indexSource.indexOf("\n}\n", start);
  assert.ok(end > start, "could not locate the end of isDuplicateExtensionRoot");
  const sandbox = { console };
  vm.runInNewContext(
    stripTypeScriptTypes(indexSource.slice(start, end + 3)) + "\n;globalThis.__f = isDuplicateExtensionRoot;",
    sandbox,
  );
  return sandbox.__f;
}

test("a reload from the SAME root must replace, never skip — skipping breaks /chrome silently", () => {
  const isDuplicate = loadIsDuplicateExtensionRoot();
  const ROOT = "C:/x/pi-chrome";

  // First load: nothing recorded yet.
  assert.equal(isDuplicate(undefined, ROOT), false, "first load proceeds");

  // A reload: the flag is from this same root. It must proceed. Skipping here is the bug that made
  // /chrome and every chrome_* tool vanish, with no error, until Pi was fully restarted.
  assert.equal(isDuplicate({ version: "0.15.51.2", root: ROOT, token: Symbol("old") }, ROOT), false,
    "a reload replaces the previous instance");

  // No token either (written by an older build that never cleared it on reload): still same root.
  assert.equal(isDuplicate({ version: "0.15.19", root: ROOT }, ROOT), false, "stale old-build flag is replaced");

  // A genuinely different root IS a duplicate install and must be skipped.
  assert.equal(isDuplicate({ version: "0.15.51.2", root: "C:/other/pi-chrome", token: Symbol("x") }, ROOT), true,
    "a second copy from another root is refused");
  assert.equal(isDuplicate({ version: "0.1.0", root: "C:/other/pi-chrome" }, ROOT), true, "and so is an old one");
});
