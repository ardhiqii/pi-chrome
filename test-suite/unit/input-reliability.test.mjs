// Exercise the shipped worker against mocked Chrome APIs and a separate page world.
// This checks command routing and failure cleanup, not browser isTrusted semantics.
// Live input/selection fidelity is covered by challenges 16, 21, 31, and 44.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const workerSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/browser-extension/service_worker.js", import.meta.url), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness({ tag = "DIV", editable = true, initial = "", nodeId = 7, caretOffset = null } = {}) {
  const calls = [], selected = [], files = [], tabLookups = [], tabsGetCalls = [];
  const tabState = { id: 2, windowId: 1, url: "https://fixture.test/", status: "complete", title: "Fixture" };
  let selectAll = false;
  const element = {
    tagName: tag, type: tag === "INPUT" ? "text" : undefined,
    isContentEditable: editable, isConnected: true, textContent: initial,
    scrollIntoView() {}, getBoundingClientRect: () => ({ left: 10, top: 10, width: 200, height: 60 }),
    contains: (el) => el === element,
  };
  const selection = {
    rangeCount: caretOffset === null ? 0 : 1,
    anchorNode: element,
    anchorOffset: caretOffset ?? 0,
    isCollapsed: true,
    removeAllRanges() { selectAll = false; },
    addRange(range) { selected.push(range.target); selectAll = range.target === element; },
  };
  const page = vm.createContext({
    document: {
      activeElement: element,
      querySelector: (selector) => selector === "#target" ? element : null,
      createRange: () => ({
        target: null,
        endOffset: 0,
        selectNodeContents(target) { this.target = target; },
        setEnd(_node, offset) { this.endOffset = offset; },
        toString() {
          if (this.target !== element) return "";
          return String(element.value ?? element.textContent ?? "").slice(0, this.endOffset);
        },
      }),
    },
    getSelection: () => selection,
    location: { href: "https://fixture.test/" },
    __PI_CHROME_STATE__: { elements: { "el-1": element } },
  });
  page.window = page;
  const listener = { addListener() {}, removeListener() {} };
  const tabUpdated = { listeners: new Set(), addListener(fn) { this.listeners.add(fn); }, removeListener(fn) { this.listeners.delete(fn); } };
  const chrome = {
    runtime: { id: "test", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener },
    alarms: { create() {}, onAlarm: listener }, action: { onClicked: listener }, webNavigation: { onCommitted: listener },
    debugger: { onDetach: listener },
    scripting: { executeScript: async ({ func, args = [] }) => {
      calls.push({ method: "scripting.executeScript" });
      const fn = vm.runInContext(`(${func.toString()})`, page);
      return [{ result: await fn(...args) }];
    } },
    tabs: {
      get: async (id) => {
        tabsGetCalls.push(id);
        if (Number(id) !== tabState.id) throw new Error(`No tab with id ${id}`);
        return { ...tabState };
      },
      onUpdated: tabUpdated,
    },
  };
  const worker = {
    chrome, console, setTimeout, clearTimeout, setInterval: () => 0,
    navigator: { userAgent: "unit-test" }, fetch: async () => { throw new Error("no network in unit tests"); },
  };
  worker.self = worker;
  vm.runInNewContext(workerSource, worker);
  worker.sleep = async () => {};
  worker.getTabByParams = async (params) => {
    tabLookups.push(clone(params));
    return { id: Number(params.targetId ?? 2), windowId: 1 };
  };
  worker.bringToFront = async () => {};
  worker.attachDebugger = async () => {};
  worker.cdpMoveTo = async () => {};
  worker.cdp = async (tabId, method, params = {}) => {
    calls.push({ tabId, method, params: clone(params) });
    const error = h.failures.get(method);
    if (error) throw new Error(error);
    if (method === "Runtime.evaluate") {
      try {
        const result = vm.runInContext(params.expression, page);
        if (result === element) return { result: { objectId: "upload-object" } };
        return { result: { value: clone(result) } };
      } catch (error) {
        return { exceptionDetails: { text: error.message, exception: { description: error.message } } };
      }
    }
    if (method === "DOM.requestNode") return h.nodeResult;
    if (method === "DOM.setFileInputFiles") files.push(...params.files);
    if (method === "Input.insertText") element.textContent += params.text;
    if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") {
      if (params.key === "Delete") {
        // Triple-click selects a paragraph, not a whole multi-paragraph editor.
        element.textContent = selectAll ? "" : element.textContent.replace(/[^\n]*$/, "");
        selectAll = false;
      } else if (params.text) element.textContent += params.text;
    }
    return {};
  };
  worker.domFillFallback = async (_tabId, params) => {
    calls.push({ method: "domFillFallback" });
    element.textContent = params.text;
    return { input: "dom-fallback" };
  };
  const h = {
    worker, chrome, page, calls, element, selected, files, tabLookups, tabState, tabsGetCalls, selection, tabUpdated, failures: new Map(), nodeResult: { nodeId },
    call: (action, params = {}) => worker.dispatch(`page.${action}`, { targetId: "2", background: true, ...params }),
    commands: (method) => calls.filter((call) => call.method === method),
  };
  return h;
}

for (const [name, nodeResult] of [["node ID", { nodeId: 7 }], ["zero node ID", { nodeId: 0 }], ["missing node ID", {}], ["no response", undefined]]) {
  test(`upload accepts ${name} and releases the remote object`, async () => {
    const h = harness({ tag: "INPUT", editable: false });
    h.element.type = "file";
    h.nodeResult = nodeResult;
    const result = await h.call("upload", { uid: "el-1", paths: ["/tmp/a.txt", "/tmp/b.txt"] });
    const target = nodeResult?.nodeId ? { nodeId: 7 } : { objectId: "upload-object" };
    assert.deepEqual(h.commands("DOM.setFileInputFiles").map((c) => c.params), [{ ...target, files: ["/tmp/a.txt", "/tmp/b.txt"] }]);
    assert.deepEqual(h.files, ["/tmp/a.txt", "/tmp/b.txt"]);
    assert.equal(result.input, "chrome");
    assert.deepEqual(clone(result.uploaded), [{ path: "/tmp/a.txt" }, { path: "/tmp/b.txt" }]);
    assert.deepEqual(h.commands("Runtime.releaseObject").map((c) => c.params), [{ objectId: "upload-object" }]);
    assert.equal(h.calls.at(-1).method, "Runtime.releaseObject");
  });
}

test("upload falls back on requestNode failure, not on a failed file attachment", async () => {
  const h = harness({ tag: "INPUT", editable: false });
  h.element.type = "file";
  h.failures.set("DOM.requestNode", "node conversion unavailable");
  await h.call("upload", { selector: "#target", paths: ["/tmp/a.txt"] });
  assert.deepEqual(h.commands("DOM.setFileInputFiles")[0].params, { objectId: "upload-object", files: ["/tmp/a.txt"] });
  h.calls.length = 0;
  h.failures.set("DOM.setFileInputFiles", "attachment denied");
  h.failures.set("Runtime.releaseObject", "target closed during cleanup");
  await assert.rejects(h.call("upload", { selector: "#target", paths: ["/tmp/a.txt"] }), /attachment denied/);
  assert.equal(h.commands("DOM.setFileInputFiles").length, 1, "no object-ID retry after an uncertain file attachment");
  assert.equal(h.commands("Runtime.releaseObject").length, 1, "cleanup still runs on error");
  assert.equal(h.commands("Runtime.callFunctionOn").length, 0, "no notification after failed attachment");
});

test("upload releases valid node-path references on failure and tolerates notification/cleanup failure", async () => {
  const h = harness({ tag: "INPUT", editable: false });
  h.element.type = "file";
  h.failures.set("DOM.setFileInputFiles", "file inaccessible");
  await assert.rejects(h.call("upload", { selector: "#target", paths: ["/tmp/a.txt"] }), /file inaccessible/);
  assert.equal(h.commands("Runtime.releaseObject").length, 1);
  h.failures.delete("DOM.setFileInputFiles");
  for (const method of ["DOM.enable", "Runtime.callFunctionOn", "Runtime.releaseObject"]) h.failures.set(method, "optional step failed");
  const result = await h.call("upload", { selector: "#target", paths: ["/tmp/a.txt"] });
  assert.equal(result.input, "chrome");
});

test("upload rejects non-file elements, missing targets/paths, and stale UIDs without attaching anything", async () => {
  const h = harness();
  await assert.rejects(h.call("upload", { selector: "#target", paths: ["/tmp/a.txt"] }), /Target must be <input type=file>/);
  await assert.rejects(h.call("upload", { paths: ["/tmp/a.txt"] }), /selector or uid required/);
  await assert.rejects(h.call("upload", { selector: "#target", paths: [] }), /no file paths/);
  h.element.tagName = "INPUT";
  h.element.type = "file";
  h.element.isConnected = false;
  await assert.rejects(h.call("upload", { uid: "el-1", selector: "#target", paths: ["/tmp/a.txt"] }), /snapshot uid el-1 is stale/);
  await assert.rejects(h.call("upload", { uid: "missing", selector: "#target", paths: ["/tmp/a.txt"] }), /snapshot uid missing is stale/);
  assert.equal(h.commands("DOM.setFileInputFiles").length, 0);
});

const caption = "Long caption: café, 中文, 👩🏽‍💻.  Two spaces.\nSecond paragraph! ".repeat(12);
for (const target of [{ selector: "#target" }, { uid: "el-1" }, {}]) {
  test(`contenteditable typing uses one native insertText (${Object.keys(target)[0] ?? "already focused"})`, async () => {
    const h = harness();
    const result = await h.call("type", { ...target, text: caption });
    assert.deepEqual(h.commands("Input.insertText").map((c) => c.params), [{ text: caption }]);
    assert.equal(h.commands("Input.dispatchKeyEvent").length, 0);
    assert.equal(h.element.textContent, caption);
    assert.equal(result.input, "chrome");
    assert.equal(result.length, caption.length);
    assert.equal(result.typing, "insertText");
  });
}

for (const perCharacter of [false, true]) {
  test(`contenteditable fill replaces every paragraph (perCharacter=${perCharacter})`, async () => {
    const h = harness({ initial: "First paragraph\nSecond paragraph\nThird paragraph" });
    const text = perCharacter ? "Hello!" : caption;
    const result = await h.call("fill", { uid: "el-1", text, perCharacter, domFallback: false });
    assert.equal(h.selected.length, 1);
    assert.equal(h.selected[0], h.element);
    assert.equal(h.element.textContent, text);
    assert.equal(result.typing, perCharacter ? "keys" : "insertText");
    const deletion = h.calls.findIndex((c) => c.method === "Input.dispatchKeyEvent" && c.params.key === "Delete");
    const insertion = h.calls.findIndex((c) => c.method === "Input.insertText" || (c.method === "Input.dispatchKeyEvent" && c.params.text));
    assert.ok(deletion >= 0 && deletion < insertion);
    assert.equal(h.commands("domFillFallback").length, 0);
  });
}

test("fill refuses to select an unrelated focused editor", async () => {
  const h = harness({ initial: "keep this" });
  h.page.document.activeElement = { isContentEditable: true, contains: () => false };
  await assert.rejects(h.call("fill", { selector: "#target", text: "replace", domFallback: false }), /requested contenteditable is not focused/);
  assert.equal(h.selected.length, 0);
  assert.equal(h.commands("Input.dispatchKeyEvent").length, 0, "no Delete in the wrong editor");
  assert.equal(h.element.textContent, "keep this");
});

test("focused-editor inspection failures do not silently switch to keystrokes", async () => {
  const h = harness();
  h.chrome.scripting.executeScript = async () => { throw new Error("inspection denied"); };
  await assert.rejects(h.call("type", { text: "hello" }), /inspection denied/);
  assert.equal(h.commands("Input.insertText").length, 0);
  assert.equal(h.commands("Input.dispatchKeyEvent").length, 0);
});

test("perCharacter preserves keydown-dependent editors; ordinary inputs/textareas retain key events", async () => {
  for (const options of [{}, { tag: "INPUT", editable: false }, { tag: "TEXTAREA", editable: false }, { tag: "DIV", editable: false }]) {
    const h = harness(options);
    await h.call("type", { text: "Aa.!", ...(options.tag ? {} : { perCharacter: true }) });
    assert.equal(h.commands("Input.insertText").length, 0);
    assert.equal(h.element.textContent, "Aa.!");
    assert.deepEqual(h.commands("Input.dispatchKeyEvent").filter((c) => c.params.text).map((c) => c.params.text), ["A", "a", ".", "!"]);
  }
});

test("empty typing is a no-op; empty fill still deletes the entire editor", async () => {
  const h = harness({ initial: "first\nsecond" });
  await h.call("type", { text: "" });
  assert.equal(h.element.textContent, "first\nsecond");
  assert.equal(h.commands("Input.insertText").length, 0);
  assert.equal(h.commands("Input.dispatchKeyEvent").length, 0);
  await h.call("fill", { selector: "#target", text: "", domFallback: false });
  assert.equal(h.element.textContent, "");
  assert.equal(h.commands("Input.insertText").length, 0);
});

test("insertText failures propagate without silently retrying keystrokes; fill honors domFallback:false", async () => {
  for (const action of ["type", "fill"]) {
    const h = harness();
    h.failures.set("Input.insertText", "insertion failed");
    await assert.rejects(h.call(action, { selector: "#target", text: "hello", domFallback: false }), /insertion failed/);
    assert.equal(h.commands("Input.insertText").length, 1);
    assert.equal(h.commands("Input.dispatchKeyEvent").filter((c) => c.params.text).length, 0);
    assert.equal(h.commands("domFillFallback").length, 0);
  }
  const h = harness();
  h.failures.set("Input.insertText", "insertion failed");
  const result = await h.call("fill", { selector: "#target", text: "hello" });
  assert.equal(result.input, "dom-fallback", "existing opt-out fallback remains available");
});

test("stale typing/fill UIDs never insert text or delete the old selection", async () => {
  for (const action of ["type", "fill"]) {
    const h = harness();
    h.element.isConnected = false;
    await assert.rejects(h.call(action, { uid: "el-1", text: "hello", domFallback: false }), /snapshot uid el-1 is stale/);
    assert.equal(h.commands("Input.insertText").length, 0);
    assert.equal(h.commands("Input.dispatchKeyEvent").length, 0);
  }
});

for (const [key, text, code, vk] of [
  ["a", "A", "KeyA", 65], ["A", "A", "KeyA", 65], ["1", "!", "Digit1", 49],
  ["!", "!", "Digit1", 49], ["2", "@", "Digit2", 50], [".", ">", "Period", 190],
  ["/", "?", "Slash", 191], [" ", " ", "Space", 32],
]) {
  test(`Shift+${key} emits ${text} with the correct physical key and text`, async () => {
    const h = harness({ tag: "INPUT", editable: false });
    const result = await h.call("key", { key, modifiers: { shiftKey: true } });
    const events = h.commands("Input.dispatchKeyEvent").map((c) => c.params);
    assert.deepEqual(events.map((e) => [e.type, e.key]), [["keyDown", "Shift"], ["keyDown", text], ["keyUp", text], ["keyUp", "Shift"]]);
    assert.equal(events[1].text, text);
    assert.equal(events[1].unmodifiedText, text);
    assert.equal(events[1].code, code);
    assert.equal(events[1].windowsVirtualKeyCode, vk);
    assert.equal(events[1].modifiers, 8);
    assert.equal(events.at(-1).modifiers, 0);
    assert.equal(h.element.textContent, text);
    assert.equal(result.key, text);
  });
}

test("every US shifted digit/punctuation maps without changing its physical code", () => {
  const { worker } = harness();
  const unshifted = "`1234567890-=[]\\;',./";
  const shifted = '~!@#$%^&*()_+{}|:"<>?';
  assert.equal(unshifted.length, shifted.length);
  for (let i = 0; i < unshifted.length; i++) {
    const base = worker.cdpKeyInfo(unshifted[i]);
    const shift = worker.cdpKeyInfo(unshifted[i], true);
    assert.equal(shift.text, shifted[i]);
    assert.equal(shift.code, base.code);
    assert.equal(shift.windowsVirtualKeyCode, base.windowsVirtualKeyCode);
  }
});

test("Ctrl/Meta/Alt shortcuts never insert their literal character, even with Shift", async () => {
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    for (const shiftKey of [false, true]) {
      const h = harness();
      await h.call("key", { key: "a", modifiers: { [modifier]: true, shiftKey } });
      const down = h.commands("Input.dispatchKeyEvent").find((c) => c.params.code === "KeyA").params;
      assert.equal(down.type, "rawKeyDown");
      assert.equal(down.text, "");
      assert.equal(down.unmodifiedText, "");
      assert.equal(h.element.textContent, "");
    }
  }
});

test("named keys keep codes and Shift+Enter carries newline text", async () => {
  for (const [key, code, text] of [["ArrowLeft", "ArrowLeft", ""], ["Tab", "Tab", "\t"], ["Enter", "Enter", "\r"], ["Escape", "Escape", ""]]) {
    const h = harness();
    await h.call("key", { key, modifiers: { shiftKey: true } });
    const down = h.commands("Input.dispatchKeyEvent").find((c) => c.params.key === key).params;
    assert.equal(down.code, code);
    assert.equal(down.text, text);
  }
});

test("challenge 21 waits for releases, accepts a complete trusted chord, and rejects missing text/synthetic input", () => {
  const html = fs.readFileSync(new URL("../challenges/21-keyboard-modifiers.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const mode of ["trusted", "synthetic", "missing-text"]) {
    const listeners = new Map();
    const field = { value: "", addEventListener: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]) };
    let verdict = "PENDING";
    const page = {
      document: { getElementById: () => field },
      Challenge: { init() {}, log() {}, pass: () => { verdict = "PASS"; }, fail: () => { verdict = "FAIL"; } },
    };
    vm.runInNewContext(script, page);
    function fire(name, key, code, timeStamp) {
      const event = { key, code, timeStamp, isTrusted: mode !== "synthetic", shiftKey: true, getModifierState: () => true };
      for (const fn of listeners.get(name) ?? []) fn(event);
    }
    fire("keydown", "Shift", "ShiftLeft", 1);
    fire("keydown", "A", "KeyA", 2);
    if (mode !== "missing-text") field.value = "A";
    fire("input", undefined, undefined, 3);
    assert.equal(verdict, "PENDING", "input precedes release events");
    fire("keyup", "A", "KeyA", 4);
    assert.equal(verdict, "PENDING");
    fire("keyup", "Shift", "ShiftLeft", 5);
    assert.equal(verdict, mode === "trusted" ? "PASS" : "FAIL");
  }
});

test("challenge 44 grader accepts native input evidence and rejects broken or synthetic results", async () => {
  const html = fs.readFileSync(new URL("../challenges/44-input-reliability.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const mode of ["good", "wrong-text", "old-paragraphs", "synthetic", "per-character-auto", "missing-keys", "double-enter", "bad-shift", "wrong-file", "html"]) {
    const nodes = new Map();
    function node(id) {
      if (!nodes.has(id)) nodes.set(id, {
        innerText: "", value: "", files: [], listeners: new Map(),
        querySelector: () => mode === "html" && id === "typed" ? {} : null,
        addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); },
      });
      return nodes.get(id);
    }
    let verdict = "PENDING";
    const page = {
      document: { getElementById: node },
      Challenge: { init() {}, log() {}, pass: () => { verdict = "PASS"; }, fail: () => { verdict = "FAIL"; } },
    };
    page.window = page;
    vm.runInNewContext(script, page);
    async function fire(id, name, props = {}) {
      const event = { isTrusted: mode !== "synthetic", preventDefault() {}, ...props };
      for (const fn of node(id).listeners.get(name) ?? []) await fn(event);
    }
    for (const id of ["typed", "filled"]) {
      node(id).innerText = page.__inputFixture.caption;
      await fire(id, "beforeinput");
      await fire(id, "input");
    }
    if (mode === "wrong-text") node("typed").innerText = "wrong";
    if (mode === "old-paragraphs") node("filled").innerText += "OLD paragraph";
    if (mode === "per-character-auto") await fire("typed", "keydown", { key: "a" });
    node("keys").innerText = "Ab!";
    if (mode !== "missing-keys") for (const key of "Ab!") {
      await fire("keys", "keydown", { key });
      await fire("keys", "input");
    }
    node("shift").value = "A!?";
    for (const [key, code] of [["A", "KeyA"], ["!", "Digit1"], ["?", "Slash"]]) {
      await fire("shift", "keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true });
      await fire("shift", "keydown", { key, code, shiftKey: mode !== "bad-shift" });
      await fire("shift", "keyup", { key, code, shiftKey: true });
      await fire("shift", "keyup", { key: "Shift", code: "ShiftLeft", shiftKey: false });
    }
    node("once").value = "done";
    await fire("onceForm", "submit");
    if (mode === "double-enter") await fire("onceForm", "submit");
    node("file").files = [{ name: "pi-chrome-upload.txt", text: async () => mode === "wrong-file" ? "wrong" : "pi-chrome upload fixture\n" }];
    await fire("file", "change");
    await fire("verify", "click");
    assert.equal(verdict, mode === "good" ? "PASS" : "FAIL", mode);
  }
});

test("pressEnter/submit emit one Enter after text and stay pinned to the resolved tab", async () => {
  for (const action of ["type", "fill"]) {
    for (const editable of [true, false]) {
      const h = harness({ editable });
      await h.call(action, { targetId: undefined, urlIncludes: "fixture.test", selector: "#target", text: "ok", pressEnter: true, submit: true, domFallback: false });
      const enters = h.commands("Input.dispatchKeyEvent").filter((c) => c.params.type !== "keyUp" && (c.params.key === "Enter" || c.params.text === "\r"));
      assert.equal(enters.length, 1);
      assert.equal(enters[0].params.key, "Enter");
      assert.equal(h.element.textContent, "ok\r");
      assert.equal(String(h.tabLookups.at(-1).targetId), "2", "Enter must not resolve a different URL/title match");
    }
  }
});

// ---- chrome_type value read-back (measured live: "why do flamingos why do cats knead blanketsstand
// on one leg" was typed mid-string and the tool text only said "Typed 26 character(s) into #q.").
// A mid-string splice must be visible in the result, and credential fields must stay redacted.

test("chrome_type reports valueBefore/valueAfter and flags a caret-middle splice", async () => {
  const h = harness({ tag: "INPUT", editable: false });
  const original = "why do flamingos stand on one leg";
  const typed = "why do cats knead blankets";
  h.element.value = original;
  h.element.selectionStart = 16;
  h.element.selectionEnd = 16;
  const baseCdp = h.worker.cdp;
  h.worker.cdp = async (tabId, method, params = {}) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && params.text) {
      // Insert at the caret like the live browser did, leaving the caret after the inserted text.
      const caret = h.element.selectionStart ?? h.element.value.length;
      h.element.value = h.element.value.slice(0, caret) + params.text + h.element.value.slice(caret);
      h.element.selectionStart = h.element.selectionEnd = caret + params.text.length;
      return {};
    }
    return baseCdp(tabId, method, params);
  };
  const result = await h.call("type", { selector: "#target", text: typed, perCharacter: true });
  assert.equal(result.typing, "keys");
  assert.equal(result.valueBefore, original);
  assert.equal(result.valueAfter, `${original.slice(0, 16)}${typed}${original.slice(16)}`);
  assert.equal(result.existingTextLengthBefore, original.length);
  assert.equal(result.insertedAt, "caret-middle");
  assert.equal(result.valueRedacted, undefined);
});

test("chrome_type reports caret-end for an append and replaces the classification under replace:true", async () => {
  const h = harness();
  h.element.textContent = "hello";
  const appended = await h.call("type", { selector: "#target", text: " world" });
  assert.equal(appended.valueBefore, "hello");
  assert.equal(appended.valueAfter, "hello world");
  assert.equal(appended.insertedAt, "caret-end");

  const h2 = harness();
  h2.element.textContent = "hello";
  const baseCdp = h2.worker.cdp;
  h2.worker.cdp = async (tabId, method, params = {}) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && params.key === "Delete") {
      h2.element.textContent = "";
      return {};
    }
    return baseCdp(tabId, method, params);
  };
  const replaced = await h2.call("type", { selector: "#target", text: "fresh", replace: true });
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.valueBefore, "hello", "the before read must run before replace deletes");
  assert.equal(replaced.insertedAt, "replaced-selection");
  assert.equal(replaced.valueAfter, "fresh");
  assert.deepEqual(
    h2.commands("Input.dispatchKeyEvent").filter((c) => c.params.code === "KeyA" && c.params.type !== "keyUp").map((c) => c.params.type),
    ["rawKeyDown"],
    "replace uses a real Ctrl+A chord, not a DOM selection",
  );
});

test("chrome_type redacts password and credential field values", async () => {
  for (const [type, name] of [["password", "password"], ["text", "api_key"]]) {
    const h = harness({ tag: "INPUT", editable: false });
    h.element.type = type;
    h.element.name = name;
    h.element.value = "hunter2";
    h.element.selectionStart = 0;
    h.element.selectionEnd = 0;
    const result = await h.call("type", { selector: "#target", text: "x", perCharacter: true });
    assert.equal(result.valueRedacted, true, `${type}/${name}`);
    assert.equal(result.valueBefore, undefined, `${type}/${name} before value must not leak`);
    assert.equal(result.valueAfter, undefined, `${type}/${name} after value must not leak`);
    assert.equal(result.existingTextLengthBefore, 7);
    assert.equal(result.insertedAt, "caret-middle");
  }
});

test("replace:true reports the pre-delete length for a password field", async () => {
  const h = harness({ tag: "INPUT", editable: false });
  h.element.type = "password";
  h.element.value = "hunter2";
  h.element.selectionStart = 0;
  h.element.selectionEnd = 0;
  const baseCdp = h.worker.cdp;
  h.worker.cdp = async (tabId, method, params = {}) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && params.key === "Delete") {
      h.element.value = "";
      h.element.selectionStart = h.element.selectionEnd = 0;
      return {};
    }
    return baseCdp(tabId, method, params);
  };
  const result = await h.call("type", { selector: "#target", text: "fresh", replace: true, perCharacter: true });
  assert.equal(result.replaced, true);
  assert.equal(result.valueRedacted, true);
  assert.equal(result.valueBefore, undefined, "the password value never leaks");
  assert.equal(result.valueAfter, undefined, "the password value never leaks");
  assert.equal(result.existingTextLengthBefore, 7, "the before read must run before replace deletes");
  assert.equal(result.insertedAt, "replaced-selection");
});

test("chrome_type omits the value report when the focus target carries no value", async () => {
  // A snapshot uid can point at a div[role=textbox][tabindex] wrapper; the typed text is real but
  // the wrapper has no value, so evidence must stay silent instead of reporting "" -> "".
  const h = harness({ tag: "DIV", editable: false });
  const result = await h.call("type", { selector: "#target", text: "hello", perCharacter: true });
  assert.equal(result.typing, "keys");
  assert.equal(result.length, 5);
  assert.equal(result.valueBefore, undefined);
  assert.equal(result.valueAfter, undefined);
  assert.equal(result.existingTextLengthBefore, undefined);
  assert.equal(result.insertedAt, undefined);
  assert.equal(result.valueRedacted, undefined);
  assert.equal(h.element.textContent, "hello", "the text still reached the page");
});

test("readInputStateInTab reads the focused carrier when the uid points at a non-carrier wrapper", async () => {
  const h = harness({ tag: "INPUT", editable: false });
  const wrapper = { tagName: "DIV", isContentEditable: false, isConnected: true };
  h.page.__PI_CHROME_STATE__.elements["el-wrap"] = wrapper;
  h.page.document.activeElement = h.element;
  h.element.value = "seed";
  h.element.selectionStart = 4;
  h.element.selectionEnd = 4;
  const state = await h.worker.readInputStateInTab(2, { uid: "el-wrap" });
  assert.equal(state.carrier, "value");
  assert.equal(state.value, "seed");
  assert.equal(state.valueLength, 4);
  assert.equal(state.selectionStart, 4);
});

test("chrome_type flags a mid-string contenteditable splice past the 120-char truncation", async () => {
  const original = "A".repeat(150) + "B".repeat(150);
  const h = harness({ caretOffset: 150 });
  h.element.textContent = original;
  const baseCdp = h.worker.cdp;
  h.worker.cdp = async (tabId, method, params = {}) => {
    if (method === "Input.insertText") {
      const caret = h.selection.anchorOffset;
      h.element.textContent = h.element.textContent.slice(0, caret) + params.text + h.element.textContent.slice(caret);
      h.selection.anchorOffset = caret + params.text.length;
      return {};
    }
    return baseCdp(tabId, method, params);
  };
  const result = await h.call("type", { selector: "#target", text: "ZYX" });
  assert.equal(result.typing, "insertText");
  assert.equal(result.valueBefore, "A".repeat(120), "the before value is truncated like snapshots");
  assert.equal(result.valueAfter, "A".repeat(120), "the truncated before/after look identical");
  assert.equal(result.existingTextLengthBefore, 300);
  assert.equal(result.insertedAt, "caret-middle", "the measured caret exposes a splice past 120 chars");
});

// ---- withOptionalSnapshot must never observe a document that predates its own navigation.

test("withOptionalSnapshot does not wait when the action did not navigate", async () => {
  const h = harness();
  h.worker.snapshotInTab = async () => ({ title: "Fixture", url: h.tabState.url });
  const waits = [];
  h.worker.waitForTabComplete = async (tabId, timeoutMs) => { waits.push({ tabId, timeoutMs }); return true; };
  const payload = await h.call("type", { selector: "#target", text: "hello", includeSnapshot: true });
  assert.deepEqual(waits, [], "a non-navigating action must not call the load wait");
  assert.equal(payload.navigation, undefined);
  assert.equal(payload.snapshot.url, "https://fixture.test/");
  assert.equal(payload.snapshot.title, "Fixture");
});

test("withOptionalSnapshot does not wait when the tab was already loading before a non-navigating action", async () => {
  const h = harness();
  h.tabState.status = "loading";
  h.worker.snapshotInTab = async () => ({ title: "Fixture", url: h.tabState.url });
  const waits = [];
  h.worker.waitForTabComplete = async (tabId, timeoutMs) => { waits.push({ tabId, timeoutMs }); return true; };
  const payload = await h.call("type", { selector: "#target", text: "hello", includeSnapshot: true });
  assert.deepEqual(waits, [], "an already-loading tab must not add a bounded wait to every includeSnapshot action");
  assert.equal(payload.navigation.from, "https://fixture.test/");
  assert.equal(payload.navigation.to, "https://fixture.test/");
  assert.equal(payload.navigation.settled, false, "the snapshot is still flagged as possibly mid-load");
  assert.ok(payload.navigation.waitedMs >= 0);
  assert.equal(payload.snapshot.title, "Fixture");
});

test("waitForTabComplete removes its onUpdated listener on resolve and on timeout", async () => {
  const h = harness();
  const resolved = h.worker.waitForTabComplete(2, 250);
  assert.equal(h.tabUpdated.listeners.size, 1, "listener attached");
  for (const fn of [...h.tabUpdated.listeners]) fn(2, { status: "complete" });
  await resolved;
  assert.equal(h.tabUpdated.listeners.size, 0, "listener removed after resolve");

  const timedOut = h.worker.waitForTabComplete(2, 10);
  assert.equal(h.tabUpdated.listeners.size, 1, "listener attached for the timeout wait");
  await assert.rejects(timedOut, /Timed out after 10ms waiting for tab 2 to load/);
  assert.equal(h.tabUpdated.listeners.size, 0, "listener removed after timeout");
});

test("withOptionalSnapshot settles through the real onUpdated wait, not only a stub", async () => {
  const h = harness();
  h.worker.snapshotInTab = async () => ({ title: "Result page", url: h.tabState.url });
  const baseCdp = h.worker.cdp;
  h.worker.cdp = async (tabId, method, params = {}) => {
    const value = await baseCdp(tabId, method, params);
    if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && params.key === "Enter") {
      h.tabState.url = "https://fixture.test/results";
      h.tabState.status = "loading";
    }
    return value;
  };
  // Complete the real tab load as soon as the real wait attaches its onUpdated listener.
  const completion = setInterval(() => {
    for (const fn of [...h.tabUpdated.listeners]) fn(2, { status: "complete" });
  }, 1);
  try {
    const payload = await h.call("type", { selector: "#target", text: "x", pressEnter: true, includeSnapshot: true });
    assert.equal(payload.navigation.settled, true, "the real wait resolved on the onUpdated event");
    assert.equal(payload.navigation.to, "https://fixture.test/results");
  } finally {
    clearInterval(completion);
  }
  assert.equal(h.tabUpdated.listeners.size, 0, "the real wait removed its listener");
});

for (const [settled, outcome] of [[true, "resolves"], [false, "times out"]]) {
  test(`withOptionalSnapshot waits out a navigation and reports settled=${settled} when the wait ${outcome}`, async () => {
    const h = harness();
    h.worker.snapshotInTab = async () => ({ title: "Result page", url: h.tabState.url });
    const waits = [];
    h.worker.waitForTabComplete = async (tabId, timeoutMs) => {
      waits.push({ tabId, timeoutMs });
      if (!settled) throw new Error(`Timed out after ${timeoutMs}ms waiting for tab ${tabId} to load`);
      h.tabState.status = "complete";
      h.tabState.title = "Result page";
      return true;
    };
    const baseCdp = h.worker.cdp;
    h.worker.cdp = async (tabId, method, params = {}) => {
      const value = await baseCdp(tabId, method, params);
      if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && params.key === "Enter") {
        h.tabState.url = "https://fixture.test/results?q=mice";
        h.tabState.status = "loading";
      }
      return value;
    };
    const payload = await h.call("type", { selector: "#target", text: "mice", pressEnter: true, includeSnapshot: true, timeoutMs: 900 });
    assert.deepEqual(waits, [{ tabId: 2, timeoutMs: 900 }], "the bounded wait uses min(params.timeoutMs, 5000)");
    assert.equal(payload.navigation.from, "https://fixture.test/");
    assert.equal(payload.navigation.to, "https://fixture.test/results?q=mice");
    assert.equal(payload.navigation.settled, settled);
    assert.ok(payload.navigation.waitedMs >= 0);
    assert.equal(payload.snapshot.title, "Result page", "the snapshot still returns even when the wait timed out");
  });
}

test("withOptionalSnapshot caps the navigation wait at 5000ms", async () => {
  const h = harness();
  h.worker.snapshotInTab = async () => ({ title: "Result page", url: h.tabState.url });
  const waits = [];
  h.worker.waitForTabComplete = async (tabId, timeoutMs) => { waits.push(timeoutMs); return true; };
  const baseCdp = h.worker.cdp;
  h.worker.cdp = async (tabId, method, params = {}) => {
    const value = await baseCdp(tabId, method, params);
    if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && params.key === "Enter") {
      h.tabState.url = "https://fixture.test/results";
      h.tabState.status = "loading";
    }
    return value;
  };
  await h.call("type", { selector: "#target", text: "x", pressEnter: true, includeSnapshot: true, timeoutMs: 60_000 });
  assert.deepEqual(waits, [5_000]);
});
