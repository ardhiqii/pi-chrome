// Exercise the shipped cleanup helper and shutdown listener, without opening a bridge or Chrome.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}
const helper = stripTypeScriptTypes(section("const cleanupAutomationTargetBestEffort =", "const lockChromeControl ="));
const listener = section('pi.on("session_shutdown",', 'pi.on("before_agent_start",');

function harness(send, sessionKey = "session:test") {
  const timers = new Map();
  const events = [];
  let shutdown;
  const token = Symbol();
  const globalState = { loaded: { token } };
  const context = {
    AbortController, Promise,
    setTimeout(fn, ms) { const key = Symbol(); timers.set(key, { fn, ms }); return key; },
    clearTimeout(key) { timers.delete(key); },
    bridge: { send(...args) { events.push("send"); return send(...args); }, stop() { events.push("stop"); } },
    sessionCtx: {}, sessionKeyFor: () => sessionKey ?? undefined,
    clearAuthExpiryTimer() {}, clearCountdownInterval() {},
    globalState, PI_CHROME_GLOBAL_KEY: "loaded", instanceToken: token,
    pi: { on(name, handler) { assert.equal(name, "session_shutdown"); shutdown = handler; } },
  };
  vm.runInNewContext(`${helper}\n${listener}`, context);
  return { shutdown, timers, events, globalState };
}

// Delivery must settle before bridge.stop; reload does not issue cleanup at all.
{
  let complete;
  let request;
  const h = harness((...args) => {
    request = args;
    return new Promise((resolve) => { complete = resolve; });
  });
  const done = h.shutdown({ reason: "quit" });
  assert.deepEqual(h.events, ["send"]);
  assert.equal(request[0], "automation.cleanup");
  assert.equal(request[1].sessionKey, "session:test");
  assert.equal(request[2], 2000);
  assert.equal(request[3].aborted, false);
  complete();
  await done;
  assert.deepEqual(h.events, ["send", "stop"]);
  assert.equal(h.timers.size, 0);
  assert.equal(h.globalState.loaded, undefined);
}
{
  const h = harness(() => { throw new Error("reload must not send"); });
  await h.shutdown({ reason: "reload" });
  assert.deepEqual(h.events, ["stop"]);
  assert.equal(h.timers.size, 0);
}

// Even an owner request that never settles cannot hold up shutdown past its budget.
{
  let signal;
  const h = harness((_action, _params, _timeout, s) => { signal = s; return new Promise(() => {}); });
  const done = h.shutdown({});
  const [timer] = h.timers.values();
  assert.equal(timer.ms, 2000);
  timer.fn();
  await done;
  assert.equal(signal.aborted, true);
  assert.deepEqual(h.events, ["send", "stop"]);
  assert.equal(h.timers.size, 0);
}
for (const reason of ["quit", "new", "resume", "fork"]) {
  const h = harness(() => Promise.resolve({}));
  await h.shutdown({ reason });
  assert.deepEqual(h.events, ["send", "stop"]);
}
for (const send of [() => Promise.reject(new Error("offline")), () => { throw new Error("offline"); }]) {
  const h = harness(send);
  await h.shutdown({ reason: "exit" });
  assert.deepEqual(h.events, ["send", "stop"]);
  assert.equal(h.timers.size, 0);
}
{
  const h = harness(() => { throw new Error("unscoped cleanup must not send"); }, null);
  await h.shutdown({ reason: "exit" });
  assert.deepEqual(h.events, ["stop"]);
}
console.log("session-cleanup: shutdown ordering, reload, deadline, failures, and missing identity passed");
