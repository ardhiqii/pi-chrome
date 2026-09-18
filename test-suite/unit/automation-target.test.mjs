// Unit harness for pi-chrome's dedicated automation tab/window isolation in service_worker.js.
//
// Feature under test: pi-chrome must never navigate or replace the user's active tab. Page and
// navigation actions without an explicit target are routed to a dedicated automation target that
// the *calling Pi session* created and owns. Ownership is session-scoped (one extension brokers
// every session) and mirrored to chrome.storage.session so a service-worker restart re-hydrates
// it instead of orphaning the window. Cleanup closes only the calling session's owned target.
//
// Like csp-eval.test.mjs we load the *real* worker into a vm sandbox with a stateful chrome.*
// mock, then exercise the real helpers and the real dispatch() paths. Chrome state (tabs/windows/
// storage.session) can be shared across two sandbox loads to simulate a service-worker restart.

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

// ---- stateful Chrome mock. `state` (tabs/windows/storage) can be shared to simulate a
// service-worker restart: the browser keeps its tabs/windows/session-storage, the worker memory
// is wiped (a fresh sandbox).
function makeChromeState() {
  const tabs = new Map(); // id -> { id, windowId, url, active, groupId }
  const windows = new Map(); // id -> { id }
  const groups = new Map(); // groupId -> { id, title, color, collapsed, windowId }
  const storage = {}; // chrome.storage.session backing
  let nextTabId = 1;
  let nextWindowId = 1;
  let nextGroupId = 1;
  const alloc = { tab: () => nextTabId++, window: () => nextWindowId++, group: () => nextGroupId++ };

  // Seed a user window with two real user tabs (Gmail + a research article, the active one).
  const userWindowId = alloc.window();
  windows.set(userWindowId, { id: userWindowId });
  const userGmail = { id: alloc.tab(), windowId: userWindowId, url: "https://mail.google.com/", active: false, groupId: -1 };
  const userArticle = { id: alloc.tab(), windowId: userWindowId, url: "https://example.com/research-article", active: true, groupId: -1 };
  tabs.set(userGmail.id, userGmail);
  tabs.set(userArticle.id, userArticle);

  return { tabs, windows, groups, storage, alloc, userWindowId, userGmail, userArticle };
}

function makeChrome(state, { withWindows = true, withStorage = true, withTabGroups = false } = {}) {
  const { tabs, windows, groups, storage, alloc, userWindowId } = state;
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };

  const chrome = {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener },
    debugger: { sendCommand: noop, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]), onDetach: listener },
    scripting: { executeScript: async () => [{ result: undefined }], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
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
      create: async ({ url = "about:blank", active = false, windowId = userWindowId } = {}) => {
        // Chrome rejects a tab target whose window is gone; modelling that here makes the
        // chosen-window-closed path fail loudly instead of resurrecting a window id.
        if (!windows.has(windowId)) throw new Error(`No window with id ${windowId}`);
        const tab = { id: alloc.tab(), windowId, url, active, groupId: -1 };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      update: async (id, props = {}) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id ${id}`); Object.assign(t, props); return { ...t }; },
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
        const id = alloc.window();
        windows.set(id, { id });
        const tab = { id: alloc.tab(), windowId: id, url, active: true, groupId: -1 };
        tabs.set(tab.id, tab);
        return { id, focused, tabs: [{ ...tab }] };
      },
      get: async (id) => { const w = windows.get(id); if (!w) throw new Error(`No window with id ${id}`); return { ...w }; },
      remove: async (id) => { windows.delete(id); for (const [tid, t] of [...tabs]) if (t.windowId === id) tabs.delete(tid); },
      update: async () => {},
      getAll: async () => [...windows.values()].map((w) => ({
        ...w,
        tabs: [...tabs.values()].filter((t) => t.windowId === w.id).map((t) => ({ ...t })),
      })),
    };
  } else {
    chrome.windows = { update: async () => {} }; // no create/get/remove -> tab fallback path
  }

  return chrome;
}

function loadWorker(chrome) {
  const noop = () => {};
  const sandbox = {
    console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    fetch: async () => { throw new Error("no network in unit test"); },
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

async function run() {
  // ===== Isolation: navigation does not touch the user's active/other tabs. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const userActiveUrl = state.userArticle.url;

    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/task", waitUntilLoad: false, sessionKey: SK });
    ok(state.userArticle.url === userActiveUrl, "navigate: active user tab (research article) is not overwritten");
    ok(state.userGmail.url === "https://mail.google.com/", "navigate: other user tab (Gmail) untouched");
    ok(nav.url === "https://pi.test/task", "navigate: automation target navigated to requested URL");
    ok(nav.id !== state.userArticle.id && nav.id !== state.userGmail.id, "navigate: did not reuse any user tab");
    ok(nav.windowId !== state.userWindowId, "navigate: automation target lives in a dedicated window");

    const status = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status.tabId === nav.id && status.windowId === nav.windowId, "ownership: target ids tracked for the session");
    ok(w.isPiChromeOwnedTarget(nav.id, SK) === true, "ownership: isPiChromeOwnedTarget(owned, session) === true");
    ok(w.isPiChromeOwnedTarget(state.userArticle.id) === false, "ownership: user tab is never owned (any session)");

    // Reuse: a later navigation reuses the same owned target.
    const nav2 = await w.dispatch("page.navigate", { url: "https://pi.test/step-2", waitUntilLoad: false, sessionKey: SK });
    ok(nav2.id === nav.id && nav2.windowId === nav.windowId, "reuse: second navigation reuses the same automation window/tab");
    ok(state.userArticle.url === userActiveUrl, "reuse: user tab still untouched after second navigation");

    // Cleanup closes only the owned window; user tabs/windows survive.
    const cleanup = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(cleanup.closedWindowId === nav.windowId, "cleanup: closed the owned window");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "cleanup: user tabs never closed");
    ok(state.windows.has(state.userWindowId), "cleanup: user window never closed");
    ok(!state.tabs.has(nav.id), "cleanup: the owned automation tab is gone");
    const status2 = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status2.tabId === null && status2.windowId === null, "cleanup: ownership cleared");
  }

  // ===== Session-group integration: the dedicated-window tab joins this session's group. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    // index.ts tags page.* actions with joinSessionGroup + sessionGroupTitle; replicate that here.
    const groupTitle = "Pi Session: alpha";
    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/grouped", waitUntilLoad: false,
      sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    const navTab = state.tabs.get(nav.id);
    ok(navTab.windowId !== state.userWindowId, "group: automation tab is in its dedicated window");
    ok(typeof navTab.groupId === "number" && navTab.groupId >= 0, "group: automation tab joined a tab group");
    const grp = state.groups.get(navTab.groupId);
    ok(grp && grp.title === groupTitle, "group: the group is titled with this session's title");
    ok(grp.windowId === navTab.windowId, "group: the session group lives inside the dedicated automation window (not the user window)");

    // A second page action reuses the same tab and does not spawn a second group.
    const groupsBefore = state.groups.size;
    await w.dispatch("page.navigate", { url: "https://pi.test/grouped-2", waitUntilLoad: false, sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle });
    ok(state.groups.size === groupsBefore, "group: reusing the automation tab does not create a second group");
  }

  // ===== tab.new joins the existing session group instead of creating one group per window. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const groupTitle = "Pi Session: alpha";
    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/group-owner", waitUntilLoad: false,
      sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    const navTab = state.tabs.get(nav.id);
    const groupId = navTab.groupId;
    const groupsBefore = state.groups.size;

    const opened = await w.dispatch("tab.new", { url: "https://pi.test/new-tab", groupTitle, sessionKey: SK });
    ok(state.groups.size === groupsBefore, "tab.new-group: did not create another same-session group");
    ok(opened.tab.groupId === groupId, "tab.new-group: opened tab joined the existing session group");
    ok(opened.tab.windowId === nav.windowId, "tab.new-group: opened tab was created in the existing group's window");

    const forced = await w.dispatch("tab.new", { url: "https://pi.test/no-opt-out", groupTitle, group: false, sessionKey: SK });
    ok(forced.tab.groupId === groupId, "tab.new-group: group:false is ignored; tab still joins the session group");
    ok(state.groups.size === groupsBefore, "tab.new-group: group:false does not create another group");

    const blankTitle = await w.dispatch("tab.new", { url: "https://pi.test/blank-title", groupTitle: "", group: false, sessionKey: SK });
    ok(typeof blankTitle.tab.groupId === "number" && blankTitle.tab.groupId >= 0, "tab.new-group: groupTitle:'' still creates a grouped tab");
    ok(blankTitle.group.title === "Pi Agent", "tab.new-group: blank groupTitle falls back to a group instead of opting out");

    const nav2 = await w.dispatch("page.navigate", {
      url: "https://pi.test/new-automation-target", waitUntilLoad: false,
      sessionKey: "session:beta", joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    ok(state.groups.size === groupsBefore + 1, "automation-target-group: reused the existing session group, only blank-title Pi group was extra");
    ok(nav2.groupId === groupId, "automation-target-group: new automation target joined the existing session group");
    ok(nav2.windowId === nav.windowId, "automation-target-group: new automation target was created in the existing group's window");
  }

  // ===== tab.new never leaves an ungrouped tab behind when grouping fails. =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    const w = loadWorker(chrome);
    const tabsBefore = state.tabs.size;
    chrome.tabs.group = async () => { throw new Error("group blew up"); };

    await throwsWith(
      () => w.dispatch("tab.new", { url: "https://pi.test/group-fail", groupTitle: "Pi Session: alpha", sessionKey: SK }),
      /group blew up/,
      "tab.new-group-fail: surfaces grouping error",
    );
    // Assert on the tab tab.new created, not on the total: tab.new now also ensures the session's
    // automation window exists, and that deliberate extra tab is not the thing this test is about.
    const leftBehind = [...state.tabs.values()].filter((t) => (t.url || "").includes("group-fail"));
    ok(leftBehind.length === 0, "tab.new-group-fail: closes the created tab instead of leaving it ungrouped");
    ok(state.tabs.size >= tabsBefore, "tab.new-group-fail: no tab was lost either");
  }

  // ===== Grouping is best-effort: a tabGroups failure must not break navigation. =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    chrome.tabs.group = async () => { throw new Error("group blew up"); };
    const w = loadWorker(chrome);
    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/group-fail", waitUntilLoad: false, sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: "Pi Session: alpha" });
    ok(nav.url === "https://pi.test/group-fail", "group-fail: navigation still succeeds when grouping throws");
    ok(state.tabs.get(nav.id).windowId !== state.userWindowId, "group-fail: still used the dedicated automation window");
  }

  // ===== Concurrency: two sessions get separate windows; cleanup is per-session. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const a = await w.dispatch("page.navigate", { url: "https://pi.test/a", waitUntilLoad: false, sessionKey: "session:A" });
    const b = await w.dispatch("page.navigate", { url: "https://pi.test/b", waitUntilLoad: false, sessionKey: "session:B" });
    ok(a.id !== b.id && a.windowId !== b.windowId, "concurrency: each session gets its own dedicated window/tab");
    ok(w.isPiChromeOwnedTarget(a.id, "session:A") && !w.isPiChromeOwnedTarget(a.id, "session:B"), "concurrency: ownership is scoped to the creating session");

    // Cleaning up session A must not touch session B's target.
    await w.dispatch("automation.cleanup", { sessionKey: "session:A" });
    ok(!state.tabs.has(a.id), "concurrency: cleanup closed session A's tab");
    ok(state.tabs.has(b.id), "concurrency: cleanup left session B's tab open");
    const bStatus = await w.dispatch("automation.status", { sessionKey: "session:B" });
    ok(bStatus.tabId === b.id, "concurrency: session B still owns its target after A cleanup");
  }

  // ===== Service-worker restart / reconnect: persisted ownership re-hydrates from storage. =====
  {
    const state = makeChromeState();
    const w1 = loadWorker(makeChrome(state));
    const nav = await w1.dispatch("page.navigate", { url: "https://pi.test/persist", waitUntilLoad: false, sessionKey: SK });
    ok(typeof state.storage.piChromeAutomationTargets === "object", "restart: ownership was persisted to storage.session");

    // Simulate the MV3 service worker being suspended and restarted: fresh sandbox (memory wiped),
    // same browser tabs/windows + same session storage.
    const w2 = loadWorker(makeChrome(state));
    const statusAfterRestart = await w2.dispatch("automation.status", { sessionKey: SK });
    ok(statusAfterRestart.tabId === nav.id && statusAfterRestart.windowId === nav.windowId, "restart: re-hydrated the owned target from storage");

    // A navigation after restart must REUSE the existing window, not orphan it with a new one.
    const windowsBefore = state.windows.size;
    const nav2 = await w2.dispatch("page.navigate", { url: "https://pi.test/persist-2", waitUntilLoad: false, sessionKey: SK });
    ok(nav2.id === nav.id && nav2.windowId === nav.windowId, "restart: navigation after restart reuses the persisted window (no orphan)");
    ok(state.windows.size === windowsBefore, "restart: no new window created after restart");

    // Cleanup after restart works and clears persisted state.
    await w2.dispatch("automation.cleanup", { sessionKey: SK });
    const persisted = state.storage.piChromeAutomationTargets || {};
    ok(!(SK in persisted), "restart: cleanup removed the session from persisted storage");
  }

  // ===== Restart after the user manually closed the window: no orphan, fresh target. =====
  {
    const state = makeChromeState();
    const w1 = loadWorker(makeChrome(state));
    const nav = await w1.dispatch("page.navigate", { url: "https://pi.test/closed", waitUntilLoad: false, sessionKey: SK });
    await state.windows.delete(nav.windowId); // user closed pi-chrome's window
    for (const [tid, t] of [...state.tabs]) if (t.windowId === nav.windowId) state.tabs.delete(tid);

    const w2 = loadWorker(makeChrome(state)); // SW restart
    const nav2 = await w2.dispatch("page.navigate", { url: "https://pi.test/reopened", waitUntilLoad: false, sessionKey: SK });
    ok(nav2.id !== nav.id, "restart-after-close: a fresh automation target is created when the persisted one is gone");
    ok(state.tabs.has(nav2.id), "restart-after-close: new target exists");
  }

  // ===== tab.* management never auto-creates / never falls back to the user's active tab. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const windowsBefore = state.windows.size;
    const tabsBefore = state.tabs.size;

    await throwsWith(
      () => w.dispatch("tab.close", { sessionKey: SK }),
      /no automation tab yet|Pass targetId/,
      "tab.close: with no target and no owned target, errors instead of closing the user's active tab",
    );
    ok(state.tabs.has(state.userArticle.id), "tab.close: user's active tab was NOT closed");
    ok(state.windows.size === windowsBefore && state.tabs.size === tabsBefore, "tab.close: did not spawn a throwaway tab/window");

    await throwsWith(() => w.dispatch("tab.activate", { sessionKey: SK, foreground: true }), /no automation tab yet|Pass targetId/, "tab.activate: errors with no target/owned target");

    // Once an automation target exists, management actions operate on it (not on the user tab).
    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/manage", waitUntilLoad: false, sessionKey: SK });
    const closed = await w.dispatch("tab.close", { sessionKey: SK });
    ok(closed.closed === nav.id, "tab.close: with an owned target, closes that target");
    ok(state.tabs.has(state.userArticle.id), "tab.close: user tab still safe after closing the owned target");
  }

  // ===== Explicit targeting still works on any existing tab (no regression). =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/explicit", targetId: String(state.userGmail.id), waitUntilLoad: false, sessionKey: SK });
    ok(nav.id === state.userGmail.id, "explicit: targetId routes to the requested existing tab");
    ok(state.userGmail.url === "https://pi.test/explicit", "explicit: explicitly targeted tab is navigated");
    const status = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status.tabId === null, "explicit: explicit targeting does not create/claim an automation target");
  }

  // ===== No window can be created: the implicit paths must FAIL, never fall back into whichever
  // window Chrome picks. That fallback creates a tab with NO windowId, and Chrome puts it in the FOCUSED
  // window — the user's. The user asked Pi to stay out of their browser, so an actionable error naming
  // /chrome window is the only acceptable outcome. Covered via the three implicit paths: the first
  // page.* action, tab.new, and the target creation helpers they both go through — once when the API is
  // missing entirely, once when Chrome refuses the create call. =====
  for (const mode of ["api-absent", "create-refused"]) {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withWindows: mode === "create-refused", withTabGroups: true });
    let createAttempts = 0;
    if (mode === "create-refused") {
      chrome.windows.create = async () => { createAttempts += 1; throw new Error("window creation refused by policy"); };
    }
    const w = loadWorker(chrome);
    const tabsBefore = state.tabs.size;
    const windowsBefore = state.windows.size;

    await throwsWith(
      () => w.createAutomationTarget(SK),
      /\/chrome window/,
      `no-window-strict (${mode}): createAutomationTarget refuses instead of creating a tab in a window Chrome picks`,
    );
    await throwsWith(
      () => w.getOrCreateAutomationTarget(SK),
      /\/chrome window/,
      `no-window-strict (${mode}): getOrCreateAutomationTarget refuses instead of creating a tab in a window Chrome picks`,
    );
    await throwsWith(
      () => w.dispatch("page.navigate", { url: "https://pi.test/no-window", waitUntilLoad: false, sessionKey: SK }),
      /\/chrome window/,
      `no-window-strict (${mode}): the first page.* action refuses instead of touching the user's window`,
    );
    await throwsWith(
      () => w.dispatch("tab.new", { url: "https://pi.test/no-window", sessionKey: SK }),
      /\/chrome window/,
      `no-window-strict (${mode}): tab.new refuses instead of touching the user's window`,
    );

    ok(state.tabs.size === tabsBefore, `no-window-strict (${mode}): no tab was created anywhere`);
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), `no-window-strict (${mode}): user tabs untouched`);
    ok(state.tabs.get(state.userArticle.id).windowId === state.userWindowId, `no-window-strict (${mode}): the user's active tab never moved`);
    if (mode === "create-refused") {
      // Meaningful here: windows.create exists and WAS attempted, so an unchanged window count proves
      // the four strict paths refused rather than leaving a window behind (with the API absent the
      // count could never change and the assertion would carry no signal).
      ok(createAttempts === 4, "no-window-strict (create-refused): every implicit path attempted the create and was refused");
      ok(state.windows.size === windowsBefore, "no-window-strict (create-refused): the refused attempts left no window behind");
    }
  }

  // ===== windows.create answering with a window but no usable first tab must not strand an untracked,
  // unowned window. It is closed before the strict error is raised, so the failure leaves no partial
  // target behind. =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    let orphanId = null;
    chrome.windows.create = async () => {
      orphanId = state.alloc.window();
      state.windows.set(orphanId, { id: orphanId });
      return { id: orphanId, focused: false, tabs: [] };
    };
    const w = loadWorker(chrome);
    const tabsBefore = state.tabs.size;
    await throwsWith(() => w.createAutomationTarget(SK), /\/chrome window/, "orphan-window: the strict path still errors");
    ok(orphanId !== null, "orphan-window: windows.create was attempted");
    ok(!state.windows.has(orphanId), "orphan-window: the window with no usable tab was closed, not left untracked");
    ok(state.tabs.size === tabsBefore, "orphan-window: no tab was created");
  }

  // ===== The shared-tab fallback remains available, but ONLY under an explicit opt-in. The
  // window-select path opts into one of the user's windows by naming it; nothing implicit may.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withWindows: false }));
    const target = await w.createIsolatedWindowTarget(SK, { allowSharedTabFallback: true });
    ok(target.id !== state.userArticle.id && target.id !== state.userGmail.id, "opt-in fallback: created a dedicated tab, not a user tab");
    ok(w.isPiChromeOwnedTarget(target.id, SK) === true, "opt-in fallback: dedicated tab is owned");
    const cleanup = await w.cleanupAutomationTarget(SK);
    ok(cleanup.closedTabId === target.id && cleanup.closedWindowId === null, "opt-in fallback: cleanup closes only the owned tab (never the shared window)");
    ok(state.windows.has(state.userWindowId), "opt-in fallback: cleanup never closes the user/shared window");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "opt-in fallback: cleanup leaves user tabs intact");
  }

  // ===== A tab dragged out of Pi's window must not be driven there. The ownership record is checked
  // against the tab's real window on every resolve; the stale target is retired and a fresh Pi window
  // is created instead of Pi following the user's tab into their browser. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const first = await w.dispatch("page.navigate", { url: "https://pi.test/in-place", waitUntilLoad: false, sessionKey: SK });
    // The user drags Pi's automation tab into their own window.
    state.tabs.get(first.id).windowId = state.userWindowId;

    const moved = await w.dispatch("page.navigate", { url: "https://pi.test/moved-away", waitUntilLoad: false, sessionKey: SK });
    ok(moved.windowId !== state.userWindowId, "moved-target: the next action does not work in the user's window");
    ok(moved.id !== first.id, "moved-target: the moved tab was retired, not reused");
    ok(!state.tabs.has(first.id), "moved-target: the stale automation tab is closed");
    ok(state.tabs.get(moved.id).windowId === moved.windowId, "moved-target: the new target is where it claims to be");
  }

  // ===== The LIVE report, reproduced: a target recorded in Pi's window whose tab the user moved into
  // their own window, with a leftover "Pi Agent" group there for a regroup to land in. window.list used
  // to report ownsTargetWindow=true / targetWindowId=<Pi's window> while the same report said
  // holdsTargetTab=true for the USER's window, so /chrome window claimed Pi was isolated while it was
  // working among the user's tabs. The implicit page.* path must retire the moved tab — not drive it,
  // and not regroup it into the user's group — and build its replacement in Pi's window. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    // An ungrouped automation target, exactly like the live one at the moment it was moved.
    const first = await w.dispatch("page.navigate", { url: "https://pi.test/recorded", waitUntilLoad: false, sessionKey: SK });
    ok(first.windowId !== state.userWindowId, "live-state: the target started in a Pi window");

    // The stale group in the USER's window that a regroup would land in.
    const staleGroupId = state.alloc.group();
    const leftover = { id: state.alloc.tab(), windowId: state.userWindowId, url: "https://x.com/home", active: false, groupId: staleGroupId };
    state.tabs.set(leftover.id, leftover);
    state.groups.set(staleGroupId, { id: staleGroupId, title: "Pi Agent", color: "blue", collapsed: false, windowId: state.userWindowId });
    const userTabsBefore = [...state.tabs.values()].filter((t) => t.windowId === state.userWindowId).map((t) => t.id).sort();

    // The user drags Pi's automation tab into their own window.
    state.tabs.get(first.id).windowId = state.userWindowId;

    const report = await w.dispatch("window.list", { sessionKey: SK });
    const piWindow = (report.windows || []).find((win) => win.windowId === first.windowId);
    const userWindow = (report.windows || []).find((win) => win.windowId === state.userWindowId);
    ok(userWindow?.holdsTargetTab === true, "live-state: the report sees the target in the user's window");
    ok(report.ownsTargetWindow === false, "live-state: window.list does not claim a window the tab is not in");
    ok(report.targetWindowId === null, "live-state: targetWindowId does not name the stale Pi window");
    ok(piWindow?.ownedByPi === true, "live-state: the Pi-created window is still flagged as Pi's");

    const moved = await w.dispatch("page.navigate", {
      url: "https://pi.test/after-move", waitUntilLoad: false, sessionKey: SK,
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(moved.windowId !== state.userWindowId, "live-state: the next action does not work in the user's window");
    ok(moved.id !== first.id, "live-state: the moved tab was retired, not followed");
    ok(!state.tabs.has(first.id), "live-state: the moved automation tab was closed");
    ok(state.tabs.get(moved.id).windowId === moved.windowId, "live-state: the fresh target is where it claims to be");
    ok(state.tabs.get(leftover.id).groupId === staleGroupId, "live-state: the user-window group was not adopted or renamed");
    const userTabsAfter = [...state.tabs.values()].filter((t) => t.windowId === state.userWindowId).map((t) => t.id).sort();
    ok(userTabsAfter.join(",") === userTabsBefore.join(","), "live-state: the user's window ends with exactly its own tabs; no user tab was regrouped");
    ok([...state.tabs.values()].every((t) => t.windowId !== state.userWindowId || t.groupId !== moved.groupId), "live-state: no user-window tab joined Pi's session group");
  }

  // ===== An explicitly targeted Pi tab that was moved into the user's window must fail loudly. The
  // resolver guards the implicit path, but targetId/urlIncludes/titleIncludes bypass it — and that is
  // how the moved tab could still be driven and grouped into the user's own "Pi Agent" group. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const first = await w.dispatch("page.navigate", { url: "https://pi.test/target-me", waitUntilLoad: false, sessionKey: SK });
    const staleGroupId = state.alloc.group();
    const leftover = { id: state.alloc.tab(), windowId: state.userWindowId, url: "https://x.com/home", active: false, groupId: staleGroupId };
    state.tabs.set(leftover.id, leftover);
    state.groups.set(staleGroupId, { id: staleGroupId, title: "Pi Agent", color: "blue", collapsed: false, windowId: state.userWindowId });
    state.tabs.get(first.id).windowId = state.userWindowId;

    await throwsWith(
      () => w.dispatch("page.navigate", {
        targetId: String(first.id), url: "https://pi.test/hijacked", waitUntilLoad: false,
        sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
      }),
      /moved out of its own window/,
      "moved-explicit: targeting the moved Pi tab refuses instead of using the user's window",
    );
    ok(state.userArticle.url === "https://example.com/research-article", "moved-explicit: the user's active tab was not navigated");
    ok(!state.tabs.has(first.id), "moved-explicit: the moved automation tab was retired, not followed");
    ok(state.tabs.get(leftover.id).groupId === staleGroupId, "moved-explicit: the user-window group was not adopted");
    ok([...state.tabs.values()].every((t) => t.groupId !== staleGroupId || t.id === leftover.id), "moved-explicit: no Pi tab was regrouped into the user's group");
  }

  // ===== When the user deliberately chooses one of their windows and Pi's tab already sits there (moved
  // or left by a stale record), that choice must be recorded: the tab becomes a guest of the user's
  // window, the stale "Pi's window" claim is dropped, and the next page.* action works where the user
  // pointed instead of retiring the tab the user just chose and silently re-isolating. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const first = await w.dispatch("page.navigate", { url: "https://pi.test/guest", waitUntilLoad: false, sessionKey: SK });
    state.tabs.get(first.id).windowId = state.userWindowId;

    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK });
    ok(selected.reused === true && selected.tabId === first.id, "select-guest: the user's chosen window reuses the tab already there");

    const report = await w.dispatch("window.list", { sessionKey: SK });
    ok(report.ownsTargetWindow === false, "select-guest: window.list does not claim Pi's old window");
    ok(report.targetWindowId === null, "select-guest: targetWindowId is cleared after the user chose their window");
    ok((report.windows || []).find((win) => win.windowId === state.userWindowId)?.holdsTargetTab === true, "select-guest: the tab is reported in the chosen window");

    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/guest-2", waitUntilLoad: false, sessionKey: SK });
    ok(nav.id === first.id && nav.windowId === state.userWindowId, "select-guest: the user's chosen window survives the next implicit action");
  }

  // ===== A group lookup without a window must never fall back to "any window": groups cannot span
  // windows, and grouping a tab with a foreign group makes Chrome MOVE the tab into that group's
  // window. The lookup is the only place a foreign group id can be chosen. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const gid = state.alloc.group();
    state.groups.set(gid, { id: gid, title: "Pi Agent", color: "red", collapsed: false, windowId: state.userWindowId });
    const unscoped = await w.findGroupByTitle(undefined, "Pi Agent");
    ok(unscoped === null, "group-scope: a windowless lookup never returns another window's group");
    const scoped = await w.findGroupByTitle(state.userWindowId, "Pi Agent");
    ok(scoped === gid, "group-scope: the same-window lookup still finds the group");
    await throwsWith(
      () => w.groupTab({ id: 999 }, "Pi Agent"),
      /without a window id/,
      "group-scope: grouping a tab with no window is refused instead of guessing one",
    );
  }

  // ===== window.select's "Pi's own window" reuse must check the tab is actually still in that window.
  // A tab dragged into the user's window must not be reported as Pi's own window on the promise that a
  // later resolve will notice. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const first = await w.dispatch("page.navigate", { url: "https://pi.test/in-place", waitUntilLoad: false, sessionKey: SK });
    state.tabs.get(first.id).windowId = state.userWindowId;

    const selected = await w.dispatch("window.select", { windowId: null, sessionKey: SK });
    ok(selected.reused !== true, "select-own-moved: the moved tab is not reported as Pi's own window");
    ok(selected.tabId !== first.id, "select-own-moved: a fresh target was created");
    ok(state.tabs.get(selected.tabId).windowId === selected.windowId, "select-own-moved: the reported window actually holds the target");
    ok(selected.windowId !== state.userWindowId, "select-own-moved: the fresh target is not in the user's window");
    ok(!state.tabs.has(first.id), "select-own-moved: the moved tab was retired");
  }

  // ===== Robust cleanup: no-op when nothing created, and when target already closed manually. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const empty = await w.cleanupAutomationTarget(SK);
    ok(empty.closedWindowId === null && empty.closedTabId === null, "cleanup: no-op when nothing was ever created");

    const t = await w.getOrCreateAutomationTarget(SK);
    // User closed pi-chrome's window manually (Chrome closes its tabs too).
    state.windows.delete(t.windowId);
    for (const [tid, tab] of [...state.tabs]) if (tab.windowId === t.windowId) state.tabs.delete(tid);
    const stale = await w.cleanupAutomationTarget(SK);
    ok(stale.closedWindowId === null && stale.closedTabId === null, "cleanup: robust when owned window was already closed");
  }

  // Cleanup must never remove a window wholesale, even if tabs move during removal.
  for (const moveOwnedTab of [false, true]) {
    const state = makeChromeState();
    const chrome = makeChrome(state);
    chrome.windows.remove = async () => { throw new Error("whole-window removal is forbidden"); };
    const w = loadWorker(chrome);
    const owned = await w.getOrCreateAutomationTarget(SK);
    const remove = chrome.tabs.remove;
    chrome.tabs.remove = async (id) => {
      // User adds a tab just as cleanup starts; a pre-removal window check is not enough.
      state.userArticle.windowId = owned.windowId;
      if (moveOwnedTab) state.tabs.get(owned.id).windowId = state.userWindowId;
      await remove(id);
    };
    const result = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(result.closedTabId === owned.id && result.closedWindowId === null, "mixed window: only owned tab reported closed");
    ok(state.tabs.has(state.userArticle.id) && state.windows.has(owned.windowId), "mixed window: user tab and its window survive");
    ok(!state.tabs.has(owned.id), "mixed window: owned tab removed even after moving to another window");
  }

  // A populated automation window is not disposable merely because Pi created it.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const owned = await w.getOrCreateAutomationTarget(SK);
    state.userArticle.windowId = owned.windowId;
    await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(state.tabs.has(state.userArticle.id) && state.windows.has(owned.windowId), "populated window: user's moved-in tab survives cleanup");
  }

  // Created vs adopted ownership survives restart; matching titles do not grant ownership.
  for (const restart of [false, true]) {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    let w = loadWorker(chrome);
    const groupTitle = "Pi Session: shared-name";
    await w.dispatch("page.navigate", {
      sessionKey: SK, targetId: String(state.userGmail.id), url: "https://mail.google.com/",
      waitUntilLoad: false, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    await w.dispatch("tab.group", { sessionKey: SK, targetId: String(state.userArticle.id), groupTitle });
    const created = await w.dispatch("tab.new", { sessionKey: SK, groupTitle });
    const other = await w.dispatch("tab.new", { sessionKey: "session:other", groupTitle });
    // User changes the article's group after Pi adopted it. Cleanup must respect that change.
    const replacementGroup = state.alloc.group();
    state.userArticle.groupId = replacementGroup;
    if (restart) w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const result = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(!state.tabs.has(created.tab.id) && state.tabs.has(other.tab.id), "resources: close only this session's created tabs");
    ok(state.tabs.has(state.userGmail.id) && state.userGmail.groupId === -1, "resources: adopted user tab ungrouped, not closed");
    ok(state.userArticle.groupId === replacementGroup, "resources: user's replacement group untouched");
    ok(result.closedCreatedTabs === 1 && result.ungroupedAdoptedTabs === 1, "resources: counts reflect successful operations");
    ok(!(SK in state.storage.piChromeSessionTabs), "resources: completed ownership removed from persistence");
    const again = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(again.closedCreatedTabs === 0 && again.ungroupedAdoptedTabs === 0, "resources: repeated cleanup is idempotent");
  }

  // A failed close keeps ownership for retry, without claiming success.
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    const w = loadWorker(chrome);
    const owned = await w.getOrCreateAutomationTarget(SK);
    const opened = await w.dispatch("tab.new", { sessionKey: SK });
    const remove = chrome.tabs.remove;
    chrome.tabs.remove = async () => { throw new Error("temporary close failure"); };
    const failed = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(failed.closedCreatedTabs === 0 && failed.closedTabId === null, "retry: failed closes not reported as success");
    chrome.tabs.remove = remove;
    const restarted = loadWorker(chrome);
    await restarted.dispatch("automation.cleanup", { sessionKey: SK });
    ok(!state.tabs.has(owned.id) && !state.tabs.has(opened.tab.id), "retry: persisted ownership allows retry after restart");
  }

  // Failed ungrouping also remains retryable; a full browser restart abandons ownership.
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    const w = loadWorker(chrome);
    await w.dispatch("tab.group", { sessionKey: SK, targetId: String(state.userGmail.id) });
    const ungroup = chrome.tabs.ungroup;
    chrome.tabs.ungroup = async () => { throw new Error("temporary group failure"); };
    const failed = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(failed.ungroupedAdoptedTabs === 0 && state.userGmail.groupId >= 0, "ungroup retry: failure leaves user tab and ownership intact");
    chrome.tabs.ungroup = ungroup;
    await loadWorker(chrome).dispatch("automation.cleanup", { sessionKey: SK });
    ok(state.userGmail.groupId === -1, "ungroup retry: successful after worker restart");
    const created = await w.dispatch("tab.new", { sessionKey: SK });
    for (const key of Object.keys(state.storage)) delete state.storage[key];
    await loadWorker(chrome).dispatch("automation.cleanup", { sessionKey: SK });
    ok(state.tabs.has(created.tab.id), "browser restart: cleared storage never reclaims restored tabs by group name");
  }

  // Runtime tracking still works when storage.session is unavailable.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true, withStorage: false }));
    const opened = await w.dispatch("tab.new", { sessionKey: SK });
    await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(!state.tabs.has(opened.tab.id) && state.tabs.has(state.userGmail.id), "no storage: created tab cleaned up safely");
  }

  // ===== a leftover generic "Pi Agent" group in the USER's window must not capture a new target. =====
  // The real failure: an earlier session left a grouped tab in the user's own window, then the extension
  // reloaded. Automation targets live in chrome.storage.session, which an extension reload clears, so the
  // next command recreated the target — and the old code chose the window by matching ANY group titled
  // "Pi Agent", found that leftover in the user's window, and put Pi's tab there among theirs.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const gid = state.alloc.group();
    const leftover = {
      id: state.alloc.tab(), windowId: state.userWindowId,
      url: "https://x.com/home", active: false, groupId: gid,
    };
    state.tabs.set(leftover.id, leftover);
    state.groups.set(gid, { id: gid, title: "Pi Agent", color: "blue", collapsed: false, windowId: state.userWindowId });
    const userTabsBefore = [...state.tabs.values()].filter((t) => t.windowId === state.userWindowId).length;

    // tab.new was the path that actually did this: it chose the window by matching ANY group titled
    // "Pi Agent" (params.groupTitle || PI_GROUP_NAME), so the leftover above captured it.
    const opened = await w.dispatch("tab.new", { url: "https://pi.test/new-tab", sessionKey: "session:fresh" });
    const userTabsAfter = [...state.tabs.values()].filter((t) => t.windowId === state.userWindowId).length;
    ok(opened.tab.windowId !== state.userWindowId,
      "generic-group: tab.new did NOT open in the user's window");
    ok(userTabsAfter === userTabsBefore,
      "generic-group: the user's window gained no tabs");
    ok(state.tabs.has(leftover.id) && state.tabs.get(leftover.id).groupId === gid,
      "generic-group: the leftover grouped tab was left exactly as it was");
  }

  // ===== An explicit "a window of Pi's own" must NEVER fall back to a tab in the user's window. =====
  // Reported live: the user chose Pi's own window, the window creation was refused, the shared-tab
  // fallback silently ran instead, and Pi ended up working in their browser — the opposite of the choice
  // they had just made, with nothing said. The fallback stays for the implicit case (tested above); it is
  // forbidden when the user asked for an isolated window.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withWindows: false }));
    const tabsBefore = state.tabs.size;
    await throwsWith(
      () => w.dispatch("window.select", { windowId: null, sessionKey: SK }),
      /will not put its tab in one of yours/,
      "own-window-strict: refuses instead of quietly using the user's window",
    );
    ok(state.tabs.size === tabsBefore, "own-window-strict: no tab was created anywhere");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "own-window-strict: user tabs untouched");
  }

  // ===== a stale session group in the USER's window must not capture a new target. =====
  // Shipped three times over before this was found. page.navigate adds a session group title, and
  // createAutomationTarget inherited THAT GROUP'S WINDOW — from any window in the browser. A leftover
  // group in a window the user owns therefore became the place Pi opened its tab, which is exactly the
  // "you used my browser again" report. Only a window PI created may be inherited.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const gid = state.alloc.group();
    const leftover = {
      id: state.alloc.tab(), windowId: state.userWindowId,
      url: "https://x.com/home", active: false, groupId: gid,
    };
    state.tabs.set(leftover.id, leftover);
    state.groups.set(gid, {
      id: gid, title: "Pi Session: something-old", color: "blue", collapsed: false, windowId: state.userWindowId,
    });
    const userTabsBefore = [...state.tabs.values()].filter((t) => t.windowId === state.userWindowId).length;

    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/after-stale-group", waitUntilLoad: false,
      sessionKey: SK, sessionGroupTitle: "Pi Session: something-old", joinSessionGroup: true,
    });
    const userTabsAfter = [...state.tabs.values()].filter((t) => t.windowId === state.userWindowId).length;
    ok(nav.windowId !== state.userWindowId, "stale-group: the target was NOT created in the user's window");
    ok(userTabsAfter === userTabsBefore, "stale-group: the user's window gained no tabs");
    ok(state.tabs.get(nav.id).windowId === nav.windowId, "stale-group: the automation tab is what moved");
  }

  // ===== A group in a window PI created is inherited even when its title is the generic one. =====
  // The old discriminator compared the group title against PI_GROUP_NAME, and in this fork
  // sessionGroupTitle always returns exactly PI_GROUP_NAME, so that comparison was always false: the
  // ownership check behind it never ran and a session with an existing Pi-created window churned a new
  // one. The title says nothing about who owns the window; the recorded window id does.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const seed = await w.dispatch("page.navigate", {
      url: "https://pi.test/seed", waitUntilLoad: false, sessionKey: "session:alpha",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(seed.windowId !== state.userWindowId, "owned-group: seed target is a window Pi created");
    const seedGroupId = state.tabs.get(seed.id).groupId;
    ok(typeof seedGroupId === "number" && seedGroupId >= 0, "owned-group: seed tab joined a 'Pi Agent' group");
    const windowsBefore = state.windows.size;

    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/reuse", waitUntilLoad: false, sessionKey: "session:beta",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(nav.windowId === seed.windowId, "owned-group: a 'Pi Agent' group in Pi's own window was inherited instead of churning a new window");
    ok(state.windows.size === windowsBefore, "owned-group: no new window was created");
    ok(nav.groupId === seedGroupId, "owned-group: the new target joined the existing group in that window");
    ok(nav.windowId !== state.userWindowId, "owned-group: still not the user's window");
  }

  // ===== Ownership evidence must outlive the session that created the Pi window. The creating session
  // is cleaned up while another session's tab keeps the window open; a third session must still reuse
  // it. Keying ownership off per-session records made that check refuse the live window and churn a
  // replacement. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const alpha = await w.dispatch("page.navigate", {
      url: "https://pi.test/alpha", waitUntilLoad: false, sessionKey: "session:alpha",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    const beta = await w.dispatch("page.navigate", {
      url: "https://pi.test/beta", waitUntilLoad: false, sessionKey: "session:beta",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(beta.windowId === alpha.windowId, "owner-survives: beta inherited alpha's Pi window");
    await w.dispatch("automation.cleanup", { sessionKey: "session:alpha" });
    ok(state.windows.has(alpha.windowId), "owner-survives: beta's tab keeps the Pi window open");

    const windowsBefore = state.windows.size;
    const gamma = await w.dispatch("page.navigate", {
      url: "https://pi.test/gamma", waitUntilLoad: false, sessionKey: "session:gamma",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(gamma.windowId === alpha.windowId, "owner-survives: a new session still reuses the live Pi window");
    ok(state.windows.size === windowsBefore, "owner-survives: no replacement window was churned");
  }

  // ===== ...and after the creating session is gone, the surviving Pi window is still reused WITHOUT
  // attempting a window create at all, so a refused windows.create cannot turn a working setup into an
  // error (the failure mode when ownership lived only in the creating session's record). =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    const w = loadWorker(chrome);
    const alpha = await w.dispatch("page.navigate", {
      url: "https://pi.test/alpha", waitUntilLoad: false, sessionKey: "session:alpha",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    await w.dispatch("page.navigate", {
      url: "https://pi.test/keeper", waitUntilLoad: false, sessionKey: "session:keeper",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    await w.dispatch("automation.cleanup", { sessionKey: "session:alpha" });
    ok(state.windows.has(alpha.windowId), "reuse-no-create: the keeper's tab keeps the Pi window open");

    let createAttempts = 0;
    chrome.windows.create = async () => { createAttempts += 1; throw new Error("window creation refused"); };

    let gamma = null;
    try {
      gamma = await w.dispatch("page.navigate", {
        url: "https://pi.test/gamma", waitUntilLoad: false, sessionKey: "session:gamma",
        joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
      });
    } catch {
      // Asserted below: with a live Pi window this must not throw.
    }
    ok(gamma !== null, "reuse-no-create: a live Pi window prevents the refused-create error");
    ok(gamma?.windowId === alpha.windowId, "reuse-no-create: the live Pi window was reused");
    ok(createAttempts === 0, "reuse-no-create: no window creation was attempted");
  }

  // ===== ...and even when no session record names the window at all: a user tab moved into it keeps
  // it alive, and the persisted window registry is the only remaining ownership evidence. window.list
  // must agree that it is Pi's. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const alpha = await w.dispatch("page.navigate", {
      url: "https://pi.test/alpha", waitUntilLoad: false, sessionKey: "session:alpha",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    const windowId = alpha.windowId;
    const groupId = state.tabs.get(alpha.id).groupId;
    // The user drags one of their own tabs into the Pi window (and its group), so the window outlives
    // every Pi-owned tab.
    const guestId = state.alloc.tab();
    state.tabs.set(guestId, { id: guestId, windowId, url: "https://example.com/user-tab", active: false, groupId });
    await w.dispatch("automation.cleanup", { sessionKey: "session:alpha" });
    ok(!state.tabs.has(alpha.id), "owner-gone: Pi's tab was cleaned up");
    ok(state.windows.has(windowId), "owner-gone: the user's moved-in tab keeps the window open");

    const report = await w.dispatch("window.list", { sessionKey: "session:beta" });
    const listed = (report.windows || []).find((win) => win.windowId === windowId);
    ok(listed && listed.ownedByPi === true, "owner-gone: window.list still marks the window as Pi's from the registry alone");

    const windowsBefore = state.windows.size;
    const beta = await w.dispatch("page.navigate", {
      url: "https://pi.test/beta", waitUntilLoad: false, sessionKey: "session:beta",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(beta.windowId === windowId, "owner-gone: the registry still recognizes the Pi window");
    ok(state.windows.size === windowsBefore, "owner-gone: no new window was created");
  }

  // ===== Query order is not evidence: a stale "Pi Agent" group in one of the user's windows must not
  // shadow the live Pi group, whichever Chrome lists first. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const staleGroupId = state.alloc.group();
    const stale = { id: state.alloc.tab(), windowId: state.userWindowId, url: "https://x.com/home", active: false, groupId: staleGroupId };
    state.tabs.set(stale.id, stale);
    state.groups.set(staleGroupId, { id: staleGroupId, title: "Pi Agent", color: "blue", collapsed: false, windowId: state.userWindowId });

    const alpha = await w.dispatch("page.navigate", {
      url: "https://pi.test/alpha", waitUntilLoad: false, sessionKey: "session:alpha",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(alpha.windowId !== state.userWindowId, "stale-first: alpha's target is not in the user's window");
    const windowsBefore = state.windows.size;

    const beta = await w.dispatch("page.navigate", {
      url: "https://pi.test/beta", waitUntilLoad: false, sessionKey: "session:beta",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(beta.windowId === alpha.windowId, "stale-first: the live Pi group won over the stale user-window group");
    ok(state.windows.size === windowsBefore, "stale-first: no replacement window was churned");
  }

  // ===== createAutomationTarget must hydrate by itself: a direct caller with a cold map must still
  // recognize a persisted Pi window and reuse it instead of silently churning a new one. =====
  {
    const state = makeChromeState();
    const w1 = loadWorker(makeChrome(state, { withTabGroups: true }));
    const seed = await w1.dispatch("page.navigate", {
      url: "https://pi.test/seed-hydrate", waitUntilLoad: false, sessionKey: "session:alpha",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(Array.isArray(state.storage.piChromeCreatedWindowIds), "hydrate-direct: Pi-created windows are persisted");

    const w2 = loadWorker(makeChrome(state, { withTabGroups: true })); // SW restart: fresh, cold maps
    const windowsBefore = state.windows.size;
    const tab = await w2.createAutomationTarget("session:beta", "Pi Agent");
    ok(tab.windowId === seed.windowId, "hydrate-direct: reuses the persisted Pi window without a prior resolve");
    ok(state.windows.size === windowsBefore, "hydrate-direct: no new window was created");
  }

  // ===== The live two-about:blank report resolved by recorded identity: when a selector matches both
  // Pi's own blank automation target and a blank tab the user opened, the session's recorded target
  // wins. The selector is a HINT; the setting is the truth. Before this, `tabs.find` picked whichever
  // blank tab Chrome listed first (the user's), so chrome_navigate and chrome_evaluate could end up on
  // different pages. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const userBlank = { id: state.alloc.tab(), windowId: state.userWindowId, url: "about:blank", active: true, groupId: -1 };
    state.tabs.set(userBlank.id, userBlank);
    const piTarget = await w.getOrCreateAutomationTarget(SK);
    ok(piTarget.windowId !== state.userWindowId, "two-blank: Pi's target is in Pi's own window");
    ok(piTarget.url === "about:blank#pi-chrome", "two-blank: the automation target is created at the marked url");
    const nav = await w.dispatch("page.navigate", {
      urlIncludes: "about:blank", url: "https://pi.test/blank-pick", waitUntilLoad: false, sessionKey: SK,
    });
    ok(nav.id === piTarget.id, "two-blank: a urlIncludes hint matching Pi's own target resolves by recorded identity, not first match");
    ok(state.tabs.get(userBlank.id).url === "about:blank", "two-blank: the user's blank tab was not navigated");
  }

  // ===== A guest target (the user chose their window) that the user drags into another window must be
  // retired and rebuilt in the window the setting names — not followed, and not replaced with a
  // brand-new Pi window. Before the record kept the chosen window, a moved guest tab was not even
  // detected, so the next action drove it wherever the user dropped it. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const otherWindowId = state.alloc.window();
    state.windows.set(otherWindowId, { id: otherWindowId });
    const otherTab = { id: state.alloc.tab(), windowId: otherWindowId, url: "https://example.com/elsewhere", active: false, groupId: -1 };
    state.tabs.set(otherTab.id, otherTab);

    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK });
    const guestId = selected.tabId;
    ok(state.tabs.get(guestId).windowId === state.userWindowId, "guest-moved: the guest target starts in the chosen window");
    // The user drags Pi's tab into their other window.
    state.tabs.get(guestId).windowId = otherWindowId;

    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/guest-moved", waitUntilLoad: false, sessionKey: SK });
    ok(nav.windowId === state.userWindowId, "guest-moved: the replacement target is rebuilt in the window the setting names");
    ok(nav.id !== guestId, "guest-moved: the moved tab was retired, not followed");
    ok(!state.tabs.has(guestId), "guest-moved: the moved guest tab is closed");
    ok(state.tabs.get(nav.id).windowId === state.userWindowId, "guest-moved: the new target is where it claims to be");
    ok(state.tabs.has(otherTab.id), "guest-moved: the other window's tab is untouched");
  }

  // ===== A guest tab the user closes (the window stays open) is rebuilt in the same chosen window,
  // joining that window's same-titled "Pi Agent" group — not the group in a Pi-created window. The
  // Pi-created group is seeded FIRST so tabGroups.query order favours it: only the recorded setting
  // may decide. Before, the chosen window was only a runtime hint: the recorded target's window was
  // forgotten for guest tabs, so the replacement was a brand-new Pi window — the user's choice
  // silently lost. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const seed = await w.dispatch("page.navigate", {
      url: "https://pi.test/seed-group", waitUntilLoad: false, sessionKey: "session:seed",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    const seedGroupId = seed.groupId;
    const selected = await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK });
    const guestId = selected.tabId;
    const userGroupId = state.tabs.get(guestId).groupId;
    ok(typeof userGroupId === "number" && userGroupId >= 0 && userGroupId !== seedGroupId, "guest-recreate: the user's window has its own same-titled group");
    state.tabs.delete(guestId); // the user closes Pi's tab; the window stays open
    const windowsBefore = state.windows.size;
    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/guest-recreate", waitUntilLoad: false, sessionKey: SK,
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(nav.windowId === state.userWindowId, "guest-recreate: the replacement target is created in the window the user chose");
    ok(nav.groupId === userGroupId, "guest-recreate: it joins the group in the chosen window, not the Pi-window group");
    ok(nav.id !== guestId, "guest-recreate: a fresh tab was created");
    ok(state.windows.size === windowsBefore, "guest-recreate: no new window was created");
    ok(state.tabs.get(seed.id).groupId === seedGroupId, "guest-recreate: the Pi-window group was not moved or renamed");
  }

  // ===== The chosen user window closed: FAIL LOUDLY naming /chrome window, never silently pick another
  // window. Before, the dead choice was forgotten and Pi opened a fresh window of its own — the user's
  // choice silently replaced by a different workspace. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    await w.dispatch("window.select", { windowId: state.userWindowId, sessionKey: SK });
    // The user closes the whole window (Chrome closes its tabs with it).
    state.windows.delete(state.userWindowId);
    for (const [tid, t] of [...state.tabs]) if (t.windowId === state.userWindowId) state.tabs.delete(tid);
    const windowsBefore = state.windows.size;
    await throwsWith(
      () => w.dispatch("page.navigate", { url: "https://pi.test/window-gone", waitUntilLoad: false, sessionKey: SK }),
      /\/chrome window/,
      "window-gone: fails with an actionable /chrome window message instead of choosing another window",
    );
    ok(state.windows.size === windowsBefore, "window-gone: no replacement window was created");
    ok(state.windows.size === 0, "window-gone: the browser has no windows left");
    await throwsWith(
      () => w.dispatch("page.navigate", { url: "https://pi.test/window-gone-2", waitUntilLoad: false, sessionKey: SK }),
      /\/chrome window/,
      "window-gone: a retry still refuses",
    );
    const recovered = await w.dispatch("window.select", { windowId: null, sessionKey: SK });
    ok(typeof recovered.windowId === "number" && state.windows.has(recovered.windowId), "window-gone: /chrome window own recovers");
    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/window-gone-3", waitUntilLoad: false, sessionKey: SK });
    ok(nav.windowId === recovered.windowId, "window-gone: the recovered window is the workspace");
  }

  // ===== Two Pi-created windows, each with a same-titled "Pi Agent" group: the session's recorded
  // window decides, never chrome.tabGroups.query order. Before, a recreated target joined whichever
  // owned group the query listed first and moved the session into the wrong window. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const alpha = await w.dispatch("page.navigate", {
      url: "https://pi.test/alpha", waitUntilLoad: false, sessionKey: "session:alpha",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    const windowA = alpha.windowId;
    const groupA = alpha.groupId;
    const betaSel = await w.dispatch("window.select", { windowId: null, fresh: true, sessionKey: "session:beta", groupTitle: "Pi Agent" });
    const windowB = betaSel.windowId;
    const betaTabId = betaSel.tabId;
    await w.dispatch("tab.group", { targetId: String(betaTabId), groupTitle: "Pi Agent", sessionKey: "session:beta" });
    const groupB = state.tabs.get(betaTabId).groupId;
    ok(windowB !== windowA && groupB !== groupA, "multi-pi-window: two Pi windows with same-titled groups exist");
    ok(state.groups.get(groupA).title === "Pi Agent" && state.groups.get(groupB).title === "Pi Agent", "multi-pi-window: group titles collide");

    // The user closes Pi's tab in the second window; the window itself stays.
    state.tabs.delete(betaTabId);
    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/beta-again", waitUntilLoad: false, sessionKey: "session:beta",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(nav.windowId === windowB, "multi-pi-window: the session's recorded window wins over tabGroups.query order");
    ok(nav.groupId === groupB, "multi-pi-window: the replacement joins the group in the session's window");
    ok(nav.windowId !== state.userWindowId, "multi-pi-window: still not the user's window");
  }

  // ===== Two same-titled groups, one in the user's window and one in Pi's: a fresh session (auto)
  // must land in Pi's window and join Pi's group; the user's leftover group must never capture it. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const userGroupId = state.alloc.group();
    const userLeftover = { id: state.alloc.tab(), windowId: state.userWindowId, url: "https://x.com/home", active: false, groupId: userGroupId };
    state.tabs.set(userLeftover.id, userLeftover);
    state.groups.set(userGroupId, { id: userGroupId, title: "Pi Agent", color: "blue", collapsed: false, windowId: state.userWindowId });
    const seed = await w.dispatch("page.navigate", {
      url: "https://pi.test/seed", waitUntilLoad: false, sessionKey: "session:seed",
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/fresh", waitUntilLoad: false, sessionKey: SK,
      joinSessionGroup: true, sessionGroupTitle: "Pi Agent",
    });
    ok(nav.windowId === seed.windowId, "two-groups: the fresh session landed in Pi's own window");
    ok(nav.groupId === seed.groupId, "two-groups: it joined Pi's group, not the user's same-titled group");
    ok(nav.groupId !== userGroupId, "two-groups: the user's group was not chosen");
    ok(state.tabs.get(userLeftover.id).groupId === userGroupId, "two-groups: the user's group and tab are untouched");
  }

  // ===== auto / no explicit choice: the first action creates the workspace window, and later actions
  // stay there even while the user works elsewhere. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const first = await w.dispatch("page.navigate", { url: "https://pi.test/auto-1", waitUntilLoad: false, sessionKey: SK });
    ok(first.windowId !== state.userWindowId, "auto: the first action created Pi's own window");
    // The user focuses their window and opens another tab there.
    state.userArticle.active = true;
    const userNew = { id: state.alloc.tab(), windowId: state.userWindowId, url: "https://example.com/another", active: true, groupId: -1 };
    state.tabs.set(userNew.id, userNew);
    const second = await w.dispatch("page.navigate", { url: "https://pi.test/auto-2", waitUntilLoad: false, sessionKey: SK });
    ok(second.id === first.id && second.windowId === first.windowId, "auto: later actions stay in the workspace Pi created");
    ok(state.tabs.get(userNew.id).url === "https://example.com/another", "auto: the user's new tab was never adopted");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
