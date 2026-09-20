// Unit harness for the automation-tab contract in service_worker.js.
//
// The contract (the user's decision, verbatim): "remove automatic. just let me choose but need one
// default." The user picks a window once with /chrome window; that choice is saved machine-wide in
// ~/.pi/agent/pi-chrome.json as `preferredWindow` and every session with no assignment of its own
// inherits it. When neither a per-session assignment nor a usable saved default exists, pi-chrome
// REFUSES with a message naming /chrome window: it never creates a window, never falls back to the
// focused window, and never puts a tab in a window the user did not choose.
//
// Like csp-eval.test.mjs this loads the *real* worker into a vm sandbox with a stateful chrome.*
// mock, then exercises the real helpers and the real dispatch() paths. The mock models the observed
// Edge shape rather than an idealised Chrome one: `chrome.windows.create` answers with a Window whose
// `tabs` entries OMIT `windowId` (live 0.15.51.13 finding), `chrome.tabs.create` without a windowId
// lands in the focused window (the user's) exactly like the browser does, `chrome.debugger.attach`
// refuses about:blank#pi-chrome exactly like live Edge (2026-09-20 finding), and
// `chrome.scripting.executeScript` refuses about:blank itself exactly like live Edge (2026-09-20
// finding) so snapshot/inspect/probe must go through production's scripting->debugger fallback.
// Scripting and Runtime.evaluate share ONE per-tab page realm, and Runtime.evaluate runs the real
// expression there, so an assertion like `evaluated === 2` proves the expression ran, not merely
// that a hardcoded mock path was reached. A mock that idealised any of these is what let a broken
// fix look green before.

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const src = fs.readFileSync(workerPath, "utf8");

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error(`  ✗ ${msg}`); }
}
async function throwsWith(fn, re, msg) {
  try { await fn(); ok(false, `${msg} (expected throw)`); }
  catch (e) { ok(re.test(String(e.message || e)), `${msg} (got: ${e.message})`); }
}

// ---- minimal MAIN-world page sandbox for the mock ------------------------------------------------
// chrome.scripting and debugger Runtime.evaluate both run code in the page's MAIN world, so the mock
// keeps ONE realm per tab: a global set by a scripting func is visible to a later CDP evaluate, like
// the browser. The DOM is a stub intentionally limited to what the injected production helpers touch
// on an empty page (probePage, listConsoleMessages/listNetworkRequests, and the real
// snapshot_injected.js); running the real snapshot file here is what makes the scripting-denied
// fallback test honest instead of asserting a hardcoded value.
const snapshotSource = fs.readFileSync(path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/snapshot_injected.js"), "utf8");
const PACKAGED_FILES = { "snapshot_injected.js": snapshotSource };

function stubElement(tag = "div") {
  const uppercase = String(tag).toUpperCase();
  return {
    tagName: uppercase, nodeName: uppercase, id: "", className: "", textContent: "", innerText: "", value: "",
    children: [], childNodes: [], style: {}, isConnected: true, isContentEditable: false, disabled: false,
    parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    querySelectorAll: () => [], querySelector: () => null, closest: () => null, contains: () => false,
    getAttribute: () => null, hasAttribute: () => false, focus: () => {}, scrollIntoView: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  };
}

function pageContextFor(state, tabId) {
  const existing = state.pageContexts.get(tabId);
  if (existing) return existing;
  const body = stubElement("body");
  const documentElement = stubElement("html");
  documentElement.scrollWidth = 0; documentElement.scrollHeight = 0; documentElement.clientWidth = 800; documentElement.clientHeight = 600;
  const document = {
    title: "", readyState: "complete", body, documentElement, activeElement: body,
    querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    elementFromPoint: () => null, createElement: (tag) => stubElement(tag),
    addEventListener: () => {}, removeEventListener: () => {}, scripts: [],
  };
  function XHRStub() {}
  XHRStub.prototype = { open: () => {}, send: () => {}, addEventListener: () => {}, removeEventListener: () => {}, getAllResponseHeaders: () => "" };
  const page = {
    console: { debug: (...a) => console.debug(...a), log: (...a) => console.log(...a), info: (...a) => console.info(...a), warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) },
    JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, Error, TypeError, Map, Set, WeakMap, WeakSet, RegExp, Symbol,
    document, location: { href: "", origin: "null" }, navigator: { userAgent: "unit-test", webdriver: false },
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1", position: "static", overflow: "visible", pointerEvents: "auto" }),
    XMLHttpRequest: XHRStub, MutationObserver: function MutationObserver() { this.observe = () => {}; this.disconnect = () => {}; },
    CSS: { escape: (value) => String(value) }, performance: { now: () => Date.now() },
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    setTimeout, clearTimeout, fetch: async () => ({ ok: true, status: 200, text: async () => "" }),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  page.window = page;
  page.self = page;
  page.globalThis = page;
  const wrapped = { context: vm.createContext(page), page };
  state.pageContexts.set(tabId, wrapped);
  return wrapped;
}

function syncPage(ctx, tab) {
  ctx.page.location.href = tab ? String(tab.url || "") : "";
  ctx.page.document.title = tab ? String(tab.title || "") : "";
}

function cdpValue(value) {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "object", subtype: "null", value: null };
  if (typeof value === "object") return { type: "object", value };
  return { type: typeof value, value };
}

function exceptionResult(error) {
  const description = String((error && error.stack) || error);
  return {
    result: { type: "object", subtype: "error", description },
    exceptionDetails: { text: "Uncaught", exception: { className: (error && error.name) || "Error", description, value: (error && error.message) || String(error) } },
  };
}

// ---- stateful Chrome mock. `state` (tabs/windows/storage) can be shared across two sandbox loads
// to simulate a service-worker restart: the browser keeps its tabs/windows/session-storage, the
// worker memory is wiped (a fresh sandbox).
function makeChromeState() {
  const tabs = new Map(); // id -> { id, windowId, url, active, groupId }
  const windows = new Map(); // id -> { id }
  const groups = new Map(); // groupId -> { id, title, color, collapsed, windowId }
  const storage = {}; // chrome.storage.session backing
  let nextTabId = 1;
  let nextWindowId = 1;
  let nextGroupId = 1;
  const alloc = { tab: () => nextTabId++, window: () => nextWindowId++, group: () => nextGroupId++ };
  // Every way a window or an unanchored tab could appear, recorded so the "never creates a window,
  // never uses the focused window" invariant can be asserted directly instead of inferred.
  const events = { windowCreates: [], windowIdLessTabCreates: [], focuses: [], debuggerAttaches: [] };
  // The page realm survives a service-worker restart (the tab keeps its globals), so it lives on
  // `state`, not on the chrome mock.
  const pageContexts = new Map(); // tabId -> { context, page }

  // Seed a user window with two real user tabs (Gmail + a research article, the active one).
  const userWindowId = alloc.window();
  windows.set(userWindowId, { id: userWindowId });
  const userGmail = { id: alloc.tab(), windowId: userWindowId, url: "https://mail.google.com/", active: false, groupId: -1 };
  const userArticle = { id: alloc.tab(), windowId: userWindowId, url: "https://example.com/research-article", active: true, groupId: -1 };
  tabs.set(userGmail.id, userGmail);
  tabs.set(userArticle.id, userArticle);

  return { tabs, windows, groups, storage, alloc, userWindowId, userGmail, userArticle, events, pageContexts };
}

function makeChrome(state, { withWindows = true, withStorage = true, withTabGroups = false } = {}) {
  const { tabs, windows, groups, storage, alloc, userWindowId } = state;
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };

  // Live-measured permission rules (Edge 123, headed, 2026-09-20). The browser really has two
  // different rules, so the mock has two:
  //   - chrome.debugger.attach accepts exactly `about:blank`; every OTHER about:-scheme URL (the
  //     marked legacy target) is refused with the host-permission error. This is the rule the
  //     original fix measured on the debugger path.
  //   - chrome.scripting.executeScript refuses plain about:blank as well (a top-level about:blank
  //     the extension opened has an opaque origin, so <all_urls> does not cover it), plus the
  //     marked URL, data: and the other restricted schemes. Snapshot/inspect/console/network/probe
  //     only work because production falls back to the debugger channel after this refusal; an
  //     idealised mock that let scripting through on about:blank hid that second failure mode.
  const cannotAccessError = (url) =>
    `Cannot access contents of url "${url}". Extension manifest must request permission to access this host.`;
  const originAccessError = (url) =>
    `Cannot access "${url}" at origin "null". Extension must have permission to access the frame's origin, and matchAboutBlank must be true.`;
  const debuggerDeniedUrl = (tab) => {
    const url = tab ? String(tab.url || "") : "";
    return url.startsWith("about:") && url !== "about:blank" && url !== "about:srcdoc" ? url : "";
  };
  const scriptingDeniedUrl = (tab) => {
    const url = tab ? String(tab.url || "") : "";
    return url.startsWith("about:") || url.startsWith("data:") || url.startsWith("view-source:") ||
      url.startsWith("chrome:") || url.startsWith("edge:") || url.startsWith("devtools:") ? url : "";
  };
  // Production addresses the debugger with the page target from pageDebuggeeForTab ({targetId}) and
  // falls back to {tabId}; the mock resolves both so the preferred shape is the one actually used.
  const tabIdOfDebuggee = (debuggee) => {
    if (!debuggee || typeof debuggee !== "object") return null;
    if (typeof debuggee.tabId === "number") return debuggee.tabId;
    const match = typeof debuggee.targetId === "string" ? /^page-target-(\d+)$/.exec(debuggee.targetId) : null;
    return match ? Number(match[1]) : null;
  };
  const attachedTabIds = new Set();
  // Run a MAIN-world expression the way the browser runs it: in the tab's page realm, asynchronously
  // when asked. Errors become a CDP exceptionDetails result, never a sendCommand lastError.
  const evaluateInPage = async (tabId, expression, awaitPromise) => {
    const ctx = pageContextFor(state, tabId);
    syncPage(ctx, tabs.get(tabId));
    let value;
    try {
      value = vm.runInContext(String(expression ?? ""), ctx.context);
    } catch (error) {
      return exceptionResult(error);
    }
    if (awaitPromise && value && typeof value.then === "function") {
      try { value = await value; } catch (error) { return exceptionResult(error); }
    }
    return { result: cdpValue(value) };
  };

  const chrome = {
    runtime: { id: "unittestextension", getURL: (file) => `chrome-extension://unittestextension/${file}`, getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener },
    debugger: {
      sendCommand: (debuggee, method, params, callback) => {
        const tabId = tabIdOfDebuggee(debuggee);
        const denied = debuggerDeniedUrl(tabId === null ? null : tabs.get(tabId));
        if (denied) {
          chrome.runtime.lastError = { message: cannotAccessError(denied) };
          try { callback(undefined); } finally { chrome.runtime.lastError = null; }
          return;
        }
        if (method !== "Runtime.evaluate") { callback({ result: {} }); return; }
        void evaluateInPage(tabId, params && params.expression, params && params.awaitPromise === true).then((result) => callback(result));
      },
      attach: async (debuggee) => {
        const tabId = tabIdOfDebuggee(debuggee);
        const denied = debuggerDeniedUrl(tabId === null ? null : tabs.get(tabId));
        if (denied) throw new Error(cannotAccessError(denied));
        state.events.debuggerAttaches.push({ tabId, targetId: debuggee && debuggee.targetId });
        if (typeof tabId === "number") attachedTabIds.add(tabId);
      },
      detach: async (debuggee) => { const tabId = tabIdOfDebuggee(debuggee); if (tabId !== null) attachedTabIds.delete(tabId); },
      getTargets: (callback) => callback([...tabs.values()].map((tab) => ({
        id: `page-target-${tab.id}`, tabId: tab.id, type: "page", url: tab.url, attached: attachedTabIds.has(tab.id),
      }))),
      onDetach: listener,
    },
    scripting: {
      executeScript: async (options = {}) => {
        const tabId = options && options.target ? options.target.tabId : null;
        const tab = typeof tabId === "number" ? tabs.get(tabId) : null;
        const denied = scriptingDeniedUrl(tab);
        if (denied) {
          // Per-shape messages exactly as measured live: the func form on a fragment about: URL
          // reports the frame-origin rule; the file form and about:blank/data: report the URL rule.
          const message = options.func && denied.startsWith("about:") && denied !== "about:blank"
            ? originAccessError(denied)
            : cannotAccessError(denied);
          throw new Error(message);
        }
        if (Array.isArray(options.files) && options.files.length) {
          for (const file of options.files) {
            const source = PACKAGED_FILES[file];
            if (source === undefined) throw new Error(`No packaged file ${file}`);
            const ctx = pageContextFor(state, tabId);
            syncPage(ctx, tab);
            vm.runInContext(source, ctx.context);
          }
          return [{ result: undefined }];
        }
        // Chrome serialises the func into the page realm; the mock does the same, so a scripting
        // result is real page execution and not a hardcoded value.
        const ctx = pageContextFor(state, tabId);
        syncPage(ctx, tab);
        const serializedArgs = JSON.stringify(Array.isArray(options.args) ? options.args : []);
        let value = vm.runInContext(`(${options.func.toString()})(...${serializedArgs})`, ctx.context);
        if (value && typeof value.then === "function") value = await value;
        return [{ result: value }];
      },
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
    },
    webNavigation: { onCommitted: listener },
    tabs: {
      onUpdated: listener,
      query: async (q = {}) => {
        let list = [...tabs.values()];
        if (q.active === true) list = list.filter((t) => t.active);
        if (typeof q.windowId === "number") list = list.filter((t) => t.windowId === q.windowId);
        return list.map((t) => ({ ...t }));
      },
      get: async (id) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id ${id}`); return { ...t }; },
      create: async (params = {}) => {
        const { url = "about:blank", active = false } = params;
        let windowId = params.windowId;
        // The live failure shape: a tabs.create with no windowId goes to the FOCUSED window, which is
        // the user's. Record it so a test can prove production never relies on it.
        if (typeof windowId !== "number") {
          state.events.windowIdLessTabCreates.push({ ...params });
          windowId = userWindowId;
        }
        // Chrome rejects a tab target whose window is gone; modelling that here makes the
        // chosen-window-closed path fail loudly instead of resurrecting a window id.
        if (!windows.has(windowId)) throw new Error(`No window with id ${windowId}`);
        const tab = { id: alloc.tab(), windowId, url, active, groupId: -1 };
        if (active) for (const t of tabs.values()) if (t.windowId === windowId) t.active = false;
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      update: async (id, props = {}) => {
        if (props.active) state.events.focuses.push({ tabId: id });
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id ${id}`);
        Object.assign(t, props);
        return { ...t };
      },
      remove: async (id) => {
        const tab = tabs.get(id);
        tabs.delete(id);
        // Chrome closes a window automatically when its final tab is removed.
        if (tab && ![...tabs.values()].some((other) => other.windowId === tab.windowId)) windows.delete(tab.windowId);
      },
      group: async ({ groupId, tabIds = [] } = {}) => {
        let gid = groupId;
        if (typeof gid !== "number") {
          gid = alloc.group();
          const firstTab = tabs.get(tabIds[0]);
          groups.set(gid, { id: gid, title: "", color: "grey", collapsed: false, windowId: firstTab ? firstTab.windowId : userWindowId });
        }
        const group = groups.get(gid);
        for (const tid of tabIds) {
          const t = tabs.get(tid);
          if (!t) continue;
          t.groupId = gid;
          // Chrome MOVES a tab into the group's window when it is grouped with a group that lives in
          // another window. Modelling that here makes an unscoped group lookup fail loudly in the
          // tests instead of silently passing while real Chrome relocates the tab.
          if (group && typeof group.windowId === "number") t.windowId = group.windowId;
        }
        return gid;
      },
      ungroup: async (id) => { const ids = Array.isArray(id) ? id : [id]; for (const tid of ids) { const t = tabs.get(tid); if (t) t.groupId = -1; } },
    },
    storage: withStorage ? {
      session: {
        get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (obj) => { Object.assign(storage, obj); },
      },
    } : undefined,
  };

  if (withTabGroups) {
    chrome.tabGroups = {
      query: async ({ windowId } = {}) => [...groups.values()].filter((g) => windowId === undefined || g.windowId === windowId).map((g) => ({ ...g })),
      get: async (id) => { const g = groups.get(id); if (!g) throw new Error(`No group ${id}`); return { ...g }; },
      update: async (id, props = {}) => { const g = groups.get(id); if (!g) throw new Error(`No group ${id}`); Object.assign(g, props); return { ...g }; },
    };
  }

  if (withWindows) {
    chrome.windows = {
      create: async ({ url = "about:blank", focused = false } = {}) => {
        state.events.windowCreates.push({ url, focused });
        const id = alloc.window();
        windows.set(id, { id });
        const tab = { id: alloc.tab(), windowId: id, url, active: true, groupId: -1 };
        tabs.set(tab.id, tab);
        // Real Edge answered windows.create with a Window whose tab entry OMITTED windowId (live
        // 0.15.51.13). Keep the mock in that shape: the tab exists in the browser with its window,
        // the returned object does not carry it. Never "fix" this to be convenient.
        const { windowId, ...returnedTab } = tab;
        return { id, focused, tabs: [returnedTab] };
      },
      get: async (id) => { const w = windows.get(id); if (!w) throw new Error(`No window with id ${id}`); return { ...w }; },
      remove: async (id) => { windows.delete(id); for (const [tid, t] of [...tabs]) if (t.windowId === id) tabs.delete(tid); },
      update: async (id, props = {}) => { if (props.focused) state.events.focuses.push({ windowId: id }); },
      getAll: async () => [...windows.values()].map((w) => ({
        ...w,
        tabs: [...tabs.values()].filter((t) => t.windowId === w.id).map((t) => ({ ...t })),
      })),
    };
  } else {
    chrome.windows = { update: async () => {} }; // no create/get/remove -> creation is impossible
  }

  return chrome;
}

function loadWorker(chrome) {
  const noop = () => {};
  const sandbox = {
    console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    fetch: async (url) => {
      const key = String(url).replace(/^chrome-extension:\/\/unittestextension\//, "");
      if (key in PACKAGED_FILES) {
        const text = PACKAGED_FILES[key];
        return { ok: true, status: 200, text: async () => text, clone: () => ({ text: async () => text }) };
      }
      throw new Error("no network in unit test");
    },
    navigator: { userAgent: "unit-test" },
    WebSocket: function () {},
    chrome,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

const SK = "session:alpha"; // a representative sessionKey

// Convenience: a page action for a session that inherits `windowId` as its saved machine-wide default.
function navWith(w, url, sessionKey, preferredWindow, extra = {}) {
  return w.dispatch("page.navigate", { url, waitUntilLoad: false, sessionKey, preferredWindow, ...extra });
}

function assertNoCreation(state, label) {
  ok(state.events.windowCreates.length === 0, `${label}: chrome.windows.create was never called`);
  ok(state.events.windowIdLessTabCreates.length === 0, `${label}: no tab was created without an explicit window`);
}

async function run() {
  // ===== Inheritance: a session with no assignment works in the saved default and creates nothing.
  // The whole point of the job: pick once, and a brand-new session is not asked again. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const windowsBefore = state.windows.size;
    const userTabsBefore = [...state.tabs.values()].filter((t) => t.windowId === state.userWindowId).map((t) => t.id).sort();

    const nav = await navWith(w, "https://pi.test/inherit", SK, state.userWindowId);
    ok(nav.windowId === state.userWindowId, "inherit: the guest tab landed in the saved default window");
    ok(nav.id !== state.userGmail.id && nav.id !== state.userArticle.id, "inherit: it did not reuse a user tab");
    ok(state.userArticle.url === "https://example.com/research-article", "inherit: the user's active tab is untouched");
    ok(state.userGmail.url === "https://mail.google.com/", "inherit: the user's other tab is untouched");
    ok(state.tabs.get(nav.id).active === false, "inherit: the guest tab was created inactive");
    ok(state.windows.size === windowsBefore, "inherit: no window was created");
    assertNoCreation(state, "inherit");
    ok(state.events.focuses.length === 0, "inherit: nothing was focused or activated");

    const status = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status.tabId === nav.id && status.windowId === state.userWindowId, "inherit: the assignment is recorded for the session");

    // Reuse: a later action stays in the same place instead of churning a tab.
    const nav2 = await navWith(w, "https://pi.test/inherit-2", SK, state.userWindowId);
    ok(nav2.id === nav.id && nav2.windowId === state.userWindowId, "inherit: a later action reuses the guest tab");

    const userTabsAfter = [...state.tabs.values()].filter((t) => t.windowId === state.userWindowId).map((t) => t.id).sort();
    ok(userTabsAfter.join(",") === [...userTabsBefore, nav.id].sort().join(","), "inherit: the chosen window gained exactly Pi's one guest tab");
  }

  // ===== No default and no assignment: every implicit path refuses, naming /chrome window, and
  // creates nothing. This is the fail-safe the feature exists for. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const tabsBefore = state.tabs.size;
    const windowsBefore = state.windows.size;

    await throwsWith(
      () => w.createAutomationTarget(SK),
      /\/chrome window/,
      "no-default: createAutomationTarget refuses instead of picking a window",
    );
    await throwsWith(
      () => w.getOrCreateAutomationTarget(SK),
      /\/chrome window/,
      "no-default: getOrCreateAutomationTarget refuses",
    );
    await throwsWith(
      () => navWith(w, "https://pi.test/no-default", SK, undefined),
      /\/chrome window/,
      "no-default: the first page.* action refuses",
    );
    await throwsWith(
      () => w.dispatch("tab.new", { url: "https://pi.test/no-default", sessionKey: SK }),
      /\/chrome window/,
      "no-default: tab.new refuses",
    );
    await throwsWith(
      () => w.dispatch("cdp.call", { method: "Runtime.evaluate", sessionKey: SK }),
      /\/chrome window/,
      "no-default: cdp.call refuses before attaching to anything",
    );

    ok(state.tabs.size === tabsBefore, "no-default: no tab was created anywhere");
    ok(state.windows.size === windowsBefore, "no-default: no window was created");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "no-default: user tabs are untouched");
    ok(state.tabs.get(state.userArticle.id).active === true, "no-default: the user's active tab never moved");
    assertNoCreation(state, "no-default");
  }

  // ===== A malformed or non-integer default is never coerced into a window. The wire form is JSON;
  // a string id that happens to be numeric is still not a choice the user made. =====
  for (const bad of ["1", 1.5, true, {}]) {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    await throwsWith(
      () => navWith(w, "https://pi.test/bad-default", SK, bad),
      /\/chrome window/,
      `bad-default (${JSON.stringify(bad)}): refused instead of coerced`,
    );
    assertNoCreation(state, `bad-default (${JSON.stringify(bad)})`);
    ok(state.tabs.size === 2, `bad-default (${JSON.stringify(bad)}): no tab was created`);
  }

  // ===== A saved default whose window no longer exists fails with the same actionable message; it
  // must not silently pick the focused window or another existing one. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const goneWindowId = state.alloc.window(); // allocated but never inserted: the user closed it
    await throwsWith(
      () => navWith(w, "https://pi.test/stale-default", SK, goneWindowId),
      /\/chrome window/,
      "stale-default: refuses and names the fix",
    );
    assertNoCreation(state, "stale-default");
    ok(state.tabs.size === 2, "stale-default: no tab was created");
    ok(state.userArticle.url === "https://example.com/research-article", "stale-default: the focused/user window was not used");
  }

  // ===== "A window of Pi's own" is gone: windowId:null refuses, creates nothing, touches nothing. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    await throwsWith(
      () => w.dispatch("window.select", { windowId: null, sessionKey: SK }),
      /\/chrome window|no longer creates a window/,
      "own-window: windowId:null refuses instead of creating a window",
    );
    assertNoCreation(state, "own-window");
    ok(state.tabs.size === 2 && state.windows.size === 1, "own-window: no tab or window was created");
  }

  // ===== An explicit pick: window.select records the session's assignment and creates one inactive
  // guest tab in the chosen window. The record then beats the saved default. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK });
    ok(selected.windowId === state.userWindowId && Number.isInteger(selected.tabId), "explicit: the pick is recorded in the chosen window");
    ok(state.tabs.get(selected.tabId).windowId === state.userWindowId, "explicit: the guest tab is in the chosen window");
    ok(state.tabs.get(selected.tabId).active === false, "explicit: the guest tab is inactive");
    ok(state.userArticle.url === "https://example.com/research-article", "explicit: choosing a window did not navigate or replace a user tab");
    assertNoCreation(state, "explicit");
    ok(state.events.focuses.length === 0, "explicit: choosing a window did not focus anything");

    // A saved default pointing elsewhere must NOT pull the session out of its explicit assignment.
    const nav = await navWith(w, "https://pi.test/explicit-wins", SK, otherWindowId);
    ok(nav.windowId === state.userWindowId && nav.id === selected.tabId, "explicit: the session's own assignment beats the saved default");
    ok(state.tabs.get(nav.id).windowId === state.userWindowId, "explicit: the reused tab is where the record says");

    // Re-selecting the same window keeps the tab instead of churning one.
    const again = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK });
    ok(again.reused === true && again.tabId === selected.tabId, "explicit: re-selecting the current window reuses the guest tab");

    // Selecting another existing window moves the guest tab there.
    state.tabs.set(state.alloc.tab(), { id: state.tabs.size + 3, windowId: otherWindowId, url: "https://example.com/other", active: false, groupId: -1 });
    const moved = await w.dispatch("window.select", { windowId: otherWindowId, sessionKey: SK });
    ok(moved.windowId === otherWindowId && state.tabs.get(moved.tabId).windowId === otherWindowId, "explicit: re-selecting moves the assignment");
    ok(!state.tabs.has(selected.tabId), "explicit: the old guest tab was retired, not left behind");
  }

  // ===== Cleanup closes only Pi's guest tab, never the window the user chose, and is idempotent. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK });
    const cleanup = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(cleanup.closedTabId === selected.tabId && cleanup.closedWindowId === null, "cleanup: only the guest tab is reported closed");
    ok(!state.tabs.has(selected.tabId), "cleanup: the guest tab is gone");
    ok(state.windows.has(state.userWindowId), "cleanup: the user's chosen window survives");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "cleanup: user tabs survive");
    const again = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(again.closedTabId === null && again.closedWindowId === null, "cleanup: a repeated cleanup is a no-op");
    const empty = loadWorker(makeChrome(makeChromeState())).dispatch("automation.cleanup", { sessionKey: "session:never" });
    ok((await empty) && true, "cleanup: no-op when nothing was ever assigned");
  }

  // ===== The recorded window closed: FAIL LOUDLY naming /chrome window, never silently pick another
  // and never repair by creating one. Re-picking an existing window recovers. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK });
    // The user closes the whole window (Chrome closes its tabs with it).
    state.windows.delete(state.userWindowId);
    for (const [tid, t] of [...state.tabs]) if (t.windowId === state.userWindowId) state.tabs.delete(tid);
    ok(state.windows.size === 0, "window-gone: the browser has no windows left");

    await throwsWith(
      () => navWith(w, "https://pi.test/window-gone", SK, undefined),
      /\/chrome window/,
      "window-gone: fails with an actionable /chrome window message",
    );
    assertNoCreation(state, "window-gone");
    ok(state.windows.size === 0, "window-gone: no replacement window was created");
    ok(state.tabs.size === 0, "window-gone: no replacement tab was created");

    // The picker can only recover if the user opens a window first.
    const reopened = state.alloc.window();
    state.windows.set(reopened, { id: reopened });
    const recovered = await w.dispatch("window.select", { windowId: reopened, sessionKey: SK });
    ok(recovered.windowId === reopened, "window-gone: an explicit re-pick of a live window recovers");
    const nav = await navWith(w, "https://pi.test/window-gone-2", SK, undefined);
    ok(nav.windowId === reopened, "window-gone: the recovered window is the workspace");
  }

  // ===== The user drags Pi's guest tab into another window: the next implicit action retires it and
  // rebuilds in the window the assignment names — never follows the tab into the user's window. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });
    const otherTab = { id: state.alloc.tab(), windowId: otherWindowId, url: "https://example.com/elsewhere", active: false, groupId: -1 };
    state.tabs.set(otherTab.id, otherTab);

    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK });
    state.tabs.get(selected.tabId).windowId = otherWindowId; // the user drags Pi's tab away

    const nav = await navWith(w, "https://pi.test/moved", SK, undefined);
    ok(nav.windowId === state.userWindowId, "moved-guest: the replacement is built in the assigned window");
    ok(nav.id !== selected.tabId && !state.tabs.has(selected.tabId), "moved-guest: the moved tab was retired, not followed");
    ok(state.tabs.get(nav.id).windowId === state.userWindowId, "moved-guest: the new target is where it claims to be");
    ok(state.tabs.has(otherTab.id), "moved-guest: the other window's tab is untouched");
  }

  // ===== Explicitly targeting a moved Pi tab fails loudly instead of driving it in the user's
  // window. The explicit selectors bypass the implicit resolver, so this guard is separate. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK });
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });
    state.tabs.get(selected.tabId).windowId = otherWindowId;

    await throwsWith(
      () => w.dispatch("page.navigate", { targetId: String(selected.tabId), url: "https://pi.test/hijack", waitUntilLoad: false, sessionKey: SK }),
      /moved out of its own window/,
      "moved-explicit: targeting the moved tab refuses",
    );
    ok(!state.tabs.has(selected.tabId), "moved-explicit: the moved tab was retired");
    ok(state.userArticle.url === "https://example.com/research-article", "moved-explicit: no user tab was navigated");
  }

  // ===== Session groups: Pi's guest tab joins the session group INSIDE the chosen window, and a
  // grouping failure can never move the tab into a foreign group's window. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const groupTitle = "Pi Session: alpha";
    const nav = await navWith(w, "https://pi.test/grouped", SK, state.userWindowId, { joinSessionGroup: true, sessionGroupTitle: groupTitle });
    const navTab = state.tabs.get(nav.id);
    ok(navTab.windowId === state.userWindowId, "group: the guest tab is in the chosen window");
    ok(typeof navTab.groupId === "number" && navTab.groupId >= 0, "group: the guest tab joined a tab group");
    const grp = state.groups.get(navTab.groupId);
    ok(grp && grp.title === groupTitle && grp.windowId === state.userWindowId, "group: the group lives in the chosen window and carries the session title");

    const groupsBefore = state.groups.size;
    const opened = await w.dispatch("tab.new", { url: "https://pi.test/new-tab", groupTitle, sessionKey: SK });
    ok(opened.tab.windowId === state.userWindowId, "group: tab.new opened in the chosen window");
    ok(opened.tab.groupId === navTab.groupId, "group: tab.new joined the existing session group");
    ok(state.groups.size === groupsBefore, "group: tab.new did not create a second group");

    // A foreign same-titled group in another window must never capture the tab: groupTab scopes its
    // lookup to the tab's own window.
    const foreignWindowId = state.alloc.window();
    state.windows.set(foreignWindowId, { id: foreignWindowId });
    const foreignGroupId = state.alloc.group();
    state.groups.set(foreignGroupId, { id: foreignGroupId, title: groupTitle, color: "blue", collapsed: false, windowId: foreignWindowId });
    const after = await navWith(w, "https://pi.test/grouped-2", SK, state.userWindowId, { joinSessionGroup: false });
    ok(state.tabs.get(after.id).windowId === state.userWindowId, "group: the second guest tab stayed in the chosen window");
  }

  // ===== tab.new uses the chosen window and never a windowId-less create (which Chrome puts in the
  // focused window). This is the exact live bug the Edge-shaped mock exists to catch. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const opened = await w.dispatch("tab.new", { url: "https://pi.test/pinned", sessionKey: SK, preferredWindow: state.userWindowId });
    ok(opened.tab.windowId === state.userWindowId, "tab.new: the tab is in the chosen window");
    ok(state.events.windowIdLessTabCreates.length === 0, "tab.new: every tabs.create carried an explicit windowId");
    assertNoCreation(state, "tab.new");
    ok(state.userArticle.active === true, "tab.new: the user's active tab was not activated/replaced");
  }

  // ===== The Edge quirk, pinned: the mock returns the real shape, and withResolvedWindowId repairs
  // a tab whose creation API omitted windowId by re-reading the live tab. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const win = await w.chrome.windows.create({ url: "about:blank#pi-chrome", focused: false });
    ok(win.tabs.length === 1 && win.tabs[0].windowId === undefined, "edge-quirk: windows.create's returned tab omits windowId (real Edge shape)");
    ok(state.tabs.get(win.tabs[0].id).windowId === win.id, "edge-quirk: the underlying tab really is in the new window");
    const repaired = await w.withResolvedWindowId(win.tabs[0]);
    ok(repaired.windowId === win.id, "edge-quirk: withResolvedWindowId re-read the live tab and filled the window id");
  }

  // ===== The live 2026-09-20 permission failure, pinned to the real browser and to production's URL
  // choice, on BOTH channels. Live Edge 123 refuses chrome.debugger.attach for about:blank#pi-chrome
  // (host-permission error) and refuses chrome.scripting.executeScript for plain about:blank as well
  // (opaque origin, <all_urls> does not cover it). So two independent regressions are pinned here:
  // the debugger path that the URL fix repaired, and the scripting path that only works because
  // production falls back to the debugger. Before the fix the debugger assertion below fails with
  // "Chrome debugger attach failed for tab N: Cannot access contents of url \"about:blank#pi-chrome\".
  // Extension manifest must request permission to access this host.", and the snapshot/probe/console
  // assertions fail with the scripting permission error on plain about:blank. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));

    // The mock now refuses exactly what live Edge refuses, so a future marker URL cannot pass tests.
    const denied = await w.chrome.tabs.create({ url: "about:blank#pi-chrome", windowId: state.userWindowId });
    await throwsWith(
      () => w.attachDebugger(denied.id),
      /^Chrome debugger attach failed for tab \d+: Cannot access contents of url "about:blank#pi-chrome"\. Extension manifest must request permission to access this host\./,
      "permission-model: attach to the #pi-chrome URL is denied (live Edge shape)",
    );
    const allowed = await w.chrome.tabs.create({ url: "about:blank", windowId: state.userWindowId });
    let allowedError = null;
    try { await w.attachDebugger(allowed.id); } catch (e) { allowedError = e; }
    ok(!allowedError, `permission-model: plain about:blank attaches (got: ${allowedError && allowedError.message})`);

    // Production: a brand-new session's first page.evaluate must succeed. Before the fix this
    // rejected with the attach error above because the target URL was about:blank#pi-chrome.
    const permissionKey = "session:permission";
    let evaluated = null;
    let evaluateError = null;
    try {
      evaluated = await w.dispatch("page.evaluate", { expression: "1+1", background: true, sessionKey: permissionKey, preferredWindow: state.userWindowId });
    } catch (e) { evaluateError = e; }
    ok(
      evaluated === 2 && !evaluateError,
      `permission: a fresh automation target can run page.evaluate (got: ${evaluateError ? evaluateError.message : evaluated})`,
    );

    const target = state.tabs.get((await w.dispatch("automation.status", { sessionKey: permissionKey })).tabId);
    ok(target && target.url === "about:blank", `permission: the automation target URL is exactly about:blank (got: ${target && target.url})`);

    // Production attached through the page-target debuggee (pageDebuggeeForTab), not the bare
    // {tabId} shape: the mock's getTargets returns page targets, so this pins the path exercised.
    ok(
      state.events.debuggerAttaches.some((entry) => typeof entry.targetId === "string" && entry.targetId.startsWith("page-target-")),
      "permission-model: attach used the page-target debuggee shape",
    );

    // Scripting vs plain about:blank, exactly as live Edge refuses it. This is the second failure
    // mode the URL fix alone does not repair; pinning the refusal keeps an idealised mock from
    // hiding it again.
    await throwsWith(
      () => w.chrome.scripting.executeScript({ target: { tabId: target.id }, world: "MAIN", func: () => 1 + 1 }),
      /^Cannot access contents of url "about:blank"\. Extension manifest must request permission to access this host\.$/,
      "permission-model: chrome.scripting refuses plain about:blank (live Edge shape)",
    );

    // page.probe / page.console.list / page.snapshot on that fresh target are scripting-only
    // production actions: they can only work through the scripting->debugger fallback. The snapshot
    // assertion runs the real snapshot_injected.js in the mock's page realm, so it proves the file
    // source was injected and the snapshot function really returned a snapshot.
    const probed = await w.dispatch("page.probe", { background: true, sessionKey: permissionKey });
    ok(
      probed && probed.arithmetic === 2 && probed.location === "about:blank",
      `permission: page.probe runs on a fresh target through the scripting fallback (got: ${JSON.stringify(probed)})`,
    );
    const consoleList = await w.dispatch("page.console.list", { background: true, sessionKey: permissionKey });
    ok(consoleList && Array.isArray(consoleList.messages), `permission: page.console.list runs on a fresh target (got: ${JSON.stringify(consoleList)})`);
    const snapshot = await w.dispatch("page.snapshot", { background: true, sessionKey: permissionKey, mode: "auto" });
    ok(
      snapshot && snapshot.url === "about:blank" && snapshot.mode === "auto" && Array.isArray(snapshot.elements),
      `permission: page.snapshot runs on a fresh target through the scripting fallback (got: ${JSON.stringify(snapshot && { url: snapshot.url, mode: snapshot.mode })})`,
    );

    // And the per-command refusal, matching the live crossover: a tab attached on a permitted URL that
    // then navigates to the marker is refused by Runtime.evaluate itself (live measurement: 10ms).
    const attached = await w.chrome.tabs.create({ url: "https://example.com/", windowId: state.userWindowId });
    await w.dispatch("cdp.call", { targetId: String(attached.id), method: "Runtime.evaluate", params: { expression: "1+1" }, background: true });
    await w.chrome.tabs.update(attached.id, { url: "about:blank#pi-chrome" });
    await throwsWith(
      () => w.dispatch("cdp.call", { targetId: String(attached.id), method: "Runtime.evaluate", params: { expression: "1+1" }, background: true }),
      /^Runtime\.evaluate: Cannot access contents of url "about:blank#pi-chrome"\. Extension manifest must request permission to access this host\./,
      "permission-model: Runtime.evaluate is refused after a permitted tab navigates to the marker",
    );
  }

  // ===== A window that exists but refuses Pi's tab fails actionably; it never retries without a
  // windowId and never leaves a stray tab. =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state);
    const w = loadWorker(chrome);
    chrome.tabs.create = async () => { throw new Error("tab creation refused by policy"); };
    await throwsWith(
      () => navWith(w, "https://pi.test/refused", SK, state.userWindowId),
      /\/chrome window/,
      "tab-refused: the failure names /chrome window",
    );
    assertNoCreation(state, "tab-refused");
    ok(state.tabs.size === 2, "tab-refused: no tab was created");
  }

  // ===== Persisted assignment survives a service-worker restart and cleanup clears it. =====
  {
    const state = makeChromeState();
    const w1 = loadWorker(makeChrome(state));
    const nav = await navWith(w1, "https://pi.test/persist", SK, state.userWindowId);
    const persisted = state.storage.piChromeAutomationTargets || {};
    ok(persisted[SK] && persisted[SK].windowId === state.userWindowId, "restart: the assignment was persisted to storage.session");

    // MV3 suspension/restart: fresh sandbox (memory wiped), same browser state + session storage.
    const w2 = loadWorker(makeChrome(state));
    const status = await w2.dispatch("automation.status", { sessionKey: SK });
    ok(status.tabId === nav.id && status.windowId === state.userWindowId, "restart: the assignment re-hydrated");
    const nav2 = await navWith(w2, "https://pi.test/persist-2", SK, undefined);
    ok(nav2.id === nav.id && nav2.windowId === state.userWindowId, "restart: a later action reuses the persisted guest tab");
    assertNoCreation(state, "restart");

    await w2.dispatch("automation.cleanup", { sessionKey: SK });
    const after = state.storage.piChromeAutomationTargets || {};
    ok(!(SK in after), "restart: cleanup removed the session's assignment from persistence");
    ok(state.tabs.has(state.userArticle.id), "restart: cleanup never touched the user's tabs");
  }

  // ===== A legacy "Pi window" record from an earlier build is honored while that window exists
  // (the record is an explicit assignment), but a legacy record whose window is gone refuses — it
  // must not silently create a replacement window. window.list still flags the legacy window so the
  // picker never offers it. =====
  {
    const state = makeChromeState();
    const legacyWindowId = state.alloc.window();
    state.windows.set(legacyWindowId, { id: legacyWindowId });
    const marker = { id: state.alloc.tab(), windowId: legacyWindowId, url: "about:blank#pi-chrome", active: false, groupId: -1 };
    state.tabs.set(marker.id, marker);
    const legacyKey = "session:legacy";
    state.storage.piChromeAutomationTargets = { [legacyKey]: { tabId: null, windowId: legacyWindowId, piWindow: true } };
    state.storage.piChromeCreatedWindowIds = [legacyWindowId];
    const w = loadWorker(makeChrome(state));

    const adopted = await w.getOrCreateAutomationTarget(legacyKey);
    ok(adopted.id === marker.id, "legacy: the unowned marker in the recorded Pi window was adopted, not duplicated");
    ok(
      state.tabs.get(marker.id).url === "about:blank",
      `legacy: adoption healed the marker URL to plain about:blank (got: ${state.tabs.get(marker.id).url})`,
    );
    // The residual hole the review found: without healing, adoption returned the un-attachable
    // marker URL and the first page.evaluate on it died with the debugger permission error.
    let adoptedEval = null;
    let adoptedEvalError = null;
    try { adoptedEval = await w.dispatch("page.evaluate", { expression: "1+1", background: true, sessionKey: legacyKey }); } catch (e) { adoptedEvalError = e; }
    ok(adoptedEval === 2 && !adoptedEvalError, `legacy: the adopted legacy marker runs page.evaluate (got: ${adoptedEvalError ? adoptedEvalError.message : adoptedEval})`);

    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/legacy", waitUntilLoad: false, sessionKey: legacyKey });
    ok(nav.id === marker.id && nav.windowId === legacyWindowId, "legacy: the adopted marker is reused for the next action");
    assertNoCreation(state, "legacy");

    const report = await w.dispatch("window.list", { sessionKey: legacyKey });
    const listed = (report.windows || []).find((win) => win.windowId === legacyWindowId);
    ok(listed && listed.ownedByPi === true, "legacy: window.list marks the old Pi window so the picker excludes it");

    // The same record with the window gone: refuse naming /chrome window, create nothing.
    const goneState = makeChromeState();
    const goneKey = "session:legacy-gone";
    goneState.storage.piChromeAutomationTargets = { [goneKey]: { tabId: null, windowId: 424242, piWindow: true } };
    goneState.storage.piChromeCreatedWindowIds = [424242];
    const goneWorker = loadWorker(makeChrome(goneState));
    await throwsWith(
      () => goneWorker.dispatch("page.navigate", { url: "https://pi.test/legacy-gone", waitUntilLoad: false, sessionKey: goneKey }),
      /\/chrome window/,
      "legacy-gone: a gone legacy window refuses instead of creating a replacement",
    );
    assertNoCreation(goneState, "legacy-gone");
    ok(goneState.windows.size === 1, "legacy-gone: no window was created");
  }

  // ===== window.list reports where the guest tab really is (so the picker can mark it) without
  // claiming a window Pi owns. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const nav = await navWith(w, "https://pi.test/report", SK, state.userWindowId);
    const report = await w.dispatch("window.list", { sessionKey: SK });
    const userWindow = (report.windows || []).find((win) => win.windowId === state.userWindowId);
    ok(userWindow && userWindow.holdsTargetTab === true, "window.list: the chosen window is reported as holding Pi's tab");
    ok(report.ownsTargetWindow === false && report.targetWindowId === null, "window.list: a guest tab is never reported as owning a window");
    ok((report.windows || []).every((win) => win.ownedByPi !== true), "window.list: no window is falsely marked as Pi-owned");
    ok(nav.windowId === state.userWindowId, "window.list: the report matches where the tab is");
  }

  // ===== Session tab bookkeeping: an adopted user tab is ungrouped, a created Pi tab is closed, and
  // neither user tabs nor the chosen window are ever removed. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    await navWith(w, "https://pi.test/adopt", SK, state.userWindowId, { joinSessionGroup: true, sessionGroupTitle: "Pi Session: alpha" });
    // Pi groups one of the USER's tabs too (an explicit target), which must be ungrouped only.
    const grouped = await w.dispatch("tab.group", { sessionKey: SK, targetId: String(state.userGmail.id), groupTitle: "Pi Session: alpha" });
    ok(grouped.group && state.userGmail.groupId >= 0, "resources: the explicitly grouped user tab joined Pi's group");
    const created = await w.dispatch("tab.new", { sessionKey: SK, groupTitle: "Pi Session: alpha" });

    const cleanup = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(!state.tabs.has(created.tab.id), "resources: the created Pi tab was closed");
    ok(state.tabs.has(state.userGmail.id) && state.userGmail.groupId === -1, "resources: the adopted user tab was ungrouped, not closed");
    ok(state.tabs.has(state.userArticle.id), "resources: the untouched user tab survives");
    ok(state.windows.has(state.userWindowId), "resources: the chosen window is never closed");
    ok(cleanup.ungroupedAdoptedTabs === 1, "resources: the adopted-tab count is honest");
  }

  // ===== Runtime tracking without storage.session: no crash, and cleanup still only closes Pi's tab. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true, withStorage: false }));
    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK });
    await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(!state.tabs.has(selected.tabId) && state.tabs.has(state.userArticle.id), "no-storage: cleanup closed only Pi's tab");
  }

  // ===== The sweep: across every path, no window is created and no tab is created without an
  // explicit window. If automatic creation ever returns by any route, this block fails. =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    const w = loadWorker(chrome);
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    await navWith(w, "https://pi.test/sweep-1", "session:s1", state.userWindowId).catch(() => null);
    await navWith(w, "https://pi.test/sweep-2", "session:s2", undefined).catch(() => null);
    await w.dispatch("tab.new", { url: "https://pi.test/sweep-3", sessionKey: "session:s3", preferredWindow: otherWindowId }).catch(() => null);
    await w.dispatch("window.select", { windowId: otherWindowId, sessionKey: "session:s4" }).catch(() => null);
    await w.dispatch("window.select", { windowId: null, sessionKey: "session:s5" }).catch(() => null);
    await w.dispatch("automation.cleanup", { sessionKey: "session:s1" }).catch(() => null);
    await w.dispatch("automation.cleanup", { sessionKey: "session:s4" }).catch(() => null);

    assertNoCreation(state, "sweep");
    ok(state.windows.size === 2, "sweep: the only windows are the two that existed before");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
