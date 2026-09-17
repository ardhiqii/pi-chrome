// Unit coverage for this fork's raw-CDP passthrough (cdp.call / cdp.targets) and the
// best-effort focus emulation added to attachDebugger. Chrome APIs are mocked and no bridge or
// live browser is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const workerSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/browser-extension/service_worker.js", import.meta.url), "utf8");
const indexSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));

// ---- worker harness (same shape as input-reliability.test.mjs) ----
function harness() {
  const calls = [], detaches = [];
  let attachCount = 0;
  let sendCommandImpl = () => {};
  const listener = { addListener() {}, removeListener() {} };
  const chrome = {
    runtime: { id: "test", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null },
    alarms: { create() {}, onAlarm: listener },
    action: { onClicked: listener, setBadgeText() {}, setBadgeBackgroundColor() {} },
    webNavigation: { onCommitted: listener },
    scripting: { executeScript: async () => [] },
    tabs: { query: async () => [], get: async () => null },
    debugger: {
      onDetach: listener,
      getTargets: (cb) => cb([]),
      attach: async () => { attachCount += 1; },
      detach: async (debuggee) => { detaches.push(clone(debuggee)); },
      sendCommand: (debuggee, method, params, cb) => {
        calls.push({ debuggee: clone(debuggee), method, params: clone(params) });
        sendCommandImpl(debuggee, method, params, cb);
      },
    },
  };
  const worker = {
    chrome, console, setTimeout, clearTimeout, setInterval: () => 0,
    navigator: { userAgent: "unit-test" }, fetch: async () => { throw new Error("no network in unit tests"); },
  };
  worker.self = worker;
  vm.runInNewContext(workerSource, worker);
  worker.sleep = async () => {};
  return {
    worker, chrome, calls, detaches,
    attachCount: () => attachCount,
    lex: (expr) => vm.runInContext(expr, worker),
    setSendCommand: (fn) => { sendCommandImpl = fn; },
  };
}

// Slice the CHROME_TOOL_NAMES declaration out of index.ts and evaluate it after stripping the
// TypeScript-only `as const`. This is the set deactivateChromeTools filters on, so a tool missing
// from it survives /chrome revoke (and authorization expiry) as a listed, callable tool.
function chromeToolNamesFromIndex() {
  const from = indexSource.indexOf("const CHROME_TOOL_NAMES = [");
  assert.ok(from >= 0, "missing CHROME_TOOL_NAMES declaration in index.ts");
  const endMarker = "] as const;";
  const to = indexSource.indexOf(endMarker, from);
  assert.ok(to > from, "unterminated CHROME_TOOL_NAMES declaration in index.ts");
  const declaration = indexSource.slice(from, to + endMarker.length);
  return vm.runInNewContext(`${stripTypeScriptTypes(declaration)}\nCHROME_TOOL_NAMES;`, {});
}

// Every chrome_* name registered via pi.registerTool in index.ts. Scans the raw registration
// blocks so a newly added tool cannot drift out of CHROME_TOOL_NAMES unnoticed.
function registeredChromeToolNames() {
  const names = [];
  for (let from = indexSource.indexOf("pi.registerTool({"); from >= 0; ) {
    const to = indexSource.indexOf("\n\t});", from);
    assert.ok(to > from, "unterminated pi.registerTool call in index.ts");
    const match = indexSource.slice(from, to).match(/\bname: "(chrome_[a-z_]+)"/);
    if (match) names.push(match[1]);
    from = indexSource.indexOf("pi.registerTool({", to + 1);
  }
  return names;
}

// Configure the real chain (no getTabByParams/attachDebugger/cdp stubs): only the Chrome APIs
// are mocked, so dispatch exercises tab resolution, page-target attach, and cdpRaw for real.
function integrationHarness() {
  const h = harness();
  const tab = { id: 17, windowId: 1, url: "https://fixture.test/", title: "Fixture", status: "complete", active: true, groupId: -1 };
  h.chrome.tabs.query = async () => [{ ...tab }];
  h.chrome.tabs.get = async (id) => (Number(id) === 17 ? { ...tab } : null);
  h.chrome.debugger.getTargets = (cb) => cb([{ id: "page-target-1", tabId: 17, type: "page", url: "https://fixture.test/", attached: false }]);
  return h;
}

test("CHROME_TOOL_NAMES is exactly the registered chrome_* set so /chrome revoke deactivates every tool", () => {
  const names = chromeToolNamesFromIndex();
  const registered = registeredChromeToolNames();
  assert.ok(registered.length > 0, "found no chrome_* tool registrations in index.ts");
  assert.ok(registered.includes("chrome_find") && registered.includes("chrome_inspect"), "the scanner must see the chrome_find/chrome_inspect registrations");
  assert.deepEqual(
    [...names].sort(),
    [...registered].sort(),
    "every registered chrome_* tool must be in CHROME_TOOL_NAMES and vice versa; a missing name survives /chrome revoke as a listed, callable tool",
  );
});

test("cdp.call rejects a missing/blank/non-string method before touching the debugger", async () => {
  const h = harness();
  const touched = [];
  h.worker.getTabByParams = async () => { touched.push("getTabByParams"); return { id: 2 }; };
  h.worker.attachDebugger = async () => { touched.push("attachDebugger"); };
  h.worker.cdp = async () => { touched.push("cdp"); return {}; };
  for (const method of [undefined, null, "", "   ", 42, {}, ["Runtime.evaluate"]]) {
    await assert.rejects(h.worker.dispatch("cdp.call", { method }), /cdp\.call requires a non-empty string "method"/);
  }
  assert.deepEqual(touched, [], "no tab resolution, attach, or sendCommand on invalid input");
  assert.equal(h.calls.length, 0);
});

test("cdp.call rejects a non-object params payload but treats null as not provided", async () => {
  const h = harness();
  h.worker.getTabByParams = async () => ({ id: 2 });
  h.worker.attachDebugger = async () => {};
  h.worker.cdp = async () => ({ ok: true });
  for (const bad of ["expression", 5, true, ["Runtime.evaluate"]]) {
    await assert.rejects(h.worker.dispatch("cdp.call", { method: "Runtime.evaluate", params: bad }), /"params" must be a plain object of CDP parameters/);
  }
  assert.deepEqual(await h.worker.dispatch("cdp.call", { method: "Runtime.evaluate", params: null }), { ok: true });
});

test("cdp.call resolves the tab, attaches, and forwards the trimmed method/params", async () => {
  const h = harness();
  const seen = {};
  h.worker.getTabByParams = async (params) => { seen.lookup = clone(params); return { id: 17, windowId: 1 }; };
  h.worker.attachDebugger = async (tabId) => { seen.attached = tabId; };
  h.worker.cdp = async (tabId, method, params, opts) => { seen.call = { tabId, method, params: clone(params), opts: clone(opts) }; return { value: 42 }; };
  const value = await h.worker.dispatch("cdp.call", { method: "  Runtime.evaluate  ", params: { expression: "1+1" }, targetId: "17" });
  assert.deepEqual(value, { value: 42 });
  assert.equal(seen.attached, 17);
  assert.deepEqual(seen.call, { tabId: 17, method: "Runtime.evaluate", params: { expression: "1+1" }, opts: { timeoutMs: 5_000 } });
  assert.equal(seen.lookup.targetId, "17");
});

test("cdp.call timeout policy: default, explicit, string, zero and clamped", async () => {
  const h = harness();
  const seen = [];
  h.worker.getTabByParams = async () => ({ id: 3 });
  h.worker.attachDebugger = async () => {};
  h.worker.cdp = async (_tabId, _method, _params, opts) => { seen.push(opts.timeoutMs); return {}; };
  await h.worker.dispatch("cdp.call", { method: "Runtime.evaluate" });
  await h.worker.dispatch("cdp.call", { method: "Runtime.evaluate", timeoutMs: 45_000 });
  await h.worker.dispatch("cdp.call", { method: "Runtime.evaluate", timeoutMs: 10_000_000 });
  await h.worker.dispatch("cdp.call", { method: "Runtime.evaluate", timeoutMs: 0 });
  await h.worker.dispatch("cdp.call", { method: "Runtime.evaluate", timeoutMs: "120000" });
  assert.deepEqual(seen, [5_000, 45_000, 120_000, 5_000, 120_000]);
});

test("commandTimeoutMs widens only cdp.call and keeps every other action at the original deadline", () => {
  const h = harness();
  assert.equal(h.worker.commandTimeoutMs("page.click", {}), 25_000);
  assert.equal(h.worker.commandTimeoutMs("cdp.call", {}), 25_000);
  assert.equal(h.worker.commandTimeoutMs("cdp.call", { timeoutMs: 45_000 }), 50_000);
  assert.equal(h.worker.commandTimeoutMs("cdp.call", { timeoutMs: 10_000_000 }), 125_000);
  assert.equal(h.worker.commandTimeoutMs("cdp.call", { timeoutMs: 1_000 }), 25_000);
  assert.equal(h.worker.cdpCallTimeoutMs({ timeoutMs: -5 }), 5_000);
  assert.equal(h.worker.cdpCallTimeoutMs({ timeoutMs: Number.NaN }), 5_000);
});

test("a cdpRaw timeout detaches and forgets the session so the next call re-attaches", async () => {
  const h = harness();
  const attached = h.lex("attachedTabs");
  h.setSendCommand(() => { /* never call back: force the timeout path */ });
  attached.set(9, { detachAt: Date.now() + 60_000, debuggee: { tabId: 9 } });
  await assert.rejects(h.worker.cdpRaw(9, "Runtime.evaluate", {}, { timeoutMs: 40 }), /CDP Runtime\.evaluate timed out after 40ms/);
  assert.equal(attached.has(9), false, "timed-out session is forgotten");
  assert.deepEqual(h.detaches, [{ tabId: 9 }], "timed-out session is detached");
  h.setSendCommand((_debuggee, _method, _params, cb) => cb({ ok: true }));
  assert.deepEqual(await h.worker.cdpRaw(9, "Runtime.evaluate", {}), { ok: true }, "next call cleanly re-attaches");
  assert.equal(h.calls.at(-1).method, "Runtime.evaluate");
});

test("detachOnTimeout:false never tears down the session (best-effort focus emulation path)", async () => {
  const h = harness();
  const attached = h.lex("attachedTabs");
  h.setSendCommand(() => { /* force the timeout path */ });
  attached.set(4, { detachAt: Date.now() + 60_000, debuggee: { tabId: 4 } });
  await assert.rejects(
    h.worker.cdpRaw(4, "Emulation.setFocusEmulationEnabled", { enabled: true }, { timeoutMs: 30, detachOnTimeout: false }),
    /Emulation\.setFocusEmulationEnabled timed out after 30ms/,
  );
  assert.equal(attached.has(4), true, "session survives a best-effort timeout");
  assert.deepEqual(h.detaches, []);
});

test("attach applies Emulation.setFocusEmulationEnabled best-effort on the explicit page target", async () => {
  for (const failFocus of [false, true]) {
    const h = harness();
    h.chrome.debugger.getTargets = (cb) => cb([{ id: "page-target-1", tabId: 5, type: "page", url: "https://fixture.test/", attached: false }]);
    const focus = [];
    h.setSendCommand((debuggee, method, params, cb) => {
      if (method !== "Emulation.setFocusEmulationEnabled") { cb({}); return; }
      focus.push({ debuggee: clone(debuggee), params: clone(params) });
      if (failFocus) {
        h.chrome.runtime.lastError = { message: "focus emulation denied" };
        cb();
        h.chrome.runtime.lastError = null;
        return;
      }
      cb({});
    });
    const entry = await h.worker.attachDebugger(5);
    assert.ok(entry && entry.debuggee, "attach still succeeds");
    assert.equal(h.attachCount(), 1);
    assert.deepEqual(focus, [{ debuggee: { targetId: "page-target-1" }, params: { enabled: true } }]);
    assert.equal(h.lex("attachedTabs").has(5), true, "attach result is kept even when focus emulation fails");
    assert.deepEqual(h.detaches, [], "focus emulation never detaches");
    const failures = h.lex("attachDebugLog").filter((e) => e.kind === "focus-emulation-failed");
    assert.equal(failures.length, failFocus ? 1 : 0, "focus-emulation failure is recorded in the attach log");
    assert.equal(h.lex("FOCUS_EMULATION_ON_ATTACH"), true, "focus emulation is gated by a module constant");
  }
});

test("cdp.targets returns only the resolved tab's CDP targets without creating one", async () => {
  const h = harness();
  const lookups = [];
  h.worker.getTabByParams = async (_params, opts) => { lookups.push(clone(opts ?? {})); return { id: 8, windowId: 2, url: "https://fixture.test/", title: "Fixture" }; };
  h.chrome.debugger.getTargets = (cb) => cb([
    { id: "page-1", tabId: 8, type: "page", url: "https://fixture.test/", title: "Fixture", attached: false },
    { id: "other-1", tabId: 8, type: "other", url: "chrome-extension://abc/overlay.html", title: "Overlay", attached: true, extensionId: "abc" },
    { id: "other-tab-1", tabId: 9, type: "page", url: "https://unrelated.test/", title: "Unrelated", attached: false },
    { id: "worker-1", type: "service_worker", url: "https://fixture.test/sw.js", title: "", attached: false },
  ]);
  const result = await h.worker.dispatch("cdp.targets", { targetId: "8" });
  assert.deepEqual(lookups, [{ createOwnedTarget: false }]);
  assert.deepEqual(clone(result.tab), { id: 8, windowId: 2, url: "https://fixture.test/", title: "Fixture" });
  assert.equal(result.targets.length, 2, "only targets anchored to the resolved tab are reported");
  assert.deepEqual(clone(result.targets[1]), { id: "other-1", tabId: 8, type: "other", url: "chrome-extension://abc/overlay.html", title: "Overlay", attached: true, extensionId: "abc" });
  assert.equal(result.otherTabTargetCount, 1, "only targets anchored to another tab are counted; tab-less targets are not");
  assert.doesNotMatch(JSON.stringify(result), /unrelated\.test/, "unrelated tab URLs never reach the caller");
});

test("cdp.targets still reports targets when no tab can be resolved", async () => {
  const h = harness();
  h.worker.getTabByParams = async () => { throw new Error("no automation tab yet"); };
  h.chrome.debugger.getTargets = (cb) => cb([{ id: "page-1", tabId: 1, type: "page", url: "https://x.test/", attached: false }]);
  const result = await h.worker.dispatch("cdp.targets", {});
  assert.equal(result.tab, null);
  assert.equal(result.targets.length, 1);
});

test("cdp.targets propagates an explicit selector failure instead of degrading to a tab-less list", async () => {
  const h = harness();
  h.chrome.debugger.getTargets = (cb) => cb([{ id: "page-1", tabId: 1, type: "page", url: "https://x.test/", attached: false }]);
  await assert.rejects(h.worker.dispatch("cdp.targets", { targetId: "999" }), /No Chrome tab with id 999/);
  await assert.rejects(h.worker.dispatch("cdp.targets", { urlIncludes: "no-such-tab.test" }), /No matching Chrome tab found/);
});

test("cdp.targets still degrades to the tab-less list when the lookup fails for a non-selector reason", async () => {
  const h = harness();
  h.chrome.tabs.query = async () => { throw new Error("Tabs cannot be queried right now"); };
  h.chrome.debugger.getTargets = (cb) => cb([{ id: "page-1", tabId: 1, type: "page", url: "https://x.test/", attached: false }]);
  const result = await h.worker.dispatch("cdp.targets", { targetId: "999" });
  assert.equal(result.tab, null);
  assert.equal(result.targets.length, 1);
});

test("cdp.call integration: the real resolve/attach/cdp chain binds the explicit page target", async () => {
  const h = integrationHarness();
  h.setSendCommand((_debuggee, method, _params, cb) => {
    if (method === "Runtime.evaluate") { cb({ result: { type: "number", value: 2 } }); return; }
    cb({}); // focus emulation on attach
  });
  const result = await h.worker.dispatch("cdp.call", { method: "Runtime.evaluate", params: { expression: "1+1" }, targetId: "17", timeoutMs: 1234 });
  assert.deepEqual(clone(result), { result: { type: "number", value: 2 } });
  assert.equal(h.attachCount(), 1, "exactly one attach for the whole call");
  assert.equal(h.calls.length, 2, "focus emulation then the requested command");
  assert.deepEqual(h.calls[0], { debuggee: { targetId: "page-target-1" }, method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } });
  assert.deepEqual(h.calls[1], { debuggee: { targetId: "page-target-1" }, method: "Runtime.evaluate", params: { expression: "1+1" } });
});

test("cdp.call integration: stale-session retry re-attaches once and keeps the caller's timeoutMs", async () => {
  const h = integrationHarness();
  let evaluateCalls = 0;
  h.setSendCommand((_debuggee, method, _params, cb) => {
    if (method !== "Runtime.evaluate") { cb({}); return; }
    evaluateCalls += 1;
    if (evaluateCalls === 1) {
      h.chrome.runtime.lastError = { message: "Debugger is not attached to the page" };
      cb();
      h.chrome.runtime.lastError = null;
      return;
    }
    // The retried command never calls back: the caller's deadline must still fire.
  });
  await assert.rejects(
    h.worker.dispatch("cdp.call", { method: "Runtime.evaluate", params: { expression: "1+1" }, targetId: "17", timeoutMs: 1234 }),
    /CDP Runtime\.evaluate timed out after 1234ms/,
  );
  assert.equal(h.attachCount(), 2, "the stale session is re-attached exactly once");
  assert.equal(evaluateCalls, 2, "the command is retried once after re-attach");
  assert.deepEqual(h.calls.at(-1), { debuggee: { targetId: "page-target-1" }, method: "Runtime.evaluate", params: { expression: "1+1" } });
});

// ---- index.ts registration harness (slices the two new registrations only) ----
function registrationSource(name) {
  const marker = `pi.registerTool({\n\t\tname: "${name}",`;
  const from = indexSource.indexOf(marker);
  assert.ok(from >= 0, `missing registration for ${name}`);
  const endMarker = "\n\t});";
  const to = indexSource.indexOf(endMarker, from);
  assert.ok(to > from, `unterminated registration for ${name}`);
  return indexSource.slice(from, to + endMarker.length);
}

function indexHarness() {
  const registered = new Map(), sent = [], typeCalls = [];
  let respond = () => ({});
  const sandbox = {
    // Record every TypeBox factory call so tests can inspect the declared schema even though
    // there is no TypeScript compiler here; the factories themselves stay pass-throughs.
    Type: new Proxy({}, {
      get: (_target, factory) => (...args) => {
        typeCalls.push({ factory, args: clone(args) });
        return args[0] === undefined ? {} : args[0];
      },
    }),
    DEFAULT_TIMEOUT_MS: 30_000,
    BACKGROUND_PARAM_DESCRIPTION: "background policy",
    truncateText: (text, maxChars = 30_000) => (text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n[truncated]`),
    safeJson: (value) => JSON.stringify(value, null, 2),
    authorizedBridgeSend: async (action, params, timeout, signal) => {
      sent.push({ action, params: clone(params), timeout, hasSignal: signal !== undefined });
      return respond(action, params);
    },
    pi: { registerTool: (tool) => registered.set(tool.name, tool) },
  };
  const source = [registrationSource("chrome_cdp"), registrationSource("chrome_cdp_targets")].join("\n");
  vm.runInNewContext(stripTypeScriptTypes(source), sandbox);
  return {
    registered, sent, typeCalls,
    tool: (name, params = {}) => registered.get(name).execute("test", params, undefined),
    respond: (fn) => { respond = fn; },
  };
}

test("chrome_cdp forwards method/params/timeoutMs to the cdp.call bridge action", async () => {
  const h = indexHarness();
  const tool = h.registered.get("chrome_cdp");
  assert.ok(tool, "chrome_cdp is registered");
  assert.equal(tool.label, "Chrome CDP Call");
  assert.match(tool.description, /DevTools Protocol/);
  assert.match(tool.description, /escape hatch/);
  assert.match(tool.promptSnippet, /DevTools Protocol/);
  assert.match(tool.description, /NOT covered by background mode/);
  assert.doesNotMatch(tool.description, /Background mode \(default\) blocks/);
  h.respond(() => ({ resultType: "number", result: { value: 2 } }));
  const out = await h.tool("chrome_cdp", { method: "Runtime.evaluate", params: { expression: "1+1" }, timeoutMs: 45_000, targetId: "2" });
  assert.equal(h.sent[0].action, "cdp.call");
  assert.equal(h.sent[0].params.method, "Runtime.evaluate");
  assert.deepEqual(h.sent[0].params.params, { expression: "1+1" });
  assert.equal(h.sent[0].timeout, 53_000, "bridge deadline sits above the extension-side deadline");
  assert.deepEqual(out.details.value, { resultType: "number", result: { value: 2 } });
  assert.match(out.content[0].text, /resultType/);
});

test("chrome_cdp summarises screenshot/binary payloads instead of returning base64", async () => {
  const h = indexHarness();
  const data = "A".repeat(1_000);
  h.respond(() => ({ data, metadata: { size: "1x1" } }));
  const out = await h.tool("chrome_cdp", { method: "Page.captureScreenshot", params: { format: "png" } });
  const text = out.content[0].text;
  assert.doesNotMatch(text, /A{10}/, "base64 must not reach the text result");
  assert.match(text, /omitted/);
  assert.match(text, /bytes/);
  assert.doesNotMatch(JSON.stringify(out.details), /A{10}/, "base64 must not reach details either");
  assert.deepEqual(clone(out.details.value.fields), ["metadata"]);
  assert.equal(out.details.value.bytes, 750);
  assert.equal(h.sent[0].timeout, 30_000, "default bridge deadline when timeoutMs is absent");
});

test("chrome_cdp summarises oversized non-data results so details stay bounded", async () => {
  const h = indexHarness();
  const big = "A".repeat(2_000_000);
  h.respond(() => ({ resultType: "string", result: { type: "string", value: big } }));
  const out = await h.tool("chrome_cdp", { method: "Runtime.evaluate", params: { expression: "big()" } });
  assert.match(out.content[0].text, /\[truncated/);
  assert.match(out.content[0].text, /details omitted: \d+ chars of JSON/);
  assert.ok(out.content[0].text.length < 31_000, "content text stays capped by truncateText");
  assert.doesNotMatch(JSON.stringify(out.details), /A{10}/, "the raw payload never reaches details");
  assert.equal(out.details.value.omitted, "oversized-result");
  assert.deepEqual(clone(out.details.value.fields), ["resultType", "result"]);
  assert.ok(JSON.stringify(out.details).length < 1_000, "details stay small");
});

test("chrome_cdp keeps small non-data results in details unchanged", async () => {
  const h = indexHarness();
  h.respond(() => ({ resultType: "number", result: { value: 2 } }));
  const out = await h.tool("chrome_cdp", { method: "Runtime.evaluate", params: { expression: "1+1" } });
  assert.deepEqual(clone(out.details.value), { resultType: "number", result: { value: 2 } });
  assert.doesNotMatch(out.content[0].text, /details omitted/);
});

test("chrome_cdp rejects raw CDP fields passed at the top level", async () => {
  const h = indexHarness();
  await assert.rejects(
    h.tool("chrome_cdp", { method: "Runtime.evaluate", expression: "1+1" }),
    /unknown top-level parameter\(s\): expression/,
  );
  assert.equal(h.sent.length, 0, "the bridge is not called for a malformed call");
  // Every declared parameter remains accepted.
  const out = await h.tool("chrome_cdp", { method: "Runtime.evaluate", params: { expression: "1+1" }, timeoutMs: 1_000, targetId: "2", urlIncludes: "fixture", titleIncludes: "Fixture", background: true, host: "127.0.0.1", port: 17_318 });
  assert.ok(out.content[0].text);
});

test("chrome_cdp's declared schema requires method and allows additional params fields", () => {
  const h = indexHarness();
  const objectCalls = h.typeCalls.filter((c) => c.factory === "Object");
  const toolCall = objectCalls.find((c) => c.args[0] && Object.prototype.hasOwnProperty.call(c.args[0], "method"));
  assert.ok(toolCall, "chrome_cdp declares a method parameter");
  assert.match(toolCall.args[0].method.description, /CDP method name/);
  assert.match(toolCall.args[0].background.description, /does not block focus/);
  assert.ok(!("expression" in toolCall.args[0]), "CDP fields are not declared as top-level parameters");
  const paramsCall = objectCalls.find((c) => c.args[1]?.additionalProperties === true);
  assert.ok(paramsCall, "params is an open object for arbitrary CDP fields");
});

test("chrome_cdp_targets calls cdp.targets and renders a bounded summary", async () => {
  const h = indexHarness();
  h.respond(() => ({
    tab: { id: 8, title: "Fixture", url: "https://fixture.test/" },
    targets: [{ type: "page", tabId: 8, attached: false, url: "https://fixture.test/" }],
    otherTabTargetCount: 3,
  }));
  const out = await h.tool("chrome_cdp_targets", { targetId: "8" });
  assert.equal(h.sent[0].action, "cdp.targets");
  assert.match(h.registered.get("chrome_cdp_targets").description, /anchored to the resolved tab/);
  assert.match(out.content[0].text, /1 CDP target/);
  assert.match(out.content[0].text, /3 more on other tabs/);
  assert.match(out.content[0].text, /Fixture/);
  assert.deepEqual(out.details.value.tab, { id: 8, title: "Fixture", url: "https://fixture.test/" });
});
