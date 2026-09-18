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
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Math, JSON, Map, Promise, Error, DEFAULT_TIMEOUT_MS: 1000,
    readPreferredConnector: () => saved.value,
    writePreferredConnector: (value) => { saved.writes.push(value); saved.value = value; },
  };
  vm.runInNewContext(stripTypeScriptTypes(source) + "\n;globalThis.__Bridge = ChromeProfileBridge;", sandbox);
  return { Bridge: sandbox.__Bridge, saved };
}

const { Bridge, saved } = loadBridgeClass();
const EDGE = "edge:ab12cd34";
const OTHER_EDGE = "edge:ff99ee88";
const CHROME = "chrome:11223344";

// Construct a bridge the way a fresh Pi session does. `preference` is what is already on disk.
function newBridge(preference) {
  saved.value = preference;
  saved.writes.length = 0;
  return new Bridge("127.0.0.1", 17318);
}

// Register connectors the way a real /next poll does.
function withClients(specs, preference) {
  const bridge = newBridge(preference);
  for (const spec of specs) {
    const key = bridge.clientKeyOf(spec.browser, spec.profileId, spec.name);
    bridge.clients.set(key, {
      key,
      browser: spec.browser,
      profileId: spec.profileId,
      name: spec.name,
      lastSeenAt: Date.now() - (spec.staleMs ?? 0),
    });
  }
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
