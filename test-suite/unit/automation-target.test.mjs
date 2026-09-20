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

  return { tabs, windows, groups, storage, localStorage: { piProfileId: "unittestprofile" }, alloc, userWindowId, userGmail, userArticle, events, pageContexts };
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
      // Real Chrome: moving a tab to another window keeps the tab (and its page) and DROPS it from its
      // group, because a tab group cannot span windows. Both halves matter here: the move is how a pick
      // must relocate a session's live target without losing the page, and the dropped group is why the
      // mover regroups the tab afterwards.
      move: async (ids, { windowId, index = -1 } = {}) => {
        const list = Array.isArray(ids) ? ids : [ids];
        const moved = [];
        for (const id of list) {
          const tab = tabs.get(id);
          if (!tab) throw new Error(`No tab with id ${id}`);
          if (!windows.has(windowId)) throw new Error(`No window with id ${windowId}`);
          if (tab.windowId !== windowId) { tab.groupId = -1; tab.windowId = windowId; }
          moved.push({ ...tab });
        }
        void index;
        return Array.isArray(ids) ? moved : moved[0];
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
      // Per-profile storage, so the worker can name its own connector key (`${browser}:${profileId}`).
      // A window pick is scoped to the profile that made it, and that comparison needs a real id here.
      local: {
        get: async (key) => (key in state.localStorage ? { [key]: state.localStorage[key] } : {}),
        set: async (obj) => { Object.assign(state.localStorage, obj); },
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
// It carries the same grouping wire params the real Pi side injects for page.* actions
// (sessionGroupTitle/joinSessionGroup), so a mock with tabGroups groups the target exactly like production
// — which is what makes it recognisable as Pi's own tab to the pick's move/close guard.
function navWith(w, url, sessionKey, preferredWindow, extra = {}) {
  return w.dispatch("page.navigate", {
    url,
    waitUntilLoad: false,
    sessionKey,
    preferredWindow,
    sessionGroupTitle: "Pi Agent",
    joinSessionGroup: true,
    ...extra,
  });
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
      () => w.dispatch("window.select", { windowId: null, sessionKey: SK, pickSource: "user" }),
      /\/chrome window|no longer creates a window/,
      "own-window: windowId:null refuses instead of creating a window",
    );
    assertNoCreation(state, "own-window");
    ok(state.tabs.size === 2 && state.windows.size === 1, "own-window: no tab or window was created");
  }

  // ===== An explicit pick: window.select records the session's assignment and creates one inactive
  // guest tab in the chosen window. Under the one-writer rule (R1) that record does NOT outrank the
  // machine-wide pick; the pick still decides and the record only mirrors it. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK, pickSource: "user" });
    ok(selected.windowId === state.userWindowId && Number.isInteger(selected.tabId), "explicit: the pick is recorded in the chosen window");
    ok(state.tabs.get(selected.tabId).windowId === state.userWindowId, "explicit: the guest tab is in the chosen window");
    ok(state.tabs.get(selected.tabId).active === false, "explicit: the guest tab is inactive");
    ok(state.userArticle.url === "https://example.com/research-article", "explicit: choosing a window did not navigate or replace a user tab");
    assertNoCreation(state, "explicit");
    ok(state.events.focuses.length === 0, "explicit: choosing a window did not focus anything");

    // Re-selecting the same window keeps the tab instead of churning one.
    const again = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK, pickSource: "user" });
    ok(again.reused === true && again.tabId === selected.tabId, "explicit: re-selecting the current window reuses the guest tab");

    // ONE WRITER: a machine-wide pick naming another window supersedes even the session's own explicit
    // record, and its tab is MOVED there so the page survives. This block used to assert the opposite
    // ("the session's own assignment beats the saved default") — the rule that let the worker's newer
    // __default__ record outrank the user's saved pick in the measured conflict.
    const nav = await navWith(w, "https://pi.test/explicit-wins", SK, otherWindowId);
    ok(nav.windowId === otherWindowId && nav.id === selected.tabId,
      "explicit: the machine-wide pick supersedes the session's own record and moves its tab");
    ok(state.tabs.get(nav.id).windowId === otherWindowId, "explicit: the moved tab now lives in the picked window");

    // Selecting the window the tab was moved away from moves it back — the tab is MOVED, not replaced:
    // re-choosing a window must not throw away the page the session was working on, and the window it
    // leaves must hold only its own tabs again.
    state.tabs.set(state.alloc.tab(), { id: state.tabs.size + 3, windowId: otherWindowId, url: "https://example.com/other", active: false, groupId: -1 });
    const moved = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK, pickSource: "user" });
    ok(moved.windowId === state.userWindowId && state.tabs.get(moved.tabId).windowId === state.userWindowId, "explicit: re-selecting moves the assignment");
    ok(moved.tabId === selected.tabId && moved.moved === true, "explicit: the guest tab itself moved, keeping its page");
    ok(state.tabs.has(selected.tabId) && state.tabs.get(selected.tabId).windowId === state.userWindowId && state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id),
      "explicit: the window it left holds only its own tabs again");
    ok(state.windows.has(otherWindowId), "explicit: the window it left is still open");
  }

  // ===== NO ROGUE WRITERS (R3): window.select may change the workspace only when the caller says the
  // USER made the choice. The measured failure: another agent posted hand-built JSON to POST /command (no
  // sessionKey, no pickSource) calling window.select, and thereby pinned Pi to a window the user did not
  // choose. Without pickSource:"user" the call must fail, name /chrome window, and touch nothing: no
  // record write, no tab create or move, no sweep — and no remembered pick either (the mirrored pick here
  // was seeded by a keyed forwarded pick, the shape the real Pi side sends). =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const ownKey = await w.selfClientKey();
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });
    const before = await navWith(w, "https://pi.test/rogue-pre", SK, state.userWindowId, { preferredWindowKey: ownKey });
    const tabIdsBefore = [...state.tabs.keys()].sort().join();

    await throwsWith(
      () => w.dispatch("window.select", { windowId: otherWindowId, sessionKey: SK }),
      /Only \/chrome window can choose Pi's window/,
      "rogue: window.select without pickSource fails, naming the only writer",
    );
    ok([...state.tabs.keys()].sort().join() === tabIdsBefore, "rogue: no tab was created or closed");
    ok(state.tabs.get(before.id).windowId === state.userWindowId, "rogue: no tab was moved");
    const status = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status.windowId === state.userWindowId && status.tabId === before.id, "rogue: the workspace record is unchanged");
    ok(state.storage.piChromePreferredWindow && state.storage.piChromePreferredWindow.windowId === state.userWindowId,
      "rogue: the refusal did not overwrite the remembered pick with the rogue window");
    ok(state.windows.has(otherWindowId), "rogue: the window the rogue call named is untouched");
    assertNoCreation(state, "rogue");

    // The user's own picker carries pickSource:"user", and that same call moves the workspace as before.
    const picked = await w.dispatch("window.select", { windowId: otherWindowId, sessionKey: SK, pickSource: "user" });
    ok(picked.windowId === otherWindowId && state.tabs.get(picked.tabId).windowId === otherWindowId,
      "rogue: the same call with pickSource:\"user\" moves the workspace");
    ok(state.storage.piChromePreferredWindow && state.storage.piChromePreferredWindow.windowId === otherWindowId,
      "rogue: the real pick updates the remembered window");
  }

  // ===== The machine-wide pick supersedes an assignment nobody ever picked — and, per R1, one somebody
  // did pick too. =====
  // The live bug: a session (or the extension's own unscoped default bucket) had resolved a target inside
  // the user's window before /chrome window was used, and a record written AFTER the pick (the measured
  // __default__ bucket, pickedAt newer than the user's pick) kept deciding the workspace. Records no longer
  // decide at all: a record whose window differs from the pick is superseded whatever its pickedAt says. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    const before = await navWith(w, "https://pi.test/pre-pick", SK, state.userWindowId);
    ok(before.windowId === state.userWindowId, "supersede: before the pick the session works where the default pointed");
    const beforeStatus = await w.dispatch("automation.status", { sessionKey: SK });
    ok(beforeStatus.windowId === state.userWindowId, "supersede: that implicit workspace is recorded");

    // The user picks the other window. The pick is newer than the record, and the record was never picked.
    const after = await navWith(w, "https://pi.test/post-pick", SK, otherWindowId, { preferredWindowAt: Date.now() });
    ok(after.windowId === otherWindowId, "supersede: after the pick the same session works in the picked window");
    ok(state.tabs.has(before.id), "supersede: the session's tab is MOVED, not destroyed — it may hold work");
    ok(state.tabs.has(before.id) && state.tabs.get(before.id).windowId === otherWindowId, "supersede: the guest tab physically left the window the user moved away from");
    ok(after.id === before.id, "supersede: the same tab is reused, so its page state survives the pick");
    ok(state.tabs.has(before.id) && state.tabs.get(before.id).active === false, "supersede: moving it did not activate it");
    const status = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status.windowId === otherWindowId && status.tabId === after.id, "supersede: the record now names the picked window");
    ok(state.tabs.has(state.userGmail.id) && state.tabs.has(state.userArticle.id), "supersede: no user tab was touched");
    assertNoCreation(state, "supersede");
  }

  // A pick belongs to the profile that made it. Window ids are per profile — the same number in another
  // browser is a different window — so a keyed pick from another connector must not move this profile's
  // sessions (nor name a window here that merely shares the number).
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    const before = await navWith(w, "https://pi.test/foreign-pre", SK, state.userWindowId);
    const ownKey = typeof w.selfClientKey === "function" ? await w.selfClientKey() : undefined;
    ok(ownKey === "unknown:unittestprofile", `foreign-pick: the worker can name its own connector (got ${JSON.stringify(ownKey)})`);

    const foreign = await navWith(w, "https://pi.test/foreign-post", SK, otherWindowId, { preferredWindowAt: Date.now(), preferredWindowKey: "edge:9d233ecf" });
    ok(foreign.windowId === state.userWindowId && foreign.id === before.id,
      "foreign-pick: another profile's pick does not move this profile's session");
    ok(state.tabs.has(before.id) && state.tabs.get(before.id).windowId === state.userWindowId, "foreign-pick: nothing was moved or closed");

    const mine = await navWith(w, "https://pi.test/own-post", SK, otherWindowId, { preferredWindowAt: Date.now(), preferredWindowKey: ownKey });
    ok(mine.windowId === otherWindowId, "foreign-pick: a pick carrying this profile's own key still applies");
    assertNoCreation(state, "foreign-pick");
  }

  // A pick saved by an older build has a window and no time. It must still beat an implicit assignment:
  // the user's intent is newer than a record nobody picked, even when the file cannot prove when it was
  // saved. This is exactly the live state (preferredWindow present, no preferredWindowAt).
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    const before = await navWith(w, "https://pi.test/legacy-pre", SK, state.userWindowId);
    const after = await navWith(w, "https://pi.test/legacy-post", SK, otherWindowId);
    ok(after.windowId === otherWindowId, "legacy-pick: an untimestamped pick still supersedes a record nobody picked");
    ok(state.tabs.has(before.id) && state.tabs.get(before.id).windowId === otherWindowId, "legacy-pick: the stale guest tab was moved, not abandoned");
    assertNoCreation(state, "legacy-pick");
  }

  // ONE WRITER (the measured conflict): a session that picked for itself does NOT keep its window against
  // the machine-wide pick even when the machine-wide pick is OLDER than the session's own stamp. The old
  // "newer explicit pick wins" comparison is what let the worker's `__default__` bucket record
  // (pickedAt newer than the user's pick 720723947, windowId 720723708) outrank the window the user chose.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK, pickSource: "user" });
    const nav = await navWith(w, "https://pi.test/explicit-newer", SK, otherWindowId, { preferredWindowAt: Date.now() - 60_000 });
    ok(nav.windowId === otherWindowId,
      "one-writer: an OLDER machine-wide pick still beats the session's own newer record");
    ok(nav.id === selected.tabId && state.tabs.get(selected.tabId).windowId === otherWindowId,
      "one-writer: the session's tab is moved to the pick instead of the record surviving on recency");
    assertNoCreation(state, "one-writer-older-pick");
  }

  // The other direction of the same rule: a NEWER machine-wide pick also wins. Asserting both directions is
  // what makes this block load-bearing for "the pick decides regardless of timestamps" rather than merely
  // re-asserting the old recency rule with a convenient clock.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK, pickSource: "user" });
    const nav = await navWith(w, "https://pi.test/machine-newer", SK, otherWindowId, { preferredWindowAt: Date.now() + 60_000 });
    ok(nav.windowId === otherWindowId, "one-writer: a newer machine-wide pick beats an explicitly picked session too");
    ok(nav.id === selected.tabId && state.tabs.has(selected.tabId) && state.tabs.get(selected.tabId).windowId === otherWindowId,
      "supersede: the superseded session's tab moves with it instead of losing its page");
    assertNoCreation(state, "supersede-newer");
  }

  // ===== The pick itself is applied to every record it supersedes, on that action rather than later. =====
  // This is what the user actually sees: Pi's tabs must leave their window the moment they choose another
  // one, instead of lingering until each abandoned session happens to run again.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    const a = await navWith(w, "https://pi.test/debris-a", "session:a", state.userWindowId);
    const b = await navWith(w, "https://pi.test/debris-b", "session:b", state.userWindowId);
    ok(a.windowId === state.userWindowId && b.windowId === state.userWindowId, "sweep: two sessions are working in the user's window");

    const picked = await w.dispatch("window.select", { windowId: otherWindowId, sessionKey: "session:c", pickSource: "user" });
    ok(picked.windowId === otherWindowId, "sweep: the pick is recorded for the picking session");
    ok(typeof picked.pickedAt === "number", "sweep: the pick reports the stamp it wrote, so the Pi side saves the same one");
    ok(picked.swept === 2, "sweep: the pick reports how many other sessions it moved");
    ok(state.tabs.has(a.id) && state.tabs.has(b.id) && state.tabs.get(a.id).windowId === otherWindowId && state.tabs.get(b.id).windowId === otherWindowId,
      "sweep: guest tabs left in the window the user moved away from are moved by the pick itself");
    ok(state.tabs.has(a.id) && state.tabs.has(b.id) && state.tabs.get(a.id).url === "https://pi.test/debris-a" && state.tabs.get(b.id).url === "https://pi.test/debris-b",
      "sweep: those tabs keep their pages — a pick moves Pi's workspace, it does not discard work");
    const statusA = await w.dispatch("automation.status", { sessionKey: "session:a" });
    ok(statusA.windowId === otherWindowId && statusA.tabId === a.id, "sweep: the abandoned session is re-pointed at its moved tab");
    const nextA = await navWith(w, "https://pi.test/debris-a-2", "session:a", otherWindowId, { preferredWindowAt: Date.now() });
    ok(nextA.windowId === otherWindowId && nextA.id === a.id, "sweep: that session's next action reuses the moved tab");
    ok(state.tabs.has(state.userGmail.id) && state.tabs.has(state.userArticle.id), "sweep: no user tab was closed");
    assertNoCreation(state, "sweep-pick");
  }

  // The guest tabs belonging to other sessions survive a worker restart with their pick time, and a
  // machine-wide pick still outranks the hydrated record — including an OLDER pick — while MOVING the tab the
  // record names rather than losing its page. The stamp survives for reporting/compat (asserted above), but
  // under the one-writer rule it does not decide the workspace. This used to assert the opposite: that the
  // hydrating worker let its own newer record keep winning.
  {
    const state = makeChromeState();
    const first = loadWorker(makeChrome(state));
    const picked = await first.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK, pickSource: "user" });
    ok(typeof picked.pickedAt === "number", "durable-pick: window.select stamps the record");
    const persisted = state.storage.piChromeAutomationTargets || {};
    ok(persisted[SK] && persisted[SK].pickedAt === picked.pickedAt, "durable-pick: the stamp is persisted, not just kept in memory");

    // A fresh worker over the same browser state (extension reload) hydrates the record.
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });
    const second = loadWorker(makeChrome(state));
    const nav = await navWith(second, "https://pi.test/durable", SK, otherWindowId, { preferredWindowAt: picked.pickedAt - 60_000 });
    ok(nav.windowId === otherWindowId && nav.id === picked.tabId,
      "durable-pick: the hydrating worker applies an OLDER machine-wide pick to its own hydrated record");
    ok(state.tabs.has(picked.tabId) && state.tabs.get(picked.tabId).windowId === otherWindowId,
      "durable-pick: the hydrated record's tab was moved into the picked window, not abandoned");
    assertNoCreation(state, "durable-pick");
  }

  // ===== REMEMBERED PICK (R2): the worker mirrors the newest pick it has seen to chrome.storage.session,
  // so a pick-less caller still works in the user's window after an MV3 worker restart. This is the
  // measured hand-built POST /command shape: no sessionKey, no preferredWindow, no access to
  // ~/.pi/agent/pi-chrome.json. Without the mirror it had no pick at all, and whatever record its bucket
  // held could pin Pi to a window the user had not chosen. =====
  {
    const state = makeChromeState();
    const pickedWindowId = state.alloc.window();
    state.windows.set(pickedWindowId, { id: pickedWindowId });
    const first = loadWorker(makeChrome(state));
    const ownKey = await first.selfClientKey();

    // A command carrying the user's pick (what the Pi side forwards on every command it sends) teaches
    // the worker the window, and the mirror is written to storage.session. The connector key is part of
    // that pick: without this profile's own key the mirror is deliberately NOT written (see the
    // attribution block below), because a keyless pick is exactly the hand-built POST shape.
    const seeded = await navWith(first, "https://pi.test/remember-seed", SK, pickedWindowId, { preferredWindowAt: 4000, preferredWindowKey: ownKey });
    ok(seeded.windowId === pickedWindowId, "remembered: the pick-carrying command works in the picked window");
    ok(state.storage.piChromePreferredWindow && state.storage.piChromePreferredWindow.windowId === pickedWindowId,
      "remembered: the pick is mirrored to chrome.storage.session");
    ok(state.storage.piChromePreferredWindow.key === ownKey,
      "remembered: the mirror keeps this profile's connector key, so the profile check still works after a restart");

    // A fresh worker over the same browser state: worker memory is wiped, storage.session survives.
    const second = loadWorker(makeChrome(state));
    const picklessParams = {
      url: "https://pi.test/remember-after-restart",
      waitUntilLoad: false,
      sessionKey: "session:pickless",
      sessionGroupTitle: "Pi Agent",
      joinSessionGroup: true,
      // Deliberately no preferredWindow/preferredWindowAt/preferredWindowKey: the pick-less caller shape.
    };
    const nav = await second.dispatch("page.navigate", picklessParams);
    ok(nav.windowId === pickedWindowId && state.tabs.get(nav.id).windowId === pickedWindowId,
      "remembered: a pick-less command after a restart creates its target in the remembered window");

    // The second pick-less command in that session REUSES that tab (R4: create/reuse in the pick window,
    // never the focused window), so the remembered pick behaves exactly like a forwarded one.
    const again = await second.dispatch("page.navigate", { ...picklessParams, url: "https://pi.test/remember-after-restart-2" });
    ok(again.id === nav.id && state.tabs.get(again.id).windowId === pickedWindowId,
      "remembered: the next pick-less action reuses the target in the remembered window");
    assertNoCreation(state, "remembered");

    // Sanity on the mirror's scope: a remembered pick still passes the connector-key check, so a pick
    // remembered here is usable here (the foreign-key refusal is asserted in the foreign-pick block).
    const status = await second.dispatch("automation.status", { sessionKey: "session:pickless" });
    ok(status.windowId === pickedWindowId, "remembered: the pick-less session's record names the remembered window");

    // window.list is another machinePickParams consumer: the picker must mark the remembered window for a
    // session that has no record yet, not fall back to the first entry (usually the user's focused one).
    const report = await second.dispatch("window.list", { sessionKey: "session:never" });
    ok(report.workingWindowId === pickedWindowId,
      "remembered: window.list reports the remembered window as the workspace");
  }

  // With no pick to forward AND nothing remembered, a pick-less caller still refuses with the existing
  // /chrome window message instead of guessing (R4's negative half) — the mirror must not become a licence
  // to invent a window.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    await throwsWith(
      () => w.dispatch("page.navigate", {
        url: "https://pi.test/no-remembered-pick",
        waitUntilLoad: false,
        sessionKey: "session:pickless",
        sessionGroupTitle: "Pi Agent",
        joinSessionGroup: true,
      }),
      /\/chrome window/,
      "remembered: with nothing remembered, a pick-less caller refuses with the fix named",
    );
    ok(state.tabs.size === 2, "remembered: the refusal created no tab");
    assertNoCreation(state, "remembered-none");
  }

  // ===== ATTRIBUTION: a pick on a non-select action is usable for the command that carries it, but only
  // a pick that carries THIS profile's own connector key may become the remembered machine-wide pick.
  // The measured rogue POST /command carried just `preferredWindow`: before this barrier it overwrote the
  // mirror and pinned every later pick-less command — the exact caller R2 was built for — to a window the
  // user did not choose, durably across worker restarts. =====
  {
    const state = makeChromeState();
    const pickedWindowId = state.alloc.window();
    const rogueWindowId = state.alloc.window();
    state.windows.set(pickedWindowId, { id: pickedWindowId });
    state.windows.set(rogueWindowId, { id: rogueWindowId });
    const w = loadWorker(makeChrome(state));
    const ownKey = await w.selfClientKey();

    const picked = await w.dispatch("window.select", { windowId: pickedWindowId, sessionKey: SK, pickSource: "user" });
    ok(state.storage.piChromePreferredWindow.windowId === pickedWindowId, "attribution: the user's pick is remembered");
    ok(state.storage.piChromePreferredWindow.key === ownKey, "attribution: the remembered pick carries the profile's connector key");

    // The hand-built shape: no sessionKey, no pickSource, no preferredWindowKey.
    const rogue = await navWith(w, "https://pi.test/rogue-wire-pick", "session:rogue", rogueWindowId, { preferredWindowAt: Date.now() + 60_000 });
    ok(rogue.windowId === rogueWindowId, "attribution: the unkeyed pick is still usable for the command that carries it");
    ok(state.storage.piChromePreferredWindow.windowId === pickedWindowId && state.storage.piChromePreferredWindow.key === ownKey,
      "attribution: the unkeyed pick did not overwrite the remembered machine-wide pick");

    // The pick-less caller (the measured hand-built POST /command shape) must still resolve into the
    // user's window, and the rogue pick must not have retargeted the user's session record either.
    const pickless = await w.dispatch("page.navigate", {
      url: "https://pi.test/rogue-wire-after",
      waitUntilLoad: false,
      sessionKey: "session:pickless",
      sessionGroupTitle: "Pi Agent",
      joinSessionGroup: true,
    });
    ok(pickless.windowId === pickedWindowId && state.tabs.get(pickless.id).windowId === pickedWindowId,
      "attribution: a later pick-less session still lands in the user's remembered window");
    ok(state.tabs.get(picked.tabId).windowId === pickedWindowId,
      "attribution: the rogue pick did not retarget a different session's record");
    assertNoCreation(state, "attribution");
  }

  // ===== A remembered pick made in ANOTHER profile must not be replayed here: window ids are per
  // profile, so the same number names a different window (or nothing). The pick-less caller is refused
  // with the fix named instead of being sent to a foreign window. =====
  {
    const state = makeChromeState();
    const foreignWindowId = state.alloc.window();
    state.windows.set(foreignWindowId, { id: foreignWindowId });
    const probe = loadWorker(makeChrome(state));
    const foreignKey = `${await probe.selfClientKey()}-other-profile`;
    state.storage.piChromePreferredWindow = { windowId: foreignWindowId, at: 4000, key: foreignKey };
    const w = loadWorker(makeChrome(state));

    await throwsWith(
      () => w.dispatch("page.navigate", {
        url: "https://pi.test/foreign-remembered",
        waitUntilLoad: false,
        sessionKey: "session:pickless",
        sessionGroupTitle: "Pi Agent",
        joinSessionGroup: true,
      }),
      /\/chrome window/,
      "remembered-foreign: a pick remembered in another profile refuses here",
    );
    ok(state.tabs.size === 2, "remembered-foreign: no tab was created in the foreign window id");
    assertNoCreation(state, "remembered-foreign");
  }

  // ===== A window.select naming a window that does not exist fails loudly WITHOUT becoming the
  // remembered pick: the existence check runs before the mirror write, so a stale pick cannot erase the
  // working one (and a later pick-less command cannot be sent to a dead window). =====
  {
    const state = makeChromeState();
    const pickedWindowId = state.alloc.window();
    state.windows.set(pickedWindowId, { id: pickedWindowId });
    const w = loadWorker(makeChrome(state));
    const ownKey = await w.selfClientKey();
    await w.dispatch("window.select", { windowId: pickedWindowId, sessionKey: SK, pickSource: "user" });
    const goneWindowId = state.alloc.window(); // allocated but never inserted: closed before it was picked

    await throwsWith(
      () => w.dispatch("window.select", { windowId: goneWindowId, sessionKey: SK, pickSource: "user" }),
      /No browser window with id/,
      "select-gone: selecting a closed window fails loudly",
    );
    ok(state.storage.piChromePreferredWindow.windowId === pickedWindowId,
      "select-gone: the failed select left the remembered pick intact");
    ok(state.storage.piChromePreferredWindow.key === ownKey,
      "select-gone: the failed select left the remembered pick's key intact");
  }

  // ===== The window.select mirror keeps a previously stored connector key when this worker cannot
  // derive its own (storage.local unavailable): a transient outage must not downgrade the remembered pick
  // to keyless, which would silently disable the profile check for every later pick-less caller. =====
  {
    const state = makeChromeState();
    const firstWindowId = state.alloc.window();
    const pickedWindowId = state.alloc.window();
    state.windows.set(firstWindowId, { id: firstWindowId });
    state.windows.set(pickedWindowId, { id: pickedWindowId });
    const probe = loadWorker(makeChrome(state));
    const ownKey = await probe.selfClientKey();

    // A keyed mirror exists in storage.session (written by an earlier worker of this profile).
    state.storage.piChromePreferredWindow = { windowId: firstWindowId, at: 1, key: ownKey };
    const w = loadWorker(makeChrome(state));
    // This worker cannot read its profile id at all.
    w.chrome.storage.local.get = async () => { throw new Error("storage.local unavailable"); };

    await w.dispatch("window.select", { windowId: pickedWindowId, sessionKey: SK, pickSource: "user" });
    ok(state.storage.piChromePreferredWindow.windowId === pickedWindowId,
      "select-keyless-worker: the pick still moves to the selected window");
    ok(state.storage.piChromePreferredWindow.key === ownKey,
      "select-keyless-worker: the previously mirrored connector key is kept when this worker has none");
  }

  // ===== The measured combination (R1 + R2): a pick-less command whose OWN bucket already holds a record
  // that is NEWER than the remembered pick, in another window. The one-writer rule must move that record's
  // tab into the remembered window — no timestamp protects the record — instead of letting the bucket pin
  // the workspace (the live report's `__default__` record, pickedAt newer than the user's pick). =====
  {
    const state = makeChromeState();
    const pickedWindowId = state.alloc.window();
    const recordWindowId = state.alloc.window();
    state.windows.set(pickedWindowId, { id: pickedWindowId });
    state.windows.set(recordWindowId, { id: recordWindowId });
    const first = loadWorker(makeChrome(state, { withTabGroups: true }));
    const ownKey = await first.selfClientKey();

    // The session resolved a target in its own window first, and its record is stamped NEWER than the
    // user's pick below — the wrong ordering that decided the live failure.
    const recorded = await navWith(first, "https://pi.test/measured-record", SK, recordWindowId, { preferredWindowAt: Date.now() + 60_000 });
    ok(recorded.windowId === recordWindowId, "measured: the session first works in its record window");

    // The user's pick was made earlier and lives in another window; the worker restarts and only the
    // mirror is left for the pick-less command.
    state.storage.piChromePreferredWindow = { windowId: pickedWindowId, at: Date.now() - 60_000, key: ownKey };
    const second = loadWorker(makeChrome(state, { withTabGroups: true }));
    const nav = await second.dispatch("page.navigate", {
      url: "https://pi.test/measured-pickless",
      waitUntilLoad: false,
      sessionKey: SK,
      sessionGroupTitle: "Pi Agent",
      joinSessionGroup: true,
    });
    ok(nav.windowId === pickedWindowId, "measured: the pick-less command uses the remembered pick");
    ok(nav.id === recorded.id && state.tabs.get(recorded.id).windowId === pickedWindowId,
      "measured: the newer record's tab was moved into the picked window, not left behind");
    const status = await second.dispatch("automation.status", { sessionKey: SK });
    ok(status.windowId === pickedWindowId && status.tabId === recorded.id,
      "measured: the record was re-pointed at the picked window and kept its tab");
    assertNoCreation(state, "measured");
  }

  // ===== retargetSupersededRecord validates its own pick window. Every current caller checks first, but
  // this function is what moves/closes, so a future caller (or a race after the caller's check) must not
  // relocate or destroy a tab for a window that is not open. Call it directly with a dead pick window. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const own = await navWith(w, "https://pi.test/retarget-guard", SK, state.userWindowId);
    const goneWindowId = state.alloc.window(); // allocated but never inserted: closed
    const changed = await w.retargetSupersededRecord(SK, { windowId: goneWindowId, tabId: own.id }, { windowId: goneWindowId, at: Date.now() });
    ok(changed === false, "retarget-guard: a closed pick window makes retargetSupersededRecord a no-op");
    ok(state.tabs.has(own.id) && state.tabs.get(own.id).windowId === state.userWindowId,
      "retarget-guard: the tab was neither moved nor closed for a window that is not open");
  }

  // ===== The hydration race guard: a live in-memory pick must not be clobbered by the stored one it was
  // derived from (only reachable with a second entry point, but the guard is what makes a future
  // chrome.runtime.onMessage entry safe). Set a newer pick in the worker scope, then hydrate. =====
  {
    const state = makeChromeState();
    state.storage.piChromePreferredWindow = { windowId: state.userWindowId, at: 1, key: "stored" };
    const w = loadWorker(makeChrome(state));
    vm.runInContext("preferredWindowPick = { windowId: 424242, at: 2, key: 'live' }", w);
    await w.hydratePreferredWindowPick();
    ok(vm.runInContext("preferredWindowPick.windowId === 424242 && preferredWindowPick.key === 'live'", w),
      "hydrate-race: hydration does not clobber a newer in-memory pick");
  }

  // ===== The remembered pick is not page.navigate-specific: tab.new resolves the target window through
  // the same machinePickParams path and must create in the remembered window, not the focused one. =====
  {
    const state = makeChromeState();
    const pickedWindowId = state.alloc.window();
    state.windows.set(pickedWindowId, { id: pickedWindowId });
    const probe = loadWorker(makeChrome(state));
    const ownKey = await probe.selfClientKey();
    state.storage.piChromePreferredWindow = { windowId: pickedWindowId, at: 4000, key: ownKey };
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));

    const created = await w.dispatch("tab.new", { url: "https://pi.test/remember-tab-new", sessionKey: "session:pickless", groupTitle: "Pi Agent" });
    ok(created && created.tab && state.tabs.get(created.tab.id).windowId === pickedWindowId,
      "remembered-tab.new: the tab opens in the remembered window, not the focused one");
    ok(state.events.windowIdLessTabCreates.length === 0,
      "remembered-tab.new: no tab was created without an explicit window");
    assertNoCreation(state, "remembered-tab.new");
  }

  // ===== Version skew: an older Pi session calls window.select without pickSource. The refusal must not
  // stop at "run /chrome window" alone, because that same older session builds the picker call and would
  // be refused for the same reason — it must name the restart that loads the updated pi-chrome. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    await throwsWith(
      () => w.dispatch("window.select", { windowId: null, sessionKey: SK }),
      /restart the Pi session/,
      "skew: window.select without pickSource names the restart fix for an older Pi session",
    );
    ok(state.tabs.size === 2, "skew: the refusal created no tab");
  }

  // An explicit url/title hint is not a way back into a window the pick replaced: the recorded tab is
  // moved into the picked window first, and the hint then resolves to it THERE (the session's own recorded
  // identity wins, but only after the move that the pick requires).
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    const stale = await navWith(w, "https://pi.test/hinted", SK, state.userWindowId);
    const probed = await w.dispatch("page.snapshot", { urlIncludes: "pi.test/hinted", sessionKey: SK, preferredWindow: otherWindowId, preferredWindowAt: Date.now() });
    ok(Boolean(probed), "hint: an explicit hint still resolves after the pick");
    ok(state.tabs.has(stale.id) && state.tabs.get(stale.id).windowId === otherWindowId, "hint: the hint resolved to the tab MOVED into the picked window");
    const status = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status.windowId === otherWindowId && status.tabId === stale.id, "hint: the record names the moved tab, not a dead id");
    assertNoCreation(state, "hint");
  }

  // A pick whose window is GONE is refused before anything is touched: the session keeps its working tab
  // and the error names the fix. Stale picks are the normal case after a browser restart (window ids do not
  // survive it), so destroying the live tab first and failing afterwards would be the worst ordering.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const before = await navWith(w, "https://pi.test/dead-pick-pre", SK, state.userWindowId);
    const pickedAt = Date.now();
    state.windows.delete(state.userWindowId); // the user closes the window the record lives in
    for (const [tid, t] of [...state.tabs]) if (t.windowId === state.userWindowId) state.tabs.delete(tid);
    const reopened = state.alloc.window();
    state.windows.set(reopened, { id: reopened });
    const survivor = await navWith(w, "https://pi.test/dead-pick", SK, reopened, { preferredWindowAt: pickedAt });
    ok(survivor.windowId === reopened, "dead-pick: the session rebuilds in the live window");
    ok(!state.tabs.has(before.id), "dead-pick: the tab in the closed window went with it");

    // Now: the record names `reopened`, and the saved pick names a window that does not exist.
    const deadPick = 987654321;
    await throwsWith(
      () => navWith(w, "https://pi.test/dead-pick-2", SK, deadPick, { preferredWindowAt: Date.now() + 1000 }),
      /no longer open|\/chrome window/,
      "dead-pick: a pick naming a closed window fails with the fix named",
    );
    ok(state.tabs.has(survivor.id), "dead-pick: the session's working tab was NOT destroyed before the check");
    assertNoCreation(state, "dead-pick");
  }

  // A record alone does not prove a tab is Pi's. A tab whose only "evidence" is the record — navigated away
  // from about:blank, not in a Pi group, not in a Pi-created window — is left exactly where it is, and only
  // the record is re-pointed. That is deliberate: a corrupt or hand-edited record must not make a pick
  // relocate or close one of the user's own tabs. The cost is bounded — a fresh target opens in the picked
  // window and the unprovable tab stays where the user can see it.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state)); // no tabGroups: the navigated target cannot be grouped
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    const before = await navWith(w, "https://pi.test/unprovable", SK, state.userWindowId);
    const nav = await navWith(w, "https://pi.test/unprovable-2", SK, otherWindowId, { preferredWindowAt: Date.now() });
    ok(nav.windowId === otherWindowId, "unprovable: the session still moves to the picked window");
    ok(state.tabs.has(before.id) && state.tabs.get(before.id).windowId === state.userWindowId,
      "unprovable: the unprovable tab was neither moved nor closed");
    ok(nav.id !== before.id, "unprovable: a fresh target was opened in the picked window instead");
    ok(state.tabs.has(state.userGmail.id) && state.tabs.has(state.userArticle.id), "unprovable: no user tab was touched");
    assertNoCreation(state, "unprovable");
  }

  // An explicit targetId — how an agent usually addresses its own tab — is subject to the same pick: the tab
  // is moved into the picked window first, so an id cannot keep driving a window the user moved away from.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });

    const own = await navWith(w, "https://pi.test/by-id", SK, state.userWindowId);
    const evaluated = await w.dispatch("page.evaluate", {
      expression: "1+1",
      sessionKey: SK,
      targetId: own.id,
      preferredWindow: otherWindowId,
      preferredWindowAt: Date.now(),
    });
    ok(Boolean(evaluated), "targetId: the action ran");
    ok(state.tabs.has(own.id) && state.tabs.get(own.id).windowId === otherWindowId,
      "targetId: the session's own tab was moved into the picked window instead of being driven where it was");
    assertNoCreation(state, "targetId");
  }

  // The profile filter is not just about moving tabs: with no assignment yet, a pick belonging to another
  // connector must not be used as a window id here either (the same number names a different window in this
  // profile). It refuses cleanly, and nothing is created or moved.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });
    const ownKey = typeof w.selfClientKey === "function" ? await w.selfClientKey() : undefined;

    await throwsWith(
      () => navWith(w, "https://pi.test/foreign-none", "session:none", otherWindowId, { preferredWindowAt: Date.now(), preferredWindowKey: "chrome:deadbeef" }),
      /\/chrome window/,
      "foreign-pick: with no assignment, another profile's pick refuses with the fix named",
    );
    ok(state.tabs.size === 2, "foreign-pick: no tab was created for the foreign window id");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "foreign-pick: no user tab was touched");

    const mine = await navWith(w, "https://pi.test/own-none", "session:none", otherWindowId, { preferredWindowAt: Date.now(), preferredWindowKey: ownKey });
    ok(mine.windowId === otherWindowId, "foreign-pick: this profile's own key is accepted and used");
    assertNoCreation(state, "foreign-pick");
  }

  // ===== Cleanup closes only Pi's guest tab, never the window the user chose, and is idempotent. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK, pickSource: "user" });
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
    await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK, pickSource: "user" });
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
    const recovered = await w.dispatch("window.select", { windowId: reopened, sessionKey: SK, pickSource: "user" });
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

    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK, pickSource: "user" });
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
    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK, pickSource: "user" });
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
    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK, pickSource: "user" });
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
    await w.dispatch("window.select", { windowId: otherWindowId, sessionKey: "session:s4", pickSource: "user" }).catch(() => null);
    await w.dispatch("window.select", { windowId: null, sessionKey: "session:s5", pickSource: "user" }).catch(() => null);
    await w.dispatch("automation.cleanup", { sessionKey: "session:s1" }).catch(() => null);
    await w.dispatch("automation.cleanup", { sessionKey: "session:s4" }).catch(() => null);

    assertNoCreation(state, "sweep");
    ok(state.windows.size === 2, "sweep: the only windows are the two that existed before");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
