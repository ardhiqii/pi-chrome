const BRIDGE_URL = "http://127.0.0.1:17318";
const CLIENT_NAME = `Pi Chrome Connector ${chrome.runtime.id}`;
const POLL_ERROR_BACKOFF_MS = 2000;
// Abort deadline for one /next long poll. The bridge holds /next open for up to 25s
// (`waitForCommand(25_000, ...)` in extensions/chrome-profile-bridge/index.ts), so this must stay
// comfortably above that hold. 45s leaves a 20s margin: a healthy long poll must never be aborted
// by a scheduler/GC/network hiccup, because a false abort discards the command that was in flight.
// A zombie socket still recovers on its own in ~47s (45s deadline + 2s backoff) instead of parking
// forever. The guarantee is time-to-first-byte, not whole response: the timer is cleared as soon as
// the fetch settles, before response.json() reads the body.
const POLL_ABORT_MS = 45_000;
// Abort deadline for the /result POST. /result is a short request, but a half-open bridge socket
// parks it forever too, and handleCommand awaits it from inside pollLoop's while loop.
const RESULT_ABORT_MS = 10_000;
// Throttle for the aborted-request warning in pollLoop so a dead bridge cannot spam the console.
const ABORT_WARN_THROTTLE_MS = 60_000;
const DEFAULT_GROUP_COLOR = "blue";
const PI_GROUP_RE = /^Pi(\b|\s*-)/i;
// The tab-group title for every Pi-created group, in both the extension and the Pi side
// (index.ts `sessionGroupTitle`). "Pi" alone was ambiguous — it reads as the number pi — and it
// split Pi's own tabs across two differently-named groups in the same window.
const PI_GROUP_NAME = "Pi Agent";
// Initial URL of every automation target. It MUST stay exactly `about:blank`.
// Measured on Edge 123 with this extension's manifest (host_permissions `<all_urls>`):
//   - chrome.debugger.attach succeeds on exactly `about:blank`; `about:blank#pi-chrome` is refused
//     with `Cannot access contents of url "about:blank#pi-chrome". Extension manifest must request
//     permission to access this host.` (attachDebugger -> cdpRaw's `Chrome debugger attach failed
//     for tab N: ...`). A fragment therefore makes the target un-attachable and kills
//     page.evaluate/cdp.call/screenshot/input on a fresh automation tab, while page.navigate still
//     works because tabs.update never attaches (page.navigate only attaches when params.initScript
//     is set, via registerInitScript).
//   - chrome.scripting.executeScript is refused on ALL of about:blank, about:blank#pi-chrome and
//     data: URLs; a top-level about:blank the extension opened has an opaque origin, so even
//     <all_urls> does not cover it, and the refusal is `Cannot access contents of url
//     "about:blank". Extension manifest must request permission to access this host.` Scripting-only
//     actions (snapshot/inspect/console/network/probe and the DOM input fallbacks) therefore have a
//     CDP fallback; see executeScriptWithFallback.
// The #pi-chrome marker below is legacy-recognition evidence only; new targets are never marked.
const PI_CHROME_MARKER = "#pi-chrome";
const BLANK_AUTOMATION_URL = "about:blank";
const VALID_GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
const COMMAND_TIMEOUT_MS = 25_000;
const CDP_COMMAND_TIMEOUT_MS = 5_000;
const SCRIPTING_TIMEOUT_MS = 8_000;
const ATTACH_TIMEOUT_MS = 3_000;
// Gate for the best-effort focus-emulation command sent on every fresh debugger attach. Set to
// false to restore the pre-feature attach path (one less CDP round trip per fresh attach).
const FOCUS_EMULATION_ON_ATTACH = true;
// This connector can be installed in more than one browser and in more than one profile, and each
// install is a separate client as far as the bridge is concerned. Identify ourselves on every poll so
// the Pi side can report *which* browser and profile it is actually driving instead of assuming
// Chrome. Derived from the user agent because no extension API exposes the browser family.
const BROWSER_FAMILY = (() => {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/Brave\//.test(ua)) return "brave";
  if (/Vivaldi\//.test(ua)) return "vivaldi";
  if (/Chrome\//.test(ua)) return "chrome";
  return "unknown";
})();
// `chrome.storage.local` is per profile, so a generated id is stable within a profile and differs
// between two profiles of the same browser — which is exactly what distinguishes them to the bridge.
// Cached after the first read so a poll never costs an extra storage round trip.
let profileIdPromise;
function getProfileId() {
  profileIdPromise ??= (async () => {
    try {
      const stored = await chrome.storage.local.get("piProfileId");
      const existing = stored && stored.piProfileId;
      if (typeof existing === "string" && existing) return existing;
      const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
      await chrome.storage.local.set({ piProfileId: id });
      return id;
    } catch {
      // Storage unavailable: report no id rather than failing the poll.
      return "";
    }
  })();
  return profileIdPromise;
}
let polling = false;
let lastAbortWarnAt = 0;

// =================== pi-chrome automation target ownership ===================
// pi-chrome must never hijack the user's active tab. When a page/navigation action runs without
// an explicit target (targetId/urlIncludes/titleIncludes), we route it to an automation tab inside
// the window the user picked with /chrome window. Pi never creates a window, never uses the focused
// window, and never puts a tab in a window the user did not choose: with no saved choice and no
// per-session assignment, the action fails with a message naming /chrome window.
//
// Ownership is SESSION-SCOPED, keyed by the calling Pi session's `sessionKey` (forwarded on the
// wire). One Chrome extension / service worker brokers commands for *all* Pi sessions (see the
// client/server bridge in index.ts). The machine-wide default the user picks with /chrome window is
// inherited by every session that has no assignment of its own, so a new session does not have to
// choose again. The per-session map lets cleanup close exactly that session's tab — never another
// session's, never a user's, and never the chosen window itself.
//
// State is mirrored to chrome.storage.session so a service-worker restart (MV3 can suspend the
// worker at any time) re-hydrates ownership instead of orphaning the tab it already created.
// storage.session is cleared on browser restart; any tab restored by Chrome's session-restore is
// then untracked and simply left alone (we only ever close ids we still recognize as ours).
//
// A record's `windowId` is the session's WORKSPACE — the single source of truth for where Pi works —
// and `piWindow` says who created it: true for a window an earlier Pi build made, false for one of
// the user's that the session was pointed at (cleanup closes only Pi's tab in either case). The
// window id is kept even after the recorded tab is gone, so a replacement target is rebuilt in the
// same window, or the action fails naming it ("the chosen window was closed") instead of silently
// using a different one. Group titles, urls and query order are hints; they never decide the
// workspace.
const automationTargets = new Map(); // sessionKey -> { tabId?: number, windowId?: number, piWindow?: boolean }
// Window ids `chrome.windows.create` made for Pi in an earlier build, independent of any session
// record. Kept so `window.list` still recognizes legacy Pi windows and the picker never offers one.
// New builds never add to this set: there is no window-creation path left. Mirrored to
// storage.session like the target map. The set was originally the live-bug fix for "one dedicated Pi
// window for the whole machine": the per-session map alone was not ownership evidence because a
// session that INHERITS a Pi window need not record an id of its own.
const piCreatedWindowIds = new Set();
const DEFAULT_SESSION_KEY = "__default__";
const AUTOMATION_STORAGE_KEY = "piChromeAutomationTargets";
const PI_WINDOWS_STORAGE_KEY = "piChromeCreatedWindowIds";
// The newest machine-wide pick THIS worker has seen, mirrored to storage.session so it survives a worker
// restart. The Pi side is the one writer and forwards `preferredWindow` on every command it sends, but a
// pick-less caller (the measured hand-built POST /command with no sessionKey, and any agent that does not
// read ~/.pi/agent/pi-chrome.json) carries nothing — without this mirror, such a caller had no pick at all
// and the extension could not know the window the user chose. It is not a second source of truth: R1 still
// makes the pick on the wire (the file's content) the decision, and this only replays the last one seen.
const PREFERRED_WINDOW_STORAGE_KEY = "piChromePreferredWindow";
let preferredWindowPick = null; // { windowId, at?, key? }
let preferredWindowHydrated;
let automationHydrated;
const sessionTabs = new Map(); // sessionKey -> Map<tabId, { created: boolean, groupId?: number }>
const SESSION_TABS_STORAGE_KEY = "piChromeSessionTabs";
let sessionTabsReady;
let sessionTabsWrite = Promise.resolve();

function sessionKeyOf(params) {
  return params && typeof params.sessionKey === "string" && params.sessionKey
    ? params.sessionKey
    : DEFAULT_SESSION_KEY;
}

// Re-hydrate the in-memory ownership map from storage.session once per worker lifetime. Best
// effort: storage may be unavailable on old Chrome, and a failure just means we may create a
// fresh window (a harmless orphan) rather than reusing one.
async function hydrateAutomationTargets() {
  if (automationHydrated) return automationHydrated;
  automationHydrated = (async () => {
    try {
      const stored = await chrome.storage?.session?.get?.(AUTOMATION_STORAGE_KEY);
      const saved = stored && stored[AUTOMATION_STORAGE_KEY];
      if (saved && typeof saved === "object") {
        for (const [key, value] of Object.entries(saved)) {
          // A record whose tab is gone still carries the session's chosen window, so hydrate it too.
          if (!value || (typeof value.tabId !== "number" && typeof value.windowId !== "number")) continue;
          // Legacy records predate the piWindow flag; before it existed a numeric windowId was only
          // written after `chrome.windows.create`, so a numeric id with no flag is Pi-window evidence.
          const piWindow = value.piWindow === true || (value.piWindow !== false && typeof value.windowId === "number");
          automationTargets.set(key, {
            windowId: typeof value.windowId === "number" ? value.windowId : undefined,
            tabId: typeof value.tabId === "number" ? value.tabId : undefined,
            piWindow,
            pickedAt: typeof value.pickedAt === "number" && Number.isFinite(value.pickedAt) ? value.pickedAt : undefined,
          });
          if (piWindow && typeof value.windowId === "number") piCreatedWindowIds.add(value.windowId);
        }
      }
    } catch {
      // Ignore: treat as "no persisted state".
    }
    try {
      const storedIds = await chrome.storage?.session?.get?.(PI_WINDOWS_STORAGE_KEY);
      const ids = storedIds && storedIds[PI_WINDOWS_STORAGE_KEY];
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "number") piCreatedWindowIds.add(id);
    } catch {
      // Ignore: treat as "no persisted state".
    }
  })();
  return automationHydrated;
}

// Re-hydrate the remembered machine-wide pick once per worker lifetime, so a pick-less command after an
// MV3 worker restart still resolves into the window the user chose (the measured pick-less caller case).
// Best effort like hydrateAutomationTargets: storage may be unavailable, and a failure only means a
// pick-less caller gets the /chrome window refusal instead of the remembered window — never a wrong window.
async function hydratePreferredWindowPick() {
  if (preferredWindowHydrated) return preferredWindowHydrated;
  preferredWindowHydrated = (async () => {
    try {
      const stored = await chrome.storage?.session?.get?.(PREFERRED_WINDOW_STORAGE_KEY);
      const saved = stored && stored[PREFERRED_WINDOW_STORAGE_KEY];
      if (!saved || typeof saved !== "object" || !Number.isInteger(saved.windowId)) return;
      // Never clobber a live in-memory pick with an older stored one. Command dispatch is serialized
      // today, so this cannot happen yet, but a second entry point (chrome.runtime.onMessage) would make
      // it a real race, and losing a fresh pick to hydration would silently move the whole machine.
      if (preferredWindowPick) return;
      preferredWindowPick = {
        windowId: saved.windowId,
        at: typeof saved.at === "number" && Number.isFinite(saved.at) ? saved.at : undefined,
        key: typeof saved.key === "string" && saved.key ? saved.key : undefined,
      };
    } catch {
      // Ignore: treat as "no remembered pick".
    }
  })();
  return preferredWindowHydrated;
}

async function hydrateSessionTabs() {
  if (!sessionTabsReady) sessionTabsReady = (async () => {
    try {
      const stored = await chrome.storage?.session?.get?.(SESSION_TABS_STORAGE_KEY);
      for (const [key, entries] of Object.entries(stored?.[SESSION_TABS_STORAGE_KEY] || {})) {
        if (!Array.isArray(entries)) continue;
        const tabs = new Map();
        for (const entry of entries) {
          if (!entry || !Number.isInteger(entry.tabId) || entry.tabId < 0) continue;
          if (entry.created === true) tabs.set(entry.tabId, { created: true });
          else if (entry.created === false && Number.isInteger(entry.groupId) && entry.groupId >= 0) {
            tabs.set(entry.tabId, { created: false, groupId: entry.groupId });
          }
        }
        if (tabs.size) sessionTabs.set(key, tabs);
      }
    } catch {
      // Missing ownership must leave tabs alone, not guess ownership from group names.
    }
  })();
  return sessionTabsReady;
}

function persistSessionTabs() {
  // Serialize writes and construct each snapshot when its turn starts.
  sessionTabsWrite = sessionTabsWrite.then(async () => {
    const saved = Object.fromEntries([...sessionTabs].map(([key, tabs]) => [
      key, [...tabs].map(([tabId, record]) => ({ tabId, ...record })),
    ]));
    await chrome.storage?.session?.set?.({ [SESSION_TABS_STORAGE_KEY]: saved });
  }).catch(() => {});
  return sessionTabsWrite;
}

async function trackSessionTab(sessionKey, tabId, created, groupId) {
  await Promise.all([hydrateSessionTabs(), hydrateAutomationTargets()]);
  if (!Number.isInteger(tabId)) return;
  if (!created) {
    if (!Number.isInteger(groupId) || groupId < 0 || isPiChromeOwnedTarget(tabId)) return;
    if ([...sessionTabs.values()].some((tabs) => tabs.get(tabId)?.created)) return;
  }
  let tabs = sessionTabs.get(sessionKey);
  if (!tabs) sessionTabs.set(sessionKey, tabs = new Map());
  tabs.set(tabId, created ? { created: true } : { created: false, groupId });
  await persistSessionTabs();
}

async function cleanupSessionTabs(sessionKey) {
  await hydrateSessionTabs();
  const automation = await cleanupAutomationTarget(sessionKey);
  const tabs = sessionTabs.get(sessionKey);
  let closedCreatedTabs = 0;
  let ungroupedAdoptedTabs = 0;
  for (const [tabId, record] of [...(tabs || [])]) {
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && record.created) {
        await chrome.tabs.remove(tabId);
        closedCreatedTabs++;
      } else if (tab && tab.groupId === record.groupId) {
        await chrome.tabs.ungroup(tabId);
        ungroupedAdoptedTabs++;
      }
      tabs.delete(tabId);
    } catch {
      // Retain failed operations for a later cleanup; never report them as completed.
    }
  }
  if (tabs && !tabs.size) sessionTabs.delete(sessionKey);
  await persistSessionTabs();
  return { ...automation, closedCreatedTabs, ungroupedAdoptedTabs };
}

async function persistAutomationTargets() {
  try {
    const obj = {};
    for (const [key, value] of automationTargets) {
      obj[key] = {
        tabId: typeof value.tabId === "number" ? value.tabId : null,
        windowId: typeof value.windowId === "number" ? value.windowId : null,
        piWindow: value.piWindow === true,
        // When a human chose this window with /chrome window. Reporting/compat only: under the one-writer
        // rule the machine-wide pick supersedes a record regardless of this stamp (see
        // supersededByMachinePick), so this must never be read as "this session outranks the pick".
        pickedAt: typeof value.pickedAt === "number" ? value.pickedAt : null,
      };
    }
    await chrome.storage?.session?.set?.({ [AUTOMATION_STORAGE_KEY]: obj });
  } catch {
    // Ignore: persistence is an optimization, not a correctness requirement.
  }
}

// Mirror the newest pick this worker has seen to storage.session. Best effort by the same rule as
// persistAutomationTargets: a storage failure must never fail the command that carried the pick, it only
// costs a later pick-less caller the remembered window. `at`/`key` are stored verbatim when present so a
// restart remembers which connector the pick was made in, not just the id.
async function persistPreferredWindowPick(pick) {
  try {
    await chrome.storage?.session?.set?.({
      [PREFERRED_WINDOW_STORAGE_KEY]: {
        windowId: pick.windowId,
        at: typeof pick.at === "number" ? pick.at : null,
        key: typeof pick.key === "string" && pick.key ? pick.key : null,
      },
    });
  } catch {
    // Ignore: persistence is an optimization, not a correctness requirement.
  }
}

// True when `windowId` names a window `chrome.windows.create` created for Pi by an earlier build. Deliberately independent
// of the per-session target map: a session that only inherits a Pi window, or the creating session
// itself once it is cleaned up or retargeted, must not make a live Pi window unrecognizable.
function isPiOwnedWindow(windowId) {
  return typeof windowId === "number" && piCreatedWindowIds.has(windowId);
}

// The connector key of THIS profile as the bridge names connectors (`${browser}:${profileId}`). A window
// pick is made for the profile the user was looking at, and window ids are per profile — the same number
// in another browser or profile is a DIFFERENT window — so a pick carrying another profile's key is not
// ours to act on. Cached: one storage read per worker lifetime.
let selfClientKeyPromise;
function selfClientKey() {
  selfClientKeyPromise ??= (async () => {
    const profileId = await getProfileId().catch(() => "");
    // No id (storage unavailable): the caller must accept the pick rather than refuse to work at all.
    return profileId ? `${BROWSER_FAMILY}:${profileId}` : "";
  })();
  return selfClientKeyPromise;
}

// The machine-wide window the user chose with /chrome window, as it arrived on this command: the id they
// picked, when they picked it, and which connector they picked it in. Every field is optional and
// validated here — a bad value must never decide where Pi works. Returns null when the pick is not
// usable here, which callers treat as "no pick": a per-session assignment keeps working, and a session
// with none fails with the /chrome window message instead of guessing.
//
// The caller's pick is the file's content — Pi is the one writer and forwards it on every command — and a
// pick that carries THIS profile's connector key is also REMEMBERED (storage.session) for pick-less
// callers. An unkeyed pick still steers the command that carries it, but it is never remembered: the
// durable mirror is reserved for picks the Pi-side file attributes to this profile, so an unauthenticated
// POST cannot pin every later pick-less command to a window the user did not choose. When the command
// carries no pick at all, the remembered one is used after the same connector-key check, which is what lets
// the measured hand-built POST /command (no sessionKey, no file access) work in the user's window instead
// of having no pick and refusing, or worse, being pinned by whatever record its bucket happens to hold.
async function machineWindowPick(params) {
  await hydratePreferredWindowPick();
  const windowId = params && typeof params.preferredWindow === "number" && Number.isInteger(params.preferredWindow)
    ? params.preferredWindow
    : null;
  if (windowId === null) {
    // No pick on this command: the remembered one is the only witness left. Its key is checked the same
    // way, so a pick remembered in ANOTHER browser profile is never replayed as this profile's window id
    // (window ids are per profile — the same number names a different window).
    if (!preferredWindowPick) return null;
    const own = await selfClientKey();
    if (preferredWindowPick.key && own && own !== preferredWindowPick.key) return null;
    return { windowId: preferredWindowPick.windowId, at: preferredWindowPick.at };
  }
  const at = params && typeof params.preferredWindowAt === "number" && Number.isFinite(params.preferredWindowAt)
    ? params.preferredWindowAt
    : null;
  const key = params && typeof params.preferredWindowKey === "string" && params.preferredWindowKey
    ? params.preferredWindowKey
    : null;
  const own = await selfClientKey();
  if (key !== null) {
    // Either key unknown (no profile id, or a legacy pick without one) -> accept rather than refuse.
    if (own && own !== key) return null;
  }
  // A pick is USABLE for the command that carries it either way — that is the one-writer protocol, Pi
  // forwards the file's pick on every command — but only a pick carrying THIS profile's connector key may
  // become the durable machine-wide pick. The measured hand-built POST /command carries no key: before
  // this guard it overwrote the mirror and pinned every later pick-less command to a window the user did
  // not choose. A keyless pick must also not erase a previously keyed mirror, which would silently
  // disable the connector check the key exists for (a pick from another profile's file).
  const attributable = key !== null && Boolean(own) && key === own;
  if (attributable) {
    preferredWindowPick = { windowId, at, key };
    await persistPreferredWindowPick(preferredWindowPick);
  }
  return { windowId, at };
}

// A pick is only usable when its window is really open HERE. Checked before anything is retired: a stale
// pick (a window id from a browser session that has since ended) must fail loudly, not destroy the
// session's working tab and then fail.
async function pickWindowIsOpen(windowId) {
  if (typeof windowId !== "number") return false;
  if (!chrome.windows || typeof chrome.windows.get !== "function") return true; // tabs.create is the check
  return Boolean(await chrome.windows.get(windowId).catch(() => null));
}

// The machine-wide pick as it travels into the resolver from a command's params. Kept in one place so a
// new pick field cannot reach some paths and not others (the profile key did exactly that).
function machinePickParams(params) {
  return {
    preferredWindow: params ? params.preferredWindow : undefined,
    preferredWindowAt: params ? params.preferredWindowAt : undefined,
    preferredWindowKey: params ? params.preferredWindowKey : undefined,
  };
}

const SAVED_WINDOW_GONE =
  "pi-chrome will not silently use a different window, create one, or fall back to the focused window.";

// True when the machine-wide pick replaces this session's recorded workspace.
//
// ONE WRITER: the machine-wide pick is the ONLY thing that decides the workspace, so a record that
// points somewhere else always loses to it — timestamps are not consulted, in either direction. This is
// the measured failure the rule exists for: the worker's `__default__` bucket held
// {windowId: 720723708, pickedAt <newer than the user's pick 720723947>}, so the old "newer explicit pick
// wins" comparison let a record that happened to be written later outrank the window the user chose and
// window.list reported workingWindowId 720723708. Any timestamp ordering is the wrong test here: a
// later-written record is exactly what a rogue/hand-built caller (or a clock skew) produces, and no
// comparison can tell that apart from a legitimate pick. Records only MIRROR the pick — `pickedAt` is
// still written and reported for compat/reporting — but they never decide which window Pi works in.
function supersededByMachinePick(record, pick) {
  if (!pick || !record || typeof record.windowId !== "number") return false;
  return record.windowId !== pick.windowId;
}

// True when a tab recorded as a session's target is provably Pi's own, so closing it cannot lose user
// work. Used as a guard: a corrupted or hand-edited record must not turn a pick into "delete that tab id".
function isPiRemovableTarget(tab) {
  if (!tab || typeof tab.id !== "number") return false;
  if (isPiChromeOwnedTarget(tab.id)) return true; // recorded by a session (this one, before the rewrite)
  if (isPiMarkerTab(tab)) return true; // legacy #pi-chrome target
  return String(tab.url || "") === BLANK_AUTOMATION_URL; // a plain automation target
}

// The stronger predicate a machine-wide pick uses before it MOVES or CLOSES a tab. "A record names it" is
// not enough here: the record is the claim under test, and it cannot corroborate itself. Evidence that
// stands on its own: a plain about:blank target (how every automation tab starts), a legacy #pi-chrome
// marker, a window an earlier Pi build created for Pi, or a tab sitting in a "Pi Agent" group (Pi groups
// every page action it drives, so a live target is grouped). A tab that matches none of these is left
// exactly where it is and only the record is re-pointed — so a corrupt or hand-edited record cannot make a
// pick relocate or close one of the user's own tabs. The cost is bounded: Pi then opens a fresh target in
// the picked window and the unprovable tab stays where the user can see and close it.
async function isPiRelocatableTarget(tab) {
  if (!tab || typeof tab.id !== "number") return false;
  if (String(tab.url || "") === BLANK_AUTOMATION_URL) return true;
  if (isPiMarkerTab(tab)) return true;
  if (typeof tab.windowId === "number" && isPiOwnedWindow(tab.windowId)) return true;
  if (typeof tab.groupId === "number" && tab.groupId >= 0) {
    const group = await groupRecord(tab.groupId).catch(() => null);
    const title = group && typeof group.title === "string" ? group.title.trim() : "";
    if (title && PI_GROUP_RE.test(title)) return true;
  }
  return false;
}

// Heal a legacy marker target after it is adopted or moved: about:blank#pi-chrome cannot be attached (see
// BLANK_AUTOMATION_URL), and tabs.update needs no debugger. Only ever applied to a marker tab, which is
// always a blank page, so nothing of the user's is navigated away.
async function healMarkerTab(tab) {
  if (!tab || typeof tab.id !== "number" || !isPiMarkerTab(tab)) return tab;
  return (await chrome.tabs.update(tab.id, { url: BLANK_AUTOMATION_URL }).catch(() => null)) || tab;
}

// A cross-window move takes a tab out of its group (Chrome groups cannot span windows). Regroup it in the
// window it landed in, so Pi's tab stays visibly Pi's; cosmetic, so a failure is swallowed.
async function regroupMovedTarget(tab) {
  try {
    const live = await chrome.tabs.get(tab.id).catch(() => null);
    if (!live || typeof live.groupId !== "number" || live.groupId >= 0) return;
    await groupTab(live, PI_GROUP_NAME, DEFAULT_GROUP_COLOR);
  } catch {
    // Grouping is cosmetic; it must never fail the move.
  }
}

// Apply one machine-wide pick to a session's recorded workspace: MOVE the guest tab Pi was using into the
// picked window when it can be moved, and only close it when it provably cannot. Moving is deliberate —
// the tab holds real work (a half-filled form, a logged-in page an agent is mid-way through), and a pick
// must move Pi's workspace without throwing that away; it also removes Pi's presence from the window the
// user is leaving, which is the visible half of the bug. A tab we cannot prove is ours is never touched.
// Returns true when it changed the map.
async function retargetSupersededRecord(sessionKey, record, pick) {
  // The pick's window must be open before any tab is moved or closed for it. Every current caller checks
  // first and keeps its own actionable error/refusal, but this function is what moves and closes, so the
  // invariant lives here too: a future caller cannot relocate a tab into — or close one for — a window
  // that is not open.
  if (!(await pickWindowIsOpen(pick.windowId))) return false;
  const pickedAt = typeof pick.at === "number" ? pick.at : record.pickedAt;
  const tab = typeof record.tabId === "number" ? await chrome.tabs.get(record.tabId).catch(() => null) : null;
  const owned = tab ? await isPiRelocatableTarget(tab) : false;
  if (owned && tab.windowId !== pick.windowId) {
    const moved = await chrome.tabs.move(tab.id, { windowId: pick.windowId, index: -1 }).catch(() => null);
    if (moved && typeof moved.id === "number") {
      const healed = await healMarkerTab(moved);
      await regroupMovedTarget(healed);
      automationTargets.set(sessionKey, {
        windowId: pick.windowId,
        tabId: healed.id,
        piWindow: isPiOwnedWindow(pick.windowId),
        pickedAt,
      });
      return true;
    }
  } else if (owned && tab.windowId === pick.windowId) {
    // Already in the picked window: keep it, and keep the record honest about it.
    automationTargets.set(sessionKey, {
      windowId: pick.windowId,
      tabId: tab.id,
      piWindow: isPiOwnedWindow(pick.windowId),
      pickedAt,
    });
    return true;
  }
  // A tab that cannot be moved AND is provably Pi's alone is closed; a record naming anything else (a
  // corrupted or hand-edited one) is only re-pointed, because guessing there could move or close a user's
  // tab. Without a move, the record drops the id: the next action rebuilds in the picked window.
  if (owned) await chrome.tabs.remove(tab.id).catch(() => {});
  automationTargets.set(sessionKey, {
    windowId: pick.windowId,
    piWindow: isPiOwnedWindow(pick.windowId),
    pickedAt,
  });
  return true;
}

// True if `tabId` is a pi-chrome-owned automation tab. Pass `sessionKey` to check a specific
// session; omit it to check ownership across *any* session (used as a safety predicate so we
// never operate on a user-created tab). Never infers ownership from "active".
function isPiChromeOwnedTarget(tabId, sessionKey) {
  if (typeof tabId !== "number") return false;
  if (sessionKey !== undefined) {
    const t = automationTargets.get(sessionKey);
    return !!t && t.tabId === tabId;
  }
  for (const t of automationTargets.values()) if (t.tabId === tabId) return true;
  return false;
}

// Build the automation target for `sessionKey` in the window the session is allowed to work in.
// The user picks a window once with /chrome window; that choice is saved machine-wide as
// `preferredWindow` and inherited here by every session that has no assignment of its own. The
// per-session record wins when it exists (an explicit pick inside this session), then the saved
// default, and nothing else: pi-chrome NEVER creates a window, NEVER falls back to the focused
// window, and NEVER moves into one of the user's uninvited. When neither source names a live
// window, this fails with an actionable error naming /chrome window instead of guessing.
//
// The group title is NOT evidence and does not decide the window: in this fork the session group
// title is always the generic "Pi Agent" (index.ts `sessionGroupTitle`), so matching it across
// every window let a leftover group in a window the user owns capture a target recreated after an
// extension reload (the target lives in chrome.storage.session, which an extension reload clears).
// Groups are chosen later, scoped to the target's own window, by groupTab.
async function createAutomationTarget(sessionKey, groupTitle, { preferredWindow, preferredWindowAt, preferredWindowKey } = {}) {
  // Hydrate here rather than relying on callers: the workspace is decided from hydrated state, and a
  // direct caller with a cold map would mistake a persisted assignment for "no assignment".
  await hydrateAutomationTargets();
  const pick = await machineWindowPick({ preferredWindow, preferredWindowAt, preferredWindowKey });
  let record = automationTargets.get(sessionKey);
  // A record the machine-wide pick supersedes is no longer this session's workspace. Retire its tab and
  // re-point it BEFORE the workspace is read from the record, so the pick decides where this action runs
  // — instead of the stale assignment silently winning because it happened to exist. The pick's window is
  // checked FIRST: a stale pick (an id from a browser session that has ended) must fail loudly, not move
  // the session out of a window it was working in and then fail.
  if (record && supersededByMachinePick(record, pick)) {
    if (!(await pickWindowIsOpen(pick.windowId))) {
      throw new Error(
        `The saved browser window ${pick.windowId} is no longer open. Run /chrome window to choose ` +
          `another window. ${SAVED_WINDOW_GONE}`,
      );
    }
    await retargetSupersededRecord(sessionKey, record, pick);
    await persistAutomationTargets();
    record = automationTargets.get(sessionKey);
    // The retarget MOVED the session's tab into the picked window (or re-pointed the record when there was
    // nothing to move). A live target that already sits in the picked window IS this session's workspace —
    // creating another tab here would churn a tab and orphan the one that just kept the agent's page.
    const survivor = record && typeof record.tabId === "number" ? await chrome.tabs.get(record.tabId).catch(() => null) : null;
    if (survivor && typeof survivor.windowId === "number" && survivor.windowId === pick.windowId) return survivor;
  }
  const recordedWindowId = record && typeof record.windowId === "number" ? record.windowId : null;
  if (recordedWindowId !== null) {
    // A live recorded tab in the recorded window IS this session's workspace: reuse it instead of creating
    // another one. That covers a supersede that just MOVED the tab here (the record names it already), and
    // any direct caller whose tab is alive — churning a tab would throw away the page it holds.
    const recordedTab = record && typeof record.tabId === "number" ? await chrome.tabs.get(record.tabId).catch(() => null) : null;
    if (recordedTab && typeof recordedTab.windowId === "number" && recordedTab.windowId === recordedWindowId) {
      return recordedTab;
    }
    const piWindow = record.piWindow === true || isPiOwnedWindow(recordedWindowId);
    // A recorded Pi window whose own tab is gone may still hold an unowned legacy marker from a
    // wiped record; adopt it instead of adding yet another tab to the shared window.
    if (piWindow) {
      const reusable = await findReusableOrphanAutomationTab(recordedWindowId);
      if (reusable) {
        // Heal the legacy marker URL before adopting. findReusableOrphanAutomationTab returns only
        // #pi-chrome tabs, and that URL cannot be attached (see BLANK_AUTOMATION_URL), so adopting
        // it unmodified would hand out the un-attachable target this change exists to remove.
        // tabs.update needs no debugger attach. If the update fails the tab is gone, so fall through
        // and create a fresh target instead of adopting a dead one.
        const healed = await healMarkerTab(reusable);
        if (healed && typeof healed.id === "number" && healed.id === reusable.id) {
          // Keep the session's own pick time: adopting a tab does not change who chose the window.
          automationTargets.set(sessionKey, { windowId: recordedWindowId, tabId: reusable.id, piWindow: true, pickedAt: record.pickedAt });
          await persistAutomationTargets();
          return healed;
        }
      }
    }
    // Creating the tab is also the existence check: Chrome rejects a windowId whose window is gone.
    const created = await chrome.tabs.create({ url: BLANK_AUTOMATION_URL, active: false, windowId: recordedWindowId }).catch((error) => error);
    if (created && typeof created.id === "number") {
      automationTargets.set(sessionKey, { windowId: recordedWindowId, tabId: created.id, piWindow, pickedAt: record.pickedAt });
      await persistAutomationTargets();
      return created;
    }
    // The window this session was told to use is gone. Never repair that by creating a window or
    // picking another one: the user has to choose, because a silent replacement is exactly how Pi
    // ended up working somewhere they did not choose.
    throw new Error(
      `The browser window ${recordedWindowId} this Pi session was told to use is gone (${String(created?.message || created)}). ` +
        `Run /chrome window to choose a window, then retry. pi-chrome will not silently pick a different ` +
        `window, create one, or fall back to the focused window.`,
    );
  }
  // No per-session assignment. Only the machine-wide pick may decide the workspace now — and only when it
  // is usable HERE. `pick` is null both when no window was chosen and when the pick belongs to ANOTHER
  // connector, whose window ids name a different window in this profile (or nothing at all); acting on its
  // id here would put Pi's tab in a window the user never chose. Absent or unusable, this refuses:
  // creating a window here is the exact behaviour this feature removed.
  if (!pick) {
    throw new Error(
      "No browser window has been chosen for Pi in this browser profile yet. Run /chrome window to pick " +
        "one of your open browser windows (the choice is saved for future sessions). pi-chrome will not " +
        "create a window, use the focused window, or put a tab in a window you did not choose.",
    );
  }
  // Check the saved window while the API is available, so a stale default fails with a message that
  // names the fix instead of a raw Chrome error from tabs.create. Where windows.get is unavailable, the
  // explicit-window tabs.create below is still the existence check. Either way the tab carries an
  // explicit windowId, so there is no path where Chrome picks the focused window for us.
  if (chrome.windows && typeof chrome.windows.get === "function") {
    const savedWindow = await chrome.windows.get(pick.windowId).catch(() => null);
    if (!savedWindow) {
      throw new Error(
        `The saved browser window ${pick.windowId} is no longer open. Run /chrome window to choose ` +
          `another window. ${SAVED_WINDOW_GONE}`,
      );
    }
  }
  const created = await chrome.tabs.create({ url: BLANK_AUTOMATION_URL, active: false, windowId: pick.windowId }).catch((error) => error);
  if (!created || typeof created.id !== "number") {
    throw new Error(
      `Chrome refused to open Pi's tab in window ${pick.windowId} (${String(created?.message || created)}). ` +
        `Run /chrome window to choose a window, then retry.`,
    );
  }
  automationTargets.set(sessionKey, { windowId: pick.windowId, tabId: created.id, piWindow: isPiOwnedWindow(pick.windowId), pickedAt: typeof pick.at === "number" ? pick.at : undefined });
  await persistAutomationTargets();
  return created;
}

// True when a tab carries the legacy Pi creation marker. Automation targets used to start at
// about:blank#pi-chrome; that URL is no longer created (see BLANK_AUTOMATION_URL — the debugger
// refuses to attach to it), but tabs an earlier build left behind still carry the marker, and it
// remains ownership evidence for windows Pi created back then. The marker survives an extension
// reload (which clears the in-memory registry) but not a navigation, which is why "Pi Agent"
// groups are checked as well.
function isPiMarkerTab(tab) {
  return Boolean(tab) && typeof tab.url === "string" && tab.url.includes(PI_CHROME_MARKER);
}

// The candidate set for "a window an earlier Pi build created", from an already-fetched browser
// snapshot. Used only for reporting (`window.list`) so the picker never offers one: new builds never
// create windows. A window qualifies when either of these holds:
//   - `chrome.windows.create` made it for Pi in an earlier build and the registry still remembers it
//     (same browser session; storage.session outlives service-worker restarts); the registry is
//     authority by construction, so even a user tab later dragged into that window does not revoke it;
//   - EVERY tab in it is a Pi tab — a legacy #pi-chrome marker tab or a member of a "Pi Agent"
//     group — and at least one piece of Pi evidence lives in it (a legacy marker tab or a "Pi
//     Agent" group),
//     covering a Pi window whose automation tab has navigated away.
// The all-Pi-tabs condition is what keeps a user's window out no matter how much Pi debris
// (leftover legacy marker tabs or "Pi Agent" groups) it holds: a dedicated window has no non-Pi tabs.
// Shared with `window.list` so the report states the same evidence it acts on.
function dedicatedPiWindowIds(windows, groups) {
  const ids = new Set();
  for (const id of piCreatedWindowIds) if (typeof id === "number") ids.add(id);
  if (!Array.isArray(windows)) return ids;
  const piGroupIds = new Set();
  const piGroupWindowIds = new Set();
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group || typeof group.windowId !== "number") continue;
    if (PI_GROUP_RE.test(String(group.title || ""))) {
      if (typeof group.id === "number") piGroupIds.add(group.id);
      piGroupWindowIds.add(group.windowId);
    }
  }
  for (const win of windows) {
    if (!win || typeof win.id !== "number") continue;
    const tabs = Array.isArray(win.tabs) ? win.tabs : [];
    if (!tabs.length) continue;
    // Content-based evidence only qualifies a window when NO tab in it belongs to the user: one
    // ordinary tab (WhatsApp, Spotify, GitHub, an edge:// page, ...) can never be Pi's window.
    const everyTabIsPi = tabs.every((tab) => isPiMarkerTab(tab) || (typeof tab.groupId === "number" && piGroupIds.has(tab.groupId)));
    if (!everyTabIsPi) continue;
    if (tabs.some(isPiMarkerTab) || piGroupWindowIds.has(win.id)) ids.add(win.id);
  }
  return ids;
}

// A legacy #pi-chrome marker tab that no session record names is an orphan: what an extension reload
// (which wipes chrome.storage.session) leaves behind while the browser keeps the window. Adopting it
// for a new session keeps ONE automation target per shared window instead of one per session that ever
// ran, and it is safe precisely because no live session owns it. A tab a live record names is never
// touched, so two sessions can never end up driving the same tab. The caller heals the adopted tab's
// URL to plain about:blank first (a marker tab cannot be attached; see BLANK_AUTOMATION_URL). New
// targets are plain about:blank and are deliberately NOT adopted this way: an unmarked blank tab
// cannot be told apart from one the user opened.
async function findReusableOrphanAutomationTab(windowId) {
  if (typeof windowId !== "number" || typeof chrome.tabs.query !== "function") return null;
  await hydrateAutomationTargets();
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  for (const tab of tabs || []) {
    if (typeof tab.id !== "number" || !isPiMarkerTab(tab)) continue;
    if (isPiChromeOwnedTarget(tab.id)) continue;
    return tab;
  }
  return null;
}

// Return the session's owned automation target if it still exists, else null. Robust to the user
// (or Chrome) having closed it: the dead tab id is forgotten but the recorded window is kept — it
// is the session's setting, so the caller rebuilds there (or fails naming it) instead of drifting.
async function resolveOwnedAutomationTarget(sessionKey, pick) {
  await hydrateAutomationTargets();
  const t = automationTargets.get(sessionKey);
  if (!t || typeof t.tabId !== "number") return null;
  // A superseded record must not be handed out: its tab is in a window the user has replaced with their
  // pick, and driving it there is precisely "Pi is still using my window". Retire it and report "no
  // target", so the caller rebuilds in the picked window on this very action. A pick whose window is gone
  // is left alone here — nothing is destroyed, and the caller's own existence check reports the fix.
  if (supersededByMachinePick(t, pick)) {
    // A pick whose window is gone is not used AND the window it superseded is not kept: this session is
    // told to re-pick (the caller's own check throws, naming the fix) instead of quietly continuing in a
    // window the user moved away from. Nothing is destroyed here — the tab is left for the re-pick to move.
    if (!(await pickWindowIsOpen(pick.windowId))) return null;
    await retargetSupersededRecord(sessionKey, t, pick);
    await persistAutomationTargets();
    return null;
  }
  const existing = await chrome.tabs.get(t.tabId).catch(() => null);
  if (existing && typeof existing.id === "number") {
    // A recorded target must still be in the window the record names. If the user dragged it
    // elsewhere, the record no longer describes where it lives, and driving it there would put Pi
    // back in a window it was not told to use. Retire the tab and let the caller rebuild in the
    // recorded window.
    if (typeof t.windowId === "number" && existing.windowId !== t.windowId) {
      // The tab sits in the window the machine-wide pick names: that is a move whose record write was
      // interrupted (worker restart mid-retarget), not a tab the user dragged away. Re-point instead of
      // destroying it — the tab holds the agent's page, and the pick is the reason it moved.
      if (pick && existing.windowId === pick.windowId && isPiRemovableTarget(existing)) {
        automationTargets.set(sessionKey, {
          windowId: pick.windowId,
          tabId: existing.id,
          piWindow: isPiOwnedWindow(pick.windowId),
          pickedAt: typeof t.pickedAt === "number" ? t.pickedAt : undefined,
        });
        await persistAutomationTargets();
        return existing;
      }
      // A recorded target must still be in the window the record names. If the user dragged it
      // elsewhere, the record no longer describes where it lives, and driving it there would put Pi
      // back in a window it was not told to use. Retire the tab and let the caller rebuild in the
      // recorded window.
      await chrome.tabs.remove(existing.id).catch(() => {});
      automationTargets.set(sessionKey, { windowId: t.windowId, piWindow: t.piWindow, pickedAt: t.pickedAt });
      await persistAutomationTargets();
      return null;
    }
    return existing;
  }
  // The tab is gone (the user closed Pi's tab, or its window closed with it). Drop the dead id but
  // keep the recorded window so the replacement is rebuilt there, or the failure names it.
  if (typeof t.windowId === "number") {
    automationTargets.set(sessionKey, { windowId: t.windowId, piWindow: t.piWindow, pickedAt: t.pickedAt });
  } else {
    automationTargets.delete(sessionKey);
  }
  await persistAutomationTargets();
  return null;
}

// A pi-chrome-owned automation tab that was moved out of the window its record names must never be
// driven or regrouped where it sits. `resolveOwnedAutomationTarget` enforces that on the implicit
// path, but explicit targeting (targetId/urlIncludes/titleIncludes) bypasses the resolver by design;
// this is the check that keeps those selectors from following a Pi tab the user dragged elsewhere.
// The stale tab is retired (closed) and the recorded window kept, so the next untargeted action
// rebuilds in the session's setting. Returns an error message, or null when the tab is not a moved
// Pi-owned target.
async function movedAutomationTargetError(tab, sessionKey) {
  if (!tab || typeof tab.id !== "number" || typeof tab.windowId !== "number") return null;
  await hydrateAutomationTargets();
  let ownerKey = null;
  if (isPiChromeOwnedTarget(tab.id, sessionKey)) ownerKey = sessionKey;
  else for (const [key, record] of automationTargets) if (record.tabId === tab.id) { ownerKey = key; break; }
  if (ownerKey === null) return null;
  const record = automationTargets.get(ownerKey);
  if (!record || typeof record.windowId !== "number" || record.windowId === tab.windowId) return null;
  await chrome.tabs.remove(tab.id).catch(() => {});
  // Keep the recorded window: it is the session's setting, so the next untargeted action rebuilds
  // there (or fails naming a gone user window) instead of drifting to another window. The pick time is
  // part of that setting: rewriting the record must not turn an explicit pick into "nobody picked this".
  automationTargets.set(ownerKey, { windowId: record.windowId, piWindow: record.piWindow, pickedAt: record.pickedAt });
  await persistAutomationTargets();
  return (
    `Pi's automation tab ${tab.id} was moved out of its own window (it is in window ${tab.windowId}, ` +
    `not window ${record.windowId}); pi-chrome does not drive or regroup a tab in a window it does not own. ` +
    `The tab has been closed — retry without targetId to get a fresh automation target, or run /chrome window to choose a window on purpose.`
  );
}

// A resolved automation target must name the window it lives in: every caller that creates or groups a
// tab needs it, and a missing windowId must never degrade to "whichever window Chrome picks" (the
// focused one, usually the user's). A creation API is not a reliable source for the property — Edge's
// windows.create has been observed to answer with a Window whose tab omits it — so re-read the live tab
// when the property is absent. A tab that no longer exists is returned unchanged and handled by callers.
async function withResolvedWindowId(tab) {
  if (!tab || typeof tab.id !== "number" || typeof tab.windowId === "number") return tab;
  const live = await chrome.tabs.get(tab.id).catch(() => null);
  return live && typeof live.windowId === "number" ? { ...tab, windowId: live.windowId } : tab;
}

// Return the session's automation target, creating it on first use (or after the user closed it).
// Used by page/navigation actions that need a live surface to drive. The target is built only in the
// session's recorded window or the machine-wide default; an implicit action never ends up in a window
// Chrome picks for us (see createAutomationTarget).
async function getOrCreateAutomationTarget(sessionKey, groupTitle, { preferredWindow, preferredWindowAt, preferredWindowKey } = {}) {
  const pick = await machineWindowPick({ preferredWindow, preferredWindowAt, preferredWindowKey });
  const target = (await resolveOwnedAutomationTarget(sessionKey, pick)) || await createAutomationTarget(sessionKey, groupTitle, { preferredWindow, preferredWindowAt, preferredWindowKey });
  return withResolvedWindowId(target);
}

// Close only the session's pi-chrome-owned window/tab, and only if it still exists. Never touches
// user tabs/windows or other sessions' targets. Safe to call repeatedly and when nothing exists.
async function cleanupAutomationTarget(sessionKey) {
  await hydrateAutomationTargets();
  const t = automationTargets.get(sessionKey);
  const result = { closedWindowId: null, closedTabId: null };
  if (!t) return result;
  const tab = typeof t.tabId === "number" ? await chrome.tabs.get(t.tabId).catch(() => null) : null;
  if (tab) {
    try {
      // Never remove a whole window: users/other sessions can add tabs even between a
      // contents check and removal. Chrome closes empty windows when their last tab closes.
      await chrome.tabs.remove(t.tabId);
      result.closedTabId = t.tabId;
    } catch {
      return result; // Keep ownership so cleanup can retry.
    }
    if (tab.windowId === t.windowId && typeof chrome.windows?.get === "function") {
      const remaining = await chrome.windows.get(t.windowId).catch(() => null);
      if (!remaining) result.closedWindowId = t.windowId;
    }
  }
  automationTargets.delete(sessionKey);
  await persistAutomationTargets();
  return result;
}

function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(async () => {
        try { await onTimeout?.(); } catch {}
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
}

// =================== Chrome input (CDP) layer ===================
// Tracks which tabs we have attached chrome.debugger to.
const attachedTabs = new Map(); // tabId -> { detachAt: number, pointer: {x,y} }
const INPUT_IDLE_DETACH_MS = 15_000;
const CDP_VERSION = "1.3";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rng(min, max) { return min + Math.random() * (max - min); }

function inputStatus() {
  return {
    attachedTabs: Array.from(attachedTabs.keys()),
    permissionGranted: typeof chrome !== "undefined" && !!chrome.debugger,
  };
}

// Last few attach failures, kept for diagnostics.
const attachDebugLog = [];
function recordAttachEvent(entry) {
  attachDebugLog.push({ ...entry, t: Date.now() });
  if (attachDebugLog.length > 20) attachDebugLog.shift();
}

function normalPageTarget(target, tabId) {
  const url = String(target?.url || "");
  return target?.tabId === tabId && target?.type === "page" && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.startsWith("devtools://");
}

async function pageDebuggeeForTab(tabId) {
  const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))).catch(() => []);
  const target = targets.find((t) => normalPageTarget(t, tabId));
  return target?.id ? { targetId: target.id } : { tabId };
}

async function debuggerAttachRaw(tabId, preferredDebuggee) {
  const debuggee = preferredDebuggee || { tabId };
  await withTimeout(
    chrome.debugger.attach(debuggee, CDP_VERSION),
    ATTACH_TIMEOUT_MS,
    `Chrome debugger attach to tab ${tabId}`,
    async () => {
      attachedTabs.delete(tabId);
      try { await chrome.debugger.detach(debuggee); } catch {}
    },
  );
  return debuggee;
}

async function attachDebugger(tabId) {
  if (!chrome.debugger) throw new Error("chrome.debugger API unavailable; reload the extension to grant the new permission");
  if (attachedTabs.has(tabId)) {
    const entry = attachedTabs.get(tabId);
    entry.detachAt = Date.now() + INPUT_IDLE_DETACH_MS;
    return entry;
  }
  // Before each attach, force-detach any stale CDP target this extension owns on the tab.
  // Chrome sometimes keeps a half-dead session around (extension reload mid-attach, etc.) and
  // surfaces it as "Cannot access a chrome-extension://" on the next attach attempt.
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    for (const tgt of targets) {
      if (tgt.tabId === tabId && tgt.attached) {
        recordAttachEvent({ kind: "stale-target-found", tabId, target: { id: tgt.id, type: tgt.type, url: tgt.url, extensionId: tgt.extensionId } });
        try { await chrome.debugger.detach({ tabId }); } catch {}
        await sleep(80);
        break;
      }
    }
  } catch {}
  let attachedDebuggee = null;
  const attemptAttach = async (debuggee) => {
    try {
      attachedDebuggee = await debuggerAttachRaw(tabId, debuggee);
      return null;
    } catch (error) {
      return error;
    }
  };
  const retryPageTargetIfExtensionBlocked = async (err, kind) => {
    if (!/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(String(err?.message || err))) return err;
    const pageDebuggee = await pageDebuggeeForTab(tabId);
    recordAttachEvent({ kind, tabId, debuggee: pageDebuggee });
    return attemptAttach(pageDebuggee);
  };
  // Prefer the explicit page target over the bare { tabId } debuggee. Chrome and Edge can keep
  // several CDP targets anchored to a single tab (extension overlays, autofill and password
  // managers, devtools front-ends). Attaching by { tabId } binds to whichever target the browser
  // currently treats as primary, and that session can be torn down mid-command, surfacing as
  // "Detached while handling command" on Page.captureScreenshot and Input.dispatchMouseEvent
  // while simpler commands still succeed. Binding to the page target is how Codex's browser
  // service addresses a tab, so try it first and fall back to { tabId } when unavailable.
  const preferredPageDebuggee = await pageDebuggeeForTab(tabId).catch(() => null);
  let err = preferredPageDebuggee && preferredPageDebuggee.targetId
    ? await attemptAttach(preferredPageDebuggee)
    : await attemptAttach();
  if (err) err = await attemptAttach();
  if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry");
  if (err) {
    const msg = String(err?.message || err);
    const transient = /Cannot access a chrome-extension|Cannot access contents of|No tab with id|Debugger is not attached|Another debugger|Target closed/i.test(msg);
    const tabSnapshot = await chrome.tabs.get(tabId).catch(() => null);
    recordAttachEvent({ kind: "attach-failed", tabId, message: msg, tabUrl: tabSnapshot?.url, transient });
    if (!transient) throw err;
    if (!tabSnapshot || (tabSnapshot.url || "").startsWith("chrome://") || (tabSnapshot.url || "").startsWith("chrome-extension://")) {
      throw new Error(`Chrome can't attach the debugger to this tab (${tabSnapshot?.url ?? "unknown"}). Open a normal http(s) tab and try again.`);
    }
    await sleep(180);
    err = await attemptAttach();
    if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry2");
    if (err) {
      recordAttachEvent({ kind: "attach-retry-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
      // One more try after a longer settle. Some Chrome builds need ~500ms after a navigation
      // for content-script registration on the tab to drain before chrome.debugger.attach
      // will accept the target.
      await sleep(500);
      err = await attemptAttach();
      if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry3");
      if (err) {
        recordAttachEvent({ kind: "attach-retry2-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
        const meta = await describeInputTarget(tabId);
        throw new Error(`Chrome debugger attach failed for tab ${tabId}: ${String(err.message || err)}${targetMetaSuffix(meta)}`);
      }
    }
  }
  recordAttachEvent({ kind: "attached", tabId, debuggee: attachedDebuggee });
  // Seed pointer in a plausible "just left the address bar" location.
  const entry = { detachAt: Date.now() + INPUT_IDLE_DETACH_MS, pointer: { x: 120 + Math.random() * 200, y: 80 + Math.random() * 120 }, debuggee: attachedDebuggee || { tabId } };
  attachedTabs.set(tabId, entry);
  // Best-effort focus emulation, gated by FOCUS_EMULATION_ON_ATTACH. It makes
  // document.hasFocus() report true, which some focus-dependent widgets require. It does NOT
  // guarantee visibilityState === "visible" and does NOT resume requestAnimationFrame in a
  // hidden tab, so it must never be treated as a screenshot/compositing fix. Detach-on-timeout
  // is disabled and every failure is recorded in the in-memory attach log (attachDebugLog, last
  // 20 entries, not currently exposed to Pi) but otherwise ignored: attach is what makes
  // click/type work today, so a failure here must never reject or break it.
  if (FOCUS_EMULATION_ON_ATTACH) {
    try {
      await cdpRaw(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }, { timeoutMs: 1_500, detachOnTimeout: false });
    } catch (error) {
      recordAttachEvent({ kind: "focus-emulation-failed", tabId, message: String(error?.message || error) });
    }
  }
  return entry;
}

async function describeInputTarget(tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0] || null;
  let targets = [];
  try { targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))); } catch {}
  return {
    resolvedTab: tab ? { id: tab.id, windowId: tab.windowId, url: tab.url, status: tab.status, title: tab.title, active: tab.active } : null,
    activeTab: active ? { id: active.id, windowId: active.windowId, url: active.url, status: active.status, title: active.title, active: active.active } : null,
    attachedTabs: Array.from(attachedTabs.keys()),
    cdpTargets: targets.map((t) => ({ id: t.id, tabId: t.tabId, type: t.type, url: t.url, attached: t.attached, extensionId: t.extensionId })),
  };
}

function targetMetaSuffix(meta) {
  return `\nTarget metadata: ${JSON.stringify(meta).slice(0, 4000)}`;
}

async function inputDebug(params) {
  const requested = params?.targetId ? await describeInputTarget(Number(params.targetId)) : await describeInputTarget(-1);
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    ...requested,
    recentAttachEvents: attachDebugLog.slice(),
  };
}

async function detachDebugger(tabId) {
  const entry = attachedTabs.get(tabId);
  if (!entry) return;
  attachedTabs.delete(tabId);
  try { await chrome.debugger.detach(entry.debuggee || { tabId }); } catch {}
}

async function detachAll() {
  const ids = Array.from(attachedTabs.keys());
  await Promise.all(ids.map(detachDebugger));
}

if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
    if (tabId !== undefined) attachedTabs.delete(tabId);
    if (reason === "canceled_by_user") {
      console.warn(`[pi-chrome] debugger canceled by user on tab ${tabId}; Chrome input will reattach on next call`);
    }
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [tabId, entry] of attachedTabs) {
    if (entry.detachAt && entry.detachAt < now) {
      void detachDebugger(tabId);
    }
  }
}, 5000);

// Deadline policy for cdp.call (FORK BUILD). CDP_COMMAND_TIMEOUT_MS is the default;
// callers may ask for a different deadline via params.timeoutMs, clamped so a stuck command can
// never pin the debugger session forever. The cap stays below the MV3 service-worker hard
// lifetime (5 minutes): a max-length command could otherwise be reaped by the browser before
// the inner deadline fires, leaving the caller with the generic bridge timeout.
// The outer handleCommand wrapper is widened by CDP_CALL_GRACE_MS so the inner cdpRaw timeout
// normally fires first and reports a precise `CDP <method> timed out` error. That precision is
// best-effort: the grace covers only the CDP command itself, while getTabByParams + the
// attach/retry path (ATTACH_TIMEOUT_MS) run before cdpRaw and can still consume the margin.
const CDP_CALL_MAX_TIMEOUT_MS = 120_000;
const CDP_CALL_GRACE_MS = 5_000;
function cdpCallTimeoutMs(params) {
  const requested = Number(params?.timeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) return CDP_COMMAND_TIMEOUT_MS;
  return Math.min(Math.floor(requested), CDP_CALL_MAX_TIMEOUT_MS);
}
function commandTimeoutMs(action, params) {
  if (action !== "cdp.call") return COMMAND_TIMEOUT_MS;
  return Math.max(COMMAND_TIMEOUT_MS, cdpCallTimeoutMs(params) + CDP_CALL_GRACE_MS);
}

// `opts.timeoutMs` overrides the default per-command deadline. `opts.detachOnTimeout === false`
// suppresses the cleanup detach for best-effort commands that must never tear down a session that
// was just attached. Both default to the original behaviour, so existing callers are unchanged.
// On timeout the session is detached and forgotten, so the next call cleanly re-attaches.
function cdpRaw(tabId, method, params, opts) {
  const debuggee = attachedTabs.get(tabId)?.debuggee || { tabId };
  const requested = Number(opts?.timeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : CDP_COMMAND_TIMEOUT_MS;
  return withTimeout(new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(`${method}: ${chrome.runtime.lastError.message}`));
      else resolve(result);
    });
  }), timeoutMs, `CDP ${method}`, opts?.detachOnTimeout === false ? undefined : async () => {
    attachedTabs.delete(tabId);
    try { await chrome.debugger.detach(debuggee); } catch {}
  });
}

function executeScriptTimed(options, label) {
  return withTimeout(chrome.scripting.executeScript(options), SCRIPTING_TIMEOUT_MS, label || "chrome.scripting.executeScript");
}

// Chrome refuses chrome.scripting on pages it considers outside the extension's reach. Measured on
// Edge 123 (see BLANK_AUTOMATION_URL): a top-level about:blank has an opaque origin, so even
// <all_urls> does not cover it, and data:/view-source:/chrome:/edge: and the legacy marker URL are
// refused the same way. The debugger API still attaches to exactly about:blank, so scripting calls
// fall back to CDP Runtime.evaluate (same MAIN world, and Runtime.evaluate bypasses page CSP exactly
// as the scripting func/files forms do). Keep the scripting path primary: it is the only one that
// works while another debugger (DevTools) holds the tab, and it is the path every ordinary page
// already uses.
function isScriptingAccessDenied(error) {
  const message = String(error?.message || error);
  return /Cannot access contents of url|Cannot access .+ at origin|Extension manifest must request permission|matchAboutBlank must be true/i.test(message);
}

// One chrome.scripting.executeScript call with a CDP fallback when Chrome refuses scripting for a
// permission reason (see isScriptingAccessDenied). The options keep the scripting API's exact shape,
// so every call site passes the same object it always did; only the entry point changes. The
// fallback covers both forms: `func:` is stringified and called with Runtime.evaluate (which bypasses
// page CSP exactly as the scripting func form does), and `files:` is read from the package once and
// evaluated with Runtime.evaluate (CDP has no file form). Any other scripting failure stays a
// scripting failure, so callers keep seeing the real error.
const packagedFileSources = new Map();
async function executeScriptWithFallback(options, label) {
  try {
    return await executeScriptTimed(options, label);
  } catch (error) {
    if (!isScriptingAccessDenied(error) || !chrome.debugger) throw error;
    const tabId = options?.target?.tabId;
    recordAttachEvent({ kind: "scripting-denied-cdp-fallback", tabId, files: options?.files || null, message: String(error?.message || error).slice(0, 300) });
    if (Array.isArray(options?.files) && options.files.length) {
      for (const file of options.files) {
        if (!packagedFileSources.has(file)) {
          const response = await fetch(chrome.runtime.getURL(file));
          if (!response.ok) throw new Error(`Could not read ${file} for CDP injection (HTTP ${response.status})`);
          packagedFileSources.set(file, await response.text());
        }
        const injected = await cdpEval(tabId, packagedFileSources.get(file));
        if (injected.exceptionDetails) {
          throw new Error(`${label || file}: ${cdpExceptionText(injected.exceptionDetails) || "CDP injection failed"}`);
        }
      }
      return [{ result: undefined }];
    }
    const expression = `(${options.func.toString()})(...${JSON.stringify(Array.isArray(options.args) ? options.args : [])})`;
    const result = await cdpEval(tabId, expression);
    if (result.exceptionDetails) {
      throw new Error(`${label || "page script"}: ${cdpExceptionText(result.exceptionDetails) || "evaluation failed"}`);
    }
    return [{ result: result.result?.value }];
  }
}

// Wraps cdpRaw with one auto-recover on detached/closed sessions:
// chrome.debugger.attach can stay cached in attachedTabs even after Chrome killed
// the session (tab nav, devtools opened/closed, etc). Recover by detaching the
// stale entry and re-attaching, then retry the command once.
// Find foreign chrome-extension targets currently anchored to the tab. Password managers,
// autofill helpers, and other input-attached extensions create type:"other" CDP targets
// whose URL is chrome-extension://<otherId>/...  When that target is in focus, CDP refuses
// our Input.dispatchMouseEvent calls with "Cannot access a chrome-extension:// URL of
// different extension" — surfacing a cryptic error to the user.
async function findForeignExtensionTargets() {
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    return targets.filter((t) => {
      const url = String(t.url || "");
      if (!url.startsWith("chrome-extension://")) return false;
      if (t.extensionId === chrome.runtime.id) return false;
      return true;
    });
  } catch {
    return [];
  }
}

function extractForeignExtId(targets) {
  for (const t of targets) {
    if (t.extensionId && t.extensionId !== chrome.runtime.id) return t.extensionId;
    const m = String(t.url || "").match(/chrome-extension:\/\/([a-p]+)\//);
    if (m && m[1] !== chrome.runtime.id) return m[1];
  }
  return null;
}

async function dismissOverlayViaEscape(tabId) {
  // Esc routes through key dispatcher (target-by-focus), not by mouse coordinates, so it
  // works even when a foreign chrome-extension popup is intercepting pointer events.
  try {
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(120);
  } catch {}
}

async function cdp(tabId, method, params, opts) {
  try {
    return await cdpRaw(tabId, method, params, opts);
  } catch (error) {
    const msg = String(error?.message || error);
    const isStale = /Debugger is not attached|Detached while|Target closed|No tab with id/i.test(msg);
    const isForeignExtBlock = /Cannot access a chrome-extension:\/\/ URL of different extension/i.test(msg);
    if (isForeignExtBlock && /Input\./.test(method)) {
      // Foreign chrome-extension popup (autofill, password manager) is hijacking input.
      // Try once: dismiss via Esc, then retry.
      const before = await findForeignExtensionTargets();
      recordAttachEvent({ kind: "foreign-ext-detected", tabId, method, foreignExtId: extractForeignExtId(before), targetCount: before.length });
      await dismissOverlayViaEscape(tabId);
      try {
        return await cdpRaw(tabId, method, params, opts);
      } catch (retryErr) {
        const retryMsg = String(retryErr?.message || retryErr);
        if (/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(retryMsg)) {
          const after = await findForeignExtensionTargets();
          const id = extractForeignExtId(after) || extractForeignExtId(before) || "unknown";
          throw new Error(
            `Another Chrome extension (${id}) has an input overlay on this page (e.g. a password manager / autofill popup). \n` +
            `pi-chrome tried to dismiss it with Escape but it reappeared. Disable that extension on this page, close its popup, or focus the field via Tab instead of clicking.`,
          );
        }
        throw retryErr;
      }
    }
    if (!isStale) throw error;
    attachedTabs.delete(tabId);
    await attachDebugger(tabId).catch(() => undefined);
    return cdpRaw(tabId, method, params, opts);
  }
}

// cdpEval: evaluate a JavaScript expression string in the page's MAIN world via CDP
// Runtime.evaluate. Runtime.evaluate is a DevTools protocol command and is NOT subject to
// the page's Content-Security-Policy, so it works on pages that ship `script-src 'self'`
// without `'unsafe-eval'` (which blocks `eval`/`new Function`). Ensures the debugger is
// attached first. Returns the raw CDP result ({ result, exceptionDetails }).
async function cdpEval(tabId, expression, opts) {
  await attachDebugger(tabId);
  return cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    ...(opts || {}),
  });
}

function cdpExceptionText(details) {
  if (!details) return "";
  return String(
    details.exception?.description ||
      details.exception?.value ||
      details.text ||
      "",
  );
}

function cdpIsSyntaxError(details) {
  if (!details) return false;
  const className = String(details.exception?.className || "");
  return className === "SyntaxError" || /SyntaxError/.test(cdpExceptionText(details));
}

// Resolve target -> {x, y, rect} in viewport coords by running tiny script in tab.
async function resolveTargetInTab(tabId, params) {
  const results = await executeScriptWithFallback({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (selector, uid, x, y) => {
      const state = window.__PI_CHROME_STATE__;
      let el = null;
      if (uid) {
        el = state && state.elements ? state.elements[uid] : null;
        if (!el || !el.isConnected) return { found: false, staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      } else if (selector) {
        el = document.querySelector(selector);
      }
      if (el) {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, tag: el.tagName, found: true };
      }
      if (typeof x === "number" && typeof y === "number") return { x, y, rect: null, tag: null, found: true };
      return { found: false };
    },
    args: [params.selector ?? null, params.uid ?? null, params.x ?? null, params.y ?? null],
  }, `resolve input target in tab ${tabId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  if (!v || !v.found) throw new Error("Could not resolve target element for Chrome input");
  return v;
}

function pickInsideRect(rect) {
  if (!rect) return null;
  const insetX = Math.min(rect.width * 0.35, Math.max(2, rect.width / 2 - 1));
  const insetY = Math.min(rect.height * 0.35, Math.max(2, rect.height / 2 - 1));
  return {
    x: rect.left + rect.width / 2 + rng(-insetX, insetX),
    y: rect.top + rect.height / 2 + rng(-insetY, insetY),
  };
}

async function cdpMoveTo(tabId, x, y) {
  const entry = attachedTabs.get(tabId);
  const startX = entry?.pointer?.x ?? Math.max(20, Math.min(400, x - 200));
  const startY = entry?.pointer?.y ?? Math.max(20, Math.min(400, y - 200));
  const n = Math.max(18, Math.min(42, Math.round(Math.hypot(x - startX, y - startY) / 18)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 8;
    const px = startX + (x - startX) * ease + rng(-wobble, wobble);
    const py = startY + (y - startY) * ease + rng(-wobble, wobble);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: px, y: py, button: "none", buttons: 0, pointerType: "mouse",
    });
    await sleep(rng(5, 16));
  }
  if (entry) entry.pointer = { x, y };
}

function cdpModifiersFor(mods) {
  let m = 0;
  if (mods?.altKey) m |= 1;
  if (mods?.ctrlKey) m |= 2;
  if (mods?.metaKey) m |= 4;
  if (mods?.shiftKey) m |= 8;
  return m;
}

// Resolve a single printable character to { code, keyCode, needShift } on a US layout.
// Self-contained (maps defined inline) so it can be serialized into the page via
// HELPER_FUNCS for the DOM-event fallback as well as used by the CDP path.
// Using charCodeAt() for punctuation is wrong: e.g. "." is charCode 46 which collides
// with VK_DELETE, "-" is 45 (VK_INSERT), so app keydown handlers misfire and drop input.
function usKeyLayoutForChar(ch) {
  const PUNCT = {
    "`": { code: "Backquote", keyCode: 192 }, "~": { code: "Backquote", keyCode: 192, shift: true },
    "-": { code: "Minus", keyCode: 189 }, "_": { code: "Minus", keyCode: 189, shift: true },
    "=": { code: "Equal", keyCode: 187 }, "+": { code: "Equal", keyCode: 187, shift: true },
    "[": { code: "BracketLeft", keyCode: 219 }, "{": { code: "BracketLeft", keyCode: 219, shift: true },
    "]": { code: "BracketRight", keyCode: 221 }, "}": { code: "BracketRight", keyCode: 221, shift: true },
    "\\": { code: "Backslash", keyCode: 220 }, "|": { code: "Backslash", keyCode: 220, shift: true },
    ";": { code: "Semicolon", keyCode: 186 }, ":": { code: "Semicolon", keyCode: 186, shift: true },
    "'": { code: "Quote", keyCode: 222 }, "\"": { code: "Quote", keyCode: 222, shift: true },
    ",": { code: "Comma", keyCode: 188 }, "<": { code: "Comma", keyCode: 188, shift: true },
    ".": { code: "Period", keyCode: 190 }, ">": { code: "Period", keyCode: 190, shift: true },
    "/": { code: "Slash", keyCode: 191 }, "?": { code: "Slash", keyCode: 191, shift: true },
    " ": { code: "Space", keyCode: 32 },
  };
  // Shifted digit symbols share the digit's physical code + keyCode.
  const SHIFT_DIGIT = { ")": "0", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9" };
  if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), needShift: false };
  if (/^[A-Z]$/.test(ch)) return { code: `Key${ch}`, keyCode: ch.charCodeAt(0), needShift: true };
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0), needShift: false };
  if (SHIFT_DIGIT[ch]) { const d = SHIFT_DIGIT[ch]; return { code: `Digit${d}`, keyCode: d.charCodeAt(0), needShift: true }; }
  const p = PUNCT[ch];
  if (p) return { code: p.code, keyCode: p.keyCode, needShift: !!p.shift };
  // Unknown char (e.g. unicode): keep text-driven insertion, avoid bogus keyCode collisions.
  return { code: ch, keyCode: 0, needShift: false };
}

function cdpKeyInfo(key, shifted) {
  // Map common keys to CDP key event init fields. Returns { code, key, windowsVirtualKeyCode, text }.
  const SPECIAL = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
    Backspace: { code: "Backspace", windowsVirtualKeyCode: 8, text: "" },
    Delete: { code: "Delete", windowsVirtualKeyCode: 46, text: "" },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27, text: "" },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37, text: "" },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38, text: "" },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39, text: "" },
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40, text: "" },
    Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16, text: "" },
    Control: { code: "ControlLeft", windowsVirtualKeyCode: 17, text: "" },
    Alt: { code: "AltLeft", windowsVirtualKeyCode: 18, text: "" },
    Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91, text: "" },
    " ": { code: "Space", windowsVirtualKeyCode: 32, text: " " },
  };
  if (SPECIAL[key]) return { key, ...SPECIAL[key] };
  if (key.length === 1) {
    // Explicit Shift chords need shifted text as well as a modifier bit. CDP does
    // not derive printable text from code/windowsVirtualKeyCode for us.
    const SHIFTED = {
      "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
      "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?",
    };
    const ch = shifted ? (/^[a-z]$/.test(key) ? key.toUpperCase() : SHIFTED[key] || key) : key;
    const layout = usKeyLayoutForChar(ch);
    return { key: ch, code: layout.code, windowsVirtualKeyCode: layout.keyCode, text: ch };
  }
  return { key, code: key, windowsVirtualKeyCode: 0, text: "" };
}

async function cdpTypeChar(tabId, ch) {
  const needShift = /^[A-Z]$/.test(ch) || "~!@#$%^&*()_+{}|:\"<>?".includes(ch);
  let modifiers = 0;
  if (needShift) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
    modifiers = 8;
    await sleep(rng(8, 22));
  }
  const info = cdpKeyInfo(ch);
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: info.text, unmodifiedText: info.text, modifiers,
  });
  await sleep(rng(25, 90));
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers,
  });
  if (needShift) {
    await sleep(rng(5, 18));
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
  }
  await sleep(rng(35, 130));
}

async function domClickFallback(tabId, params, cause) {
  const results = await executeScriptWithFallback({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (selector, uid, x, y) => {
      const state = window.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (uid && (!el || !el.isConnected)) return { staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      if (!el && selector) el = document.querySelector(selector);
      if (!el && typeof x === "number" && typeof y === "number") el = document.elementFromPoint(x, y);
      if (!el) throw new Error(`DOM fallback target not found: ${uid || selector || `${x},${y}`}`);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      const eventInit = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, buttons: 1 };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mousedown", eventInit));
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      el.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
      el.click();
      return { tag: el.tagName, url: location.href };
    },
    args: [params.selector ?? null, params.uid ?? null, params.x ?? null, params.y ?? null],
  }, `DOM click fallback in tab ${tabId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  return { input: "dom-fallback", reason: String(cause?.message || cause).slice(0, 500), tag: v?.tag };
}

async function chromeInputClick(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  try {
    await attachDebugger(tab.id);
    const resolved = await resolveTargetInTab(tab.id, params);
    const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
    await cdpMoveTo(tab.id, point.x, point.y);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
    await sleep(rng(45, 140));
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    // Reset :focus-visible if the click landed on a focusable element. CDP-driven pointer
    // focus can leave :focus-visible=true in Chromium, which trips heuristics that expect
    // Reset focus styling after pointer click when possible.
    if (params.selector || params.uid) {
      await executeScriptWithFallback({
        target: { tabId: tab.id, frameIds: [0] },
        world: "MAIN",
        func: (sel, uid) => {
          const state = window.__PI_CHROME_STATE__;
          let el = null;
          if (uid && state && state.elements && state.elements[uid]) el = state.elements[uid];
          else if (sel) el = document.querySelector(sel);
          if (el && typeof el.focus === "function" && el === document.activeElement) {
            try { el.blur(); el.focus({ preventScroll: true, focusVisible: false }); } catch {}
          }
        },
        args: [params.selector ?? null, params.uid ?? null],
      }, `reset focus style in tab ${tab.id}`).catch(() => undefined);
    }
    return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
  } catch (error) {
    if (params.domFallback === false) throw error;
    return domClickFallback(tab.id, params, error);
  }
}

async function chromeInputHover(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  const resolved = await resolveTargetInTab(tab.id, params);
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tab.id, point.x, point.y);
  await sleep(rng(80, 220));
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

async function chromeInputKey(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  const key = String(params.key || "");
  if (!key) throw new Error("chrome.key: missing key");
  const mods = params.modifiers || {};
  const modBits = cdpModifiersFor(mods);
  // Press modifiers in standard order, then key, then release in reverse.
  const modOrder = [];
  if (mods.metaKey) modOrder.push({ key: "Meta", code: "MetaLeft", vk: 91 });
  if (mods.ctrlKey) modOrder.push({ key: "Control", code: "ControlLeft", vk: 17 });
  if (mods.altKey) modOrder.push({ key: "Alt", code: "AltLeft", vk: 18 });
  if (mods.shiftKey) modOrder.push({ key: "Shift", code: "ShiftLeft", vk: 16 });
  for (const m of modOrder) {
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: modBits });
    await sleep(rng(6, 18));
  }
  const info = cdpKeyInfo(key, mods.shiftKey);
  // Ctrl/Meta/Alt chords must not insert literal text (e.g. Cmd+V). Shift alone
  // still types: Shift+a -> A, Shift+1 -> !, and Shift+Enter carries a newline.
  const shortcut = !!(mods.ctrlKey || mods.metaKey || mods.altKey);
  await cdp(tab.id, "Input.dispatchKeyEvent", {
    type: shortcut ? "rawKeyDown" : "keyDown", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: shortcut ? "" : info.text, unmodifiedText: shortcut ? "" : info.text, modifiers: modBits,
  });
  await sleep(rng(25, 90));
  await cdp(tab.id, "Input.dispatchKeyEvent", {
    type: "keyUp", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers: modBits,
  });
  for (const m of modOrder.reverse()) {
    await sleep(rng(5, 18));
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: 0 });
  }
  return { input: "chrome", key: info.key, modifiers: mods };
}

// Read the actual focused editor, not a role=textbox lookalike. For fill, select
// the requested editor's entire contents: triple-click only selects a paragraph.
// Selection uses the DOM; deletion and insertion still use Chrome's input layer.
async function contentEditableInTab(tabId, selectAllParams = null) {
  const results = await executeScriptWithFallback({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (selector, uid, selectAll) => {
      const active = document.activeElement;
      if (selectAll) {
        const state = window.__PI_CHROME_STATE__;
        const el = uid ? state?.elements?.[uid] : document.querySelector(selector);
        if (uid && (!el || !el.isConnected)) throw new Error(`snapshot uid ${uid} is stale; refresh chrome_snapshot`);
        if (!el?.isContentEditable) return false;
        if (!active?.isContentEditable || !(el === active || el.contains(active) || active.contains(el))) {
          throw new Error("chrome.fill: requested contenteditable is not focused");
        }
        const selection = window.getSelection();
        if (!selection) throw new Error("Could not select contenteditable contents");
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return active?.isContentEditable === true;
    },
    args: [selectAllParams?.selector ?? null, selectAllParams?.uid ?? null, selectAllParams !== null],
  }, `inspect contenteditable in tab ${tabId}`);
  return results?.[0]?.result === true;
}

// Read the target's value and caret so chrome_type can report what typing actually did instead of
// trusting a bare character count. Follows snapshot_injected.js's isSensitiveField redaction
// convention: password-like fields report only valueRedacted + length, never their contents. Value
// display is truncated the same way snapshots truncate values (120 chars).
async function readInputStateInTab(tabId, params) {
  const results = await executeScriptWithFallback({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (selector, uid) => {
      const state = window.__PI_CHROME_STATE__;
      const carrierOf = (node) => {
        if (!node) return null;
        if ("value" in node && typeof node.value === "string") return "value";
        if (node.isContentEditable === true) return "contenteditable";
        return null;
      };
      let el = uid ? (state && state.elements ? state.elements[uid] : null) : null;
      if (uid && (!el || !el.isConnected)) return { found: false, staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot` };
      if (!el && selector) el = document.querySelector(selector);
      if (!el) {
        const active = document.activeElement;
        el = active && active !== document.body && active !== document.documentElement ? active : null;
      }
      if (!el) return { found: false };
      // A uid/selector can point at a wrapper or ARIA textbox rather than the element that actually
      // receives the text (uids are assigned to tabindex/role nodes). Fall back to the focused
      // carrier so typing inside a wrapper is not reported as a false "" -> "".
      let carrier = carrierOf(el);
      if (!carrier) {
        const active = document.activeElement;
        if (active && active !== el && carrierOf(active)) el = active;
        carrier = carrierOf(el);
      }
      const raw = carrier === "value" ? el.value : carrier === "contenteditable" ? String(el.textContent || "") : "";
      const type = String(el.type || el.getAttribute?.("type") || "").toLowerCase();
      const haystack = [type, el.name, el.getAttribute?.("name"), el.id, el.getAttribute?.("autocomplete"), el.getAttribute?.("aria-label"), el.getAttribute?.("placeholder"), el.getAttribute?.("data-testid")].filter(Boolean).join(" ").toLowerCase();
      const sensitive = type === "password" || /password|passwd|\bpwd\b|secret|token|bearer|api[-_ ]?key|access[-_ ]?key|auth[-_ ]?code|one[-_ ]?time|otp|2fa|mfa|verification[-_ ]?code|recovery[-_ ]?code|credit[-_ ]?card|card[-_ ]?number|cc-number|cc-csc|cvc|cvv|security[-_ ]?code|ssn|social[-_ ]?security/.test(haystack);
      let selectionStart = null;
      let selectionEnd = null;
      try {
        if (typeof el.selectionStart === "number") selectionStart = el.selectionStart;
        if (typeof el.selectionEnd === "number") selectionEnd = el.selectionEnd;
      } catch {}
      let caretOffset = null;
      if (carrier === "contenteditable") {
        // Contenteditables have no selectionStart; measure the caret from the range start so a
        // splice past the 120-char display truncation is still detectable.
        try {
          const selection = window.getSelection && window.getSelection();
          if (selection && selection.rangeCount > 0 && selection.anchorNode && (!el.contains || el.contains(selection.anchorNode))) {
            const range = document.createRange();
            range.selectNodeContents(el);
            range.setEnd(selection.anchorNode, selection.anchorOffset);
            caretOffset = range.toString().length;
          }
        } catch {}
      }
      return {
        found: true,
        tag: el.tagName,
        carrier,
        value: carrier && !sensitive ? raw.slice(0, 120) : undefined,
        valueLength: carrier ? raw.length : undefined,
        valueRedacted: carrier && sensitive && raw.length > 0 ? true : undefined,
        selectionStart,
        selectionEnd,
        caretOffset,
      };
    },
    args: [params.selector ?? null, params.uid ?? null],
  }, `read input value in tab ${tabId}`);
  const v = results?.[0]?.result;
  return v && typeof v === "object" ? v : { found: false };
}

// Classify where the typed text landed from the caret at typing time (inputs/textareas via
// selectionStart, contenteditables via the measured caret) or the before/after value diff as a
// fallback. A target that carries no value reports nothing rather than a false "" -> "".
function inputInsertPosition(before, after) {
  if (!before?.found || !before.carrier) return undefined;
  if (before.selectionStart !== null && before.selectionStart !== undefined && before.selectionEnd !== null && before.selectionEnd !== undefined) {
    if (before.selectionEnd > before.selectionStart) return "replaced-selection";
    return before.selectionStart < (before.valueLength ?? 0) ? "caret-middle" : "caret-end";
  }
  if (typeof before.caretOffset === "number") {
    return before.caretOffset < (before.valueLength ?? 0) ? "caret-middle" : "caret-end";
  }
  const b = typeof before.value === "string" ? before.value : "";
  const a = after && typeof after.value === "string" ? after.value : "";
  if (b && a && a.length >= b.length && !a.startsWith(b)) return "caret-middle";
  return "caret-end";
}

function inputValueEvidence(before, after, { replaced = false } = {}) {
  const redacted = Boolean(before?.valueRedacted || after?.valueRedacted);
  // A non-carrier target (wrapper div, ARIA textbox, iframe focus) has no value to report; omit the
  // value fields entirely so the Pi text does not claim an empty field was typed into.
  const beforeCarrier = Boolean(before?.found && before.carrier);
  const afterCarrier = Boolean(after?.found && after.carrier);
  if (!beforeCarrier && !afterCarrier) return replaced ? { replaced: true } : {};
  return {
    valueBefore: redacted ? undefined : before?.value,
    valueAfter: redacted ? undefined : after?.value,
    valueRedacted: redacted || undefined,
    existingTextLengthBefore: beforeCarrier ? before?.valueLength : undefined,
    insertedAt: replaced ? "replaced-selection" : inputInsertPosition(before, after),
    ...(replaced ? { replaced: true } : {}),
  };
}

async function typeTextInTab(tabId, text, perCharacter) {
  if (!text) return "none";
  if (!perCharacter && await contentEditableInTab(tabId)) {
    // One native edit avoids per-character delays and rich-editor render races.
    // Do not retry as keystrokes if insertion fails: it may already have applied.
    await cdp(tabId, "Input.insertText", { text });
    return "insertText";
  }
  for (const ch of Array.from(text)) await cdpTypeChar(tabId, ch);
  return "keys";
}

async function chromeInputType(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  if (params.selector || params.uid) {
    // Focus target by clicking it first.
    const resolved = await resolveTargetInTab(tab.id, params);
    const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
    await cdpMoveTo(tab.id, point.x, point.y);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
    await sleep(rng(45, 110));
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    await sleep(rng(50, 120));
  }
  const text = String(params.text || "");
  // Read before/after so the caller can see a caret insertion (and any splice) instead of trusting a
  // bare character count. The "before" read must precede replace's select-all/delete, or a replaced
  // field would report an empty pre-existing value. Reads are best-effort: a read failure must never
  // block typing.
  const before = await readInputStateInTab(tab.id, params).catch(() => null);
  if (params.replace) {
    // Explicit replacement uses real Ctrl+A key events (not a DOM selection) then Delete, so editors
    // that track key handling see the same sequence a human would produce.
    await chromeInputKey({ ...params, targetId: tab.id, key: "a", modifiers: { ctrlKey: true } });
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await sleep(rng(20, 60));
  }
  const typing = await typeTextInTab(tab.id, text, params.perCharacter);
  const after = await readInputStateInTab(tab.id, params).catch(() => null);
  if (params.pressEnter) await chromeInputKey({ ...params, targetId: tab.id, key: "Enter" });
  const tabStatus = chrome.tabs?.get ? (await chrome.tabs.get(tab.id).catch(() => null))?.status : undefined;
  return {
    input: "chrome",
    length: text.length,
    typing,
    ...inputValueEvidence(before, after, { replaced: params.replace === true }),
    ...(tabStatus ? { tabStatus } : {}),
  };
}

async function domFillFallback(tabId, params, cause) {
  if (!(params.selector || params.uid)) throw cause;
  const results = await executeScriptWithFallback({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: async (selector, uid, text, submit) => {
      const state = window.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (uid && (!el || !el.isConnected)) return { staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      if (!el && selector) el = document.querySelector(selector);
      if (!el) throw new Error(`DOM fallback target not found: ${uid || selector}`);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      const value = String(text ?? "");
      if ("value" in el) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
      } else if (el.isContentEditable) {
        el.textContent = value;
      } else {
        throw new Error(`DOM fallback target is not fillable: <${el.tagName.toLowerCase()}>`);
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (submit) {
        const form = el.closest("form");
        if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
        else document.querySelector("button,[type=submit]")?.click();
      }
      return { valueMatches: "value" in el ? el.value === value : el.textContent === value, tag: el.tagName, url: location.href };
    },
    args: [params.selector ?? null, params.uid ?? null, params.text ?? "", params.submit === true],
  }, `DOM fill fallback in tab ${tabId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  return { input: "dom-fallback", length: String(params.text || "").length, valueMatches: v?.valueMatches, reason: String(cause?.message || cause).slice(0, 500), tag: v?.tag };
}

async function chromeInputFill(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  try {
    await attachDebugger(tab.id);
    if (!(params.selector || params.uid)) throw new Error("chrome.fill: selector or uid required");
    const resolved = await resolveTargetInTab(tab.id, params);
    const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
    await cdpMoveTo(tab.id, point.x, point.y);
    // Triple-click selects all in input fields.
    for (let i = 1; i <= 3; i++) {
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: i, pointerType: "mouse", force: 0.5 });
      await sleep(rng(20, 60));
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: i, pointerType: "mouse" });
      await sleep(rng(20, 60));
    }
    await contentEditableInTab(tab.id, params);
    // Delete selection.
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await sleep(rng(20, 60));
    const text = String(params.text || "");
    const typing = await typeTextInTab(tab.id, text, params.perCharacter);
    if (params.submit) await chromeInputKey({ ...params, targetId: tab.id, key: "Enter" });
    return { input: "chrome", length: text.length, typing };
  } catch (error) {
    if (params.domFallback === false) throw error;
    return domFillFallback(tab.id, params, error);
  }
}

async function chromeInputScroll(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  const resolved = (params.selector || params.uid) ? await resolveTargetInTab(tab.id, params) : { x: 100, y: 100, rect: null };
  const x = resolved.rect ? resolved.rect.left + Math.min(resolved.rect.width, 800) / 2 : resolved.x;
  const y = resolved.rect ? resolved.rect.top + Math.min(resolved.rect.height, 600) / 2 : resolved.y;
  const totalY = params.deltaY || 0, totalX = params.deltaX || 0;
  // Profile mimics a trackpad flick: short ramp-up (~15% of events), then geometric decay
  // with a ~12% drop per event. Gives momentum tail tests something to find, and the small
  // tail deltas (a handful of <20px events) put IntersectionObserver thresholds in range.
  const peak = Math.max(Math.abs(totalY), Math.abs(totalX));
  // Aim peak event ~22px so cumulative wheel approach to target seeds low-ratio IO samples.
  const PEAK_TARGET = 22;
  const w = [];
  // Build weights for an arbitrary n, then iterate to find an n where peak * (w_peak/sum) <= PEAK_TARGET.
  function build(n) {
    const arr = [];
    const peakIdx = Math.max(1, Math.floor(n * 0.15));
    for (let i = 0; i < n; i++) {
      if (i <= peakIdx) arr.push(0.5 + 0.5 * (i / peakIdx)); // 0.5 → 1.0
      else arr.push(Math.pow(0.88, i - peakIdx));            // ~12% drop per step
    }
    return arr;
  }
  let n = Math.max(12, params.steps || 24);
  for (let attempt = 0; attempt < 8; attempt++) {
    const arr = build(n);
    const s = arr.reduce((a, b) => a + b, 0);
    const peakStep = peak * (Math.max(...arr) / s);
    if (peakStep <= PEAK_TARGET || n >= 240) {
      w.length = 0;
      w.push(...arr);
      break;
    }
    n = Math.ceil(n * 1.4);
  }
  if (w.length === 0) w.push(...build(n));
  const sumW = w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    const dy = totalY * (w[i] / sumW), dx = totalX * (w[i] / sumW);
    await cdp(tab.id, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, pointerType: "mouse",
    });
    // Sleep one+ frame so IntersectionObserver / rAF samples can run between events.
    await sleep(rng(22, 48));
  }
  return { input: "chrome", deltaX: totalX, deltaY: totalY, steps: n };
}

async function chromeInputTap(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  const resolved = (params.selector || params.uid || (typeof params.x === "number" && typeof params.y === "number"))
    ? await resolveTargetInTab(tab.id, params)
    : null;
  if (!resolved || !resolved.found) throw new Error("chrome.tap: target not found");
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  const tp = { x: point.x, y: point.y, radiusX: 8, radiusY: 8, rotationAngle: 0, force: 0.5, id: 1 };
  await cdp(tab.id, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tp] });
  await sleep(rng(40, 110));
  await cdp(tab.id, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

async function chromeInputDrag(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  const from = await resolveTargetInTab(tab.id, { selector: params.fromSelector ?? null, uid: params.fromUid ?? null, x: params.fromX ?? null, y: params.fromY ?? null });
  const to = await resolveTargetInTab(tab.id, { selector: params.toSelector ?? null, uid: params.toUid ?? null, x: params.toX ?? null, y: params.toY ?? null });
  const fp = from.rect ? pickInsideRect(from.rect) : { x: from.x, y: from.y };
  const tp = to.rect ? pickInsideRect(to.rect) : { x: to.x, y: to.y };
  await cdpMoveTo(tab.id, fp.x, fp.y);
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: fp.x, y: fp.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
  await sleep(rng(60, 140));
  const steps = params.steps || 20;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 6;
    const x = fp.x + (tp.x - fp.x) * ease + rng(-wobble, wobble);
    const y = fp.y + (tp.y - fp.y) * ease + rng(-wobble, wobble);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, pointerType: "mouse" });
    await sleep(rng(10, 26));
  }
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: tp.x, y: tp.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  return { input: "chrome", from: fp, to: tp, steps };
}

async function chromeInputUpload(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  if (!(params.selector || params.uid)) throw new Error("chrome.upload: selector or uid required");
  const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
  if (!paths.length) throw new Error("chrome.upload: no file paths provided");
  const expression = `(() => {
    const selector = ${JSON.stringify(params.selector ?? null)};
    const uid = ${JSON.stringify(params.uid ?? null)};
    const state = window.__PI_CHROME_STATE__;
    const el = uid ? state?.elements?.[uid] : (selector ? document.querySelector(selector) : null);
    if (uid && (!el || !el.isConnected)) throw new Error("snapshot uid " + uid + " is stale; refresh chrome_snapshot");
    if (!el || el.tagName !== "INPUT" || el.type !== "file") throw new Error("Target must be <input type=file>");
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return el;
  })()`;
  const evaluated = await cdp(tab.id, "Runtime.evaluate", { expression, objectGroup: "pi-chrome-upload", includeCommandLineAPI: false, returnByValue: false });
  if (evaluated.exceptionDetails) throw new Error(cdpExceptionText(evaluated.exceptionDetails) || "Could not resolve file input");
  const objectId = evaluated.result?.objectId;
  if (!objectId) throw new Error("Could not resolve file input object");
  try {
    await cdp(tab.id, "DOM.enable", {}).catch(() => undefined);
    // Some DOM agents return nodeId:0 (or reject conversion) for a valid remote
    // element. CDP accepts that same objectId directly, before any file mutation.
    const requested = await cdp(tab.id, "DOM.requestNode", { objectId }).catch(() => null);
    const target = requested?.nodeId ? { nodeId: requested.nodeId } : { objectId };
    await cdp(tab.id, "DOM.setFileInputFiles", { ...target, files: paths });
    await cdp(tab.id, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() { this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return this.files ? this.files.length : 0; }`,
      returnByValue: true,
    }).catch(() => undefined);
  } finally {
    await cdp(tab.id, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
  return { input: "chrome", uploaded: paths.map((path) => ({ path })) };
}
// ===============================================================


function armKeepaliveAlarm() {
  chrome.alarms.create("pi-bridge-keepalive", { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "pi" });
  chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
  armKeepaliveAlarm();
  void pollLoop();
});

chrome.runtime.onStartup.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pi-bridge-keepalive") void pollLoop();
});

chrome.action.onClicked.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

armKeepaliveAlarm();

setInterval(() => {
  void pollLoop();
}, 1000);

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      // /next is a server-side long poll (see POLL_ABORT_MS), so a fetch that outlives the
      // deadline means the bridge died and the socket will never settle. Abort it so the catch
      // below backs off and retries instead of parking on a zombie connection.
      const abortController = new AbortController();
      const abortTimer = setTimeout(() => abortController.abort(), POLL_ABORT_MS);
      let response;
      try {
        const profileId = await getProfileId();
        response = await fetch(`${BRIDGE_URL}/next?name=${encodeURIComponent(CLIENT_NAME)}&browser=${encodeURIComponent(BROWSER_FAMILY)}&profile=${encodeURIComponent(profileId)}`, {
          cache: "no-store",
          signal: abortController.signal,
        });
      } finally {
        // Clear before reading the body: a late abort during response.json() would fail a good response.
        clearTimeout(abortTimer);
      }
      if (!response.ok) throw new Error(`bridge /next HTTP ${response.status}`);
      const expected = response.headers.get("x-pi-chrome-version");
      const ours = chrome.runtime.getManifest().version;
      if (expected && expected !== ours && isVersionOlder(ours, expected)) {
        console.warn(`[pi-chrome] extension v${ours} behind pi-chrome v${expected}; reloading extension`);
        try { chrome.runtime.reload(); } catch {}
        return;
      }
      const payload = await response.json();
      if (payload.type === "command") await handleCommand(payload.command);
    }
  } catch (error) {
    if (error?.name === "AbortError" && Date.now() - lastAbortWarnAt >= ABORT_WARN_THROTTLE_MS) {
      lastAbortWarnAt = Date.now();
      console.warn(`[pi-chrome] bridge request aborted after its deadline; retrying in ${POLL_ERROR_BACKOFF_MS}ms`);
    }
    await sleep(POLL_ERROR_BACKOFF_MS);
  } finally {
    polling = false;
  }
}

async function handleCommand(command) {
  try {
    const result = await withTimeout(
      dispatch(command.action, command.params ?? {}),
      commandTimeoutMs(command.action, command.params ?? {}),
      command.action || "Chrome command",
      () => detachAll(),
    );
    await postResult({ id: command.id, ok: true, result });
  } catch (error) {
    await postResult({ id: command.id, ok: false, error: error?.message ?? String(error) });
  }
}

async function postResult(result) {
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), RESULT_ABORT_MS);
  try {
    await fetch(`${BRIDGE_URL}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(abortTimer);
  }
}

function isVersionOlder(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

function cleanGroupTitle(value) {
  const text = String(value || PI_GROUP_NAME).replace(/\s+/g, " ").trim().slice(0, 80);
  return text || PI_GROUP_NAME;
}

function cleanGroupColor(value) {
  const color = String(value || DEFAULT_GROUP_COLOR).toLowerCase();
  return VALID_GROUP_COLORS.has(color) ? color : DEFAULT_GROUP_COLOR;
}

async function groupRecord(groupId) {
  if (typeof groupId !== "number" || groupId < 0 || !chrome.tabGroups) return null;
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group) return null;
  return {
    id: group.id,
    title: group.title || "",
    color: group.color || "",
    collapsed: Boolean(group.collapsed),
    windowId: group.windowId,
    piGroup: Boolean(group.title && PI_GROUP_RE.test(group.title)),
  };
}

// Find existing tab groups whose title matches `title` (case-insensitive), scoped to one window.
// This is the only group lookup grouping uses: a tab's group must be the one in the tab's own window
// (Chrome tab groups cannot span windows, and joining a foreign group MOVES the tab). Which window a
// session works in is decided by its recorded workspace, never by group titles or query order.
async function findGroupByTitle(windowId, title) {
  if (!chrome.tabGroups) return null;
  // Never query without a window: an unscoped `tabGroups.query` answers with groups from EVERY
  // window, and grouping a tab with a group from another window makes Chrome MOVE the tab into that
  // group's window. Refusing here is the difference between a window-scoped group id and a silently
  // relocated tab.
  if (typeof windowId !== "number") return null;
  const wanted = cleanGroupTitle(title).toLowerCase();
  const groups = await chrome.tabGroups.query({ windowId }).catch(() => []);
  const match = groups.find((g) => (g.title || "").trim().toLowerCase() === wanted);
  return match ? match.id : null;
}

// Add `tab` to a tab group, then set title/color. If the tab is ungrouped, reuse an
// existing same-title group in its window when present, otherwise create a new group.
async function groupTab(tab, title, color) {
  if (!chrome.tabGroups) throw new Error("chrome.tabGroups API unavailable; reload the extension after granting the tabGroups permission");
  if (!tab || typeof tab.id !== "number") throw new Error("No tab to group");
  // A tab without a window cannot be scoped to a window, and guessing would be how a group in another
  // window captures it (Chrome moves the tab when it joins a foreign group).
  if (typeof tab.windowId !== "number") throw new Error("Cannot group a tab without a window id");
  const groupTitle = cleanGroupTitle(title);
  let groupId = tab.groupId;
  if (typeof groupId !== "number" || groupId < 0) {
    const existing = await findGroupByTitle(tab.windowId, groupTitle);
    groupId = existing !== null
      ? await chrome.tabs.group({ groupId: existing, tabIds: [tab.id] })
      : await chrome.tabs.group({ tabIds: [tab.id] });
  }
  await chrome.tabGroups.update(groupId, { title: groupTitle, color: cleanGroupColor(color), collapsed: false });
  const grouped = await chrome.tabs.get(tab.id);
  return { tab: await formatTab(grouped), group: await groupRecord(groupId) };
}

// Apply one machine-wide pick to every session record it supersedes: each one's guest tab is moved into
// the picked window (or closed when it cannot be moved and is provably Pi's) and the record is re-pointed at
// the picked window. Under the one-writer rule EVERY record whose window differs is superseded, however
// recently it was picked — a record's own timestamp cannot protect it (that is what the measured pick-vs-
// record conflict required). `keepKey` is the session that made the pick: its record is already written
// and must not be rewritten here. Returns the number of records retargeted.
async function sweepSupersededTargets(keepKey, wanted, at) {
  const pick = { windowId: wanted, at };
  let retargeted = 0;
  for (const [key, record] of [...automationTargets]) {
    if (key === keepKey || !supersededByMachinePick(record, pick)) continue;
    if (await retargetSupersededRecord(key, record, pick)) retargeted++;
  }
  if (retargeted > 0) await persistAutomationTargets();
  return retargeted;
}

async function dispatch(action, params) {
  switch (action) {
    case "tab.version":
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        bridgeUrl: BRIDGE_URL,
        userAgent: navigator.userAgent,
        browser: BROWSER_FAMILY,
        profileId: await getProfileId(),
        capabilities: { hardBackground: true },
      };
    case "tab.list": {
      const tabs = await chrome.tabs.query({});
      return Promise.all(tabs.map(formatTab));
    }
    case "tab.new.background":
    case "page.screenshot.background":
      // Older workers reject these action names before touching tabs. Do not replace this with
      // a capability probe followed by an old action: a reload/profile change can race the probe.
      return dispatch(action.slice(0, -".background".length), { ...params, background: true, foreground: false });
    case "tab.new": {
      // Every Pi-opened tab must join a tab group. There is intentionally no opt-out: an ungrouped
      // Pi-created tab is easy to lose among user tabs. If grouping fails after creation, close the
      // tab best-effort before surfacing the error so tab.new never leaves an ungrouped Pi tab.
      const groupTitle = params.groupTitle || PI_GROUP_NAME;
      const createParams = { url: params.url || "about:blank", active: foregroundRequested(params) };
      // Put the tab in the window THIS session works in — the window the user picked (or a legacy
      // Pi-window assignment) — rather than in whichever window happens to hold a "Pi Agent" group.
      // That lookup matched by title across every window, so a leftover group sitting in the user's
      // window sent Pi's tabs there uninvited. Resolving the target can create Pi's guest tab inside
      // the chosen window, but it never creates a window: with no assignment and no saved default it
      // fails with a message naming /chrome window.
      const targetTab = await getOrCreateAutomationTarget(sessionKeyOf(params), params.groupTitle, machinePickParams(params));
      // A tab must never be created without a window: chrome.tabs.create defaults to the FOCUSED window
      // — the user's — and that is exactly how the live Edge run left tab.new's tab and its new group
      // among the user's tabs while the automation marker sat in Pi's window. The helper resolves the
      // window from the live tab; if even that fails, fail closed instead of guessing.
      if (!targetTab || typeof targetTab.windowId !== "number") {
        throw new Error(
          "pi-chrome could not determine which window this session's automation target lives in, so it " +
            "will not create tab.new's tab in whichever window happens to be focused. Retry, or run /chrome window to choose a window on purpose.",
        );
      }
      createParams.windowId = targetTab.windowId;
      const tab = await chrome.tabs.create(createParams);
      await trackSessionTab(sessionKeyOf(params), tab.id, true);
      try {
        await bringToFront(tab, params);
        const grouped = await groupTab(tab, groupTitle, params.groupColor);
        // chrome.tabs.create returns the t=0 Tab ({url:"", title:"", status:"loading"}); report the
        // settled tab instead so an immediate read does not look like "the URL never loaded".
        const load = await waitForCreatedTabLoad(tab.id, createParams.url, params.timeoutMs);
        const settled = await chrome.tabs.get(tab.id).catch(() => load.tab);
        return {
          ...grouped,
          tab: settled ? await formatTab(settled) : grouped.tab,
          loadStatus: load.loadStatus,
          waitedMs: load.waitedMs,
        };
      } catch (error) {
        if (typeof tab.id === "number") await chrome.tabs.remove(tab.id).catch(() => {});
        throw error;
      }
    }
    case "tab.activate": {
      if (!foregroundRequested(params)) {
        throw new Error("Tab activation is blocked by background mode. Ask the user to run /chrome background off to allow foreground work.");
      }
      // Management actions never auto-create an automation target (createOwnedTarget:false): with
      // no explicit target they act on an owned target if one exists, else error — they must never
      // fall back to (or spawn a tab just to touch) the user's active tab.
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      return formatTab(await bringToFront(tab, params));
    }
    case "tab.group": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      const grouped = await groupTab(tab, params.groupTitle || PI_GROUP_NAME, params.groupColor);
      if (!(tab.groupId >= 0)) await trackSessionTab(sessionKeyOf(params), tab.id, false, grouped.group?.id);
      return grouped;
    }
    case "tab.ungroup": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      if (typeof tab.groupId === "number" && tab.groupId >= 0) await chrome.tabs.ungroup(tab.id);
      return formatTab(await chrome.tabs.get(tab.id));
    }
    case "tab.close": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      await chrome.tabs.remove(tab.id);
      return { closed: tab.id };
    }
    case "page.snapshot":
      return snapshotInTab(params);
    case "page.inspect":
      return inspectInTab(params);
    case "page.evaluate":
      return evaluateInTab(params);
    case "page.click":
      return withOptionalSnapshot(params, chromeInputClick);
    case "page.hover":
      return chromeInputHover(params);
    case "page.drag":
      return chromeInputDrag(params);
    case "page.upload":
      return chromeInputUpload(params);
    case "page.type":
      return withOptionalSnapshot(params, chromeInputType);
    case "page.fill":
      return withOptionalSnapshot(params, chromeInputFill);
    case "page.key":
      return withOptionalSnapshot(params, chromeInputKey);
    case "page.scroll":
      return chromeInputScroll(params);
    case "page.tap":
      return chromeInputTap(params);
    case "input.status":
      return inputStatus();
    case "input.debug":
      return inputDebug(params);
    case "page.console.list":
      return executeInTab(params, listConsoleMessages, [params.clear === true]);
    case "page.network.list":
      return executeInTab(params, listNetworkRequests, [params.includePreservedRequests === true, params.clear === true]);
    case "page.network.get":
      return executeInTab(params, getNetworkRequest, [params.requestId]);
    case "page.waitFor": {
      // Poll from the service worker via CDP (bypasses CSP). The old approach ran the polling
      // loop in-page with new Function() for expression checks, which fails under strict CSP.
      const tab = await getTabByParams(params);
      await bringToFront(tab, params);
      const timeoutMs = params.timeoutMs || 10000;
      const intervalMs = params.intervalMs || 250;
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        let ok = false;
        try {
          const expr = params.kind === "selector"
            ? `!!document.querySelector(${JSON.stringify(params.value)})`
            : params.value;
          ok = Boolean(await evaluateInTab({ ...params, expression: expr, foreground: false }));
        } catch {
          ok = false;
        }
        if (ok) return { elapsedMs: Date.now() - started };
        await sleep(intervalMs);
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${params.kind}: ${params.value}`);
    }
    case "page.probe":
      // Lightweight capability probe for /chrome-doctor. Runs in MAIN world.
      return executeInTab(params, probePage, []);
    case "page.navigate": {
      const tab = await getTabByParams(params);
      await bringToFront(tab, params);
      if (params.initScript) {
        // Register a one-shot document_start content script. We register, navigate, wait, then unregister.
        await registerInitScript(tab.id, params.initScript);
      }
      const wait = params.waitUntilLoad !== false ? waitForTabComplete(tab.id, params.timeoutMs || 15000) : Promise.resolve(undefined);
      const updated = await chrome.tabs.update(tab.id, { url: params.url });
      try {
        await wait;
      } finally {
        if (params.initScript) await unregisterInitScript(tab.id).catch(() => undefined);
      }
      return await formatTab(await chrome.tabs.get(updated.id));
    }
    case "page.screenshot":
      return takeScreenshot(params);
    // -------- raw CDP passthrough (FORK BUILD) --------
    // Diagnostic: the CDP targets anchored to the resolved tab, including foreign/overlay
    // targets (password managers, autofill, devtools front-ends). This is what makes cdp.call
    // failures like "Detached while handling command" debuggable. chrome.debugger.getTargets
    // returns targets browser-wide, so when a tab is resolved only its targets are reported;
    // targets on other tabs are counted but not echoed into the conversation. With no resolved
    // tab (no owned target yet) every target is reported so the caller can still diagnose.
    case "cdp.targets": {
      // Diagnostics must not create an automation window: resolve an owned target if one exists,
      // otherwise report targets without a tab. An explicit selector miss ("No Chrome tab with
      // id N" / "No matching Chrome tab found") must propagate instead of degrading to an
      // empty-looking list that hides the mistake; any other failure (for example a transient
      // chrome.tabs.query error) is still swallowed so diagnostics keep working. Empty
      // urlIncludes/titleIncludes count as "no selector", matching getTabByParams' own truthiness
      // checks.
      const hasSelector = params.targetId !== undefined || Boolean(params.urlIncludes) || Boolean(params.titleIncludes);
      const tab = await getTabByParams(params, { createOwnedTarget: false }).catch((error) => {
        const message = String(error?.message || error);
        if (hasSelector && /No Chrome tab with id|No matching Chrome tab found/.test(message)) throw error;
        return null;
      });
      const allTargets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))).catch(() => []);
      const targets = tab ? allTargets.filter((t) => t.tabId === tab.id) : allTargets;
      // Only targets anchored to another tab count as "more on other tabs". Tab-less targets
      // (service workers, browser-level targets) are on no tab at all.
      return {
        tab: tab ? { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title } : null,
        targets: targets.map((t) => ({ id: t.id, tabId: t.tabId, type: t.type, url: t.url, title: t.title, attached: t.attached, extensionId: t.extensionId })),
        ...(tab ? { otherTabTargetCount: allTargets.filter((t) => typeof t.tabId === "number" && t.tabId !== tab.id).length } : {}),
      };
    }
    case "cdp.call": {
      // Validate before touching the debugger: a clear error beats Chrome's opaque
      // "sendCommand: Invalid parameters" for a missing/blank method.
      if (typeof params.method !== "string" || !params.method.trim()) {
        throw new Error('cdp.call requires a non-empty string "method" (for example "Runtime.evaluate" or "Page.captureScreenshot").');
      }
      if (params.params !== undefined && params.params !== null && (typeof params.params !== "object" || Array.isArray(params.params))) {
        throw new Error('cdp.call "params" must be a plain object of CDP parameters when provided.');
      }
      const method = params.method.trim();
      const tab = await getTabByParams(params);
      await attachDebugger(tab.id);
      const timeoutMs = cdpCallTimeoutMs(params);
      return await cdp(tab.id, method, params.params ?? {}, { timeoutMs });
    }
    case "window.list": {
      // Enumerate the browser's windows with something recognisable to pick from — the title of the tab
      // the user can actually see in each one. Also report where this session's automation tab lives, so
      // the caller can mark the current choice without re-deriving it.
      const windows = await chrome.windows.getAll({ populate: true });
      await hydrateAutomationTargets();
      const target = automationTargets.get(sessionKeyOf(params));
      // The per-session record is a claim about where the tab IS, and it goes stale the moment the tab
      // is moved (the user dragging it, or Chrome following a foreign group). Reading it raw was the
      // live bug: window.list reported ownsTargetWindow=true / targetWindowId=<Pi's window> while the
      // same report said holdsTargetTab=true for the USER's window. Resolve the claim against the
      // tab's real window and report ownership from that — a window the tab is not in is not ours.
      const targetTab = typeof target?.tabId === "number"
        ? await chrome.tabs.get(target.tabId).catch(() => null)
        : null;
      const targetTabWindowId = targetTab && typeof targetTab.windowId === "number" ? targetTab.windowId : null;
      const recordedWindowId = typeof target?.windowId === "number" ? target.windowId : null;
      const groups = chrome.tabGroups && typeof chrome.tabGroups.query === "function"
        ? await chrome.tabGroups.query({}).catch(() => [])
        : [];
      const dedicatedWindowIds = dedicatedPiWindowIds(windows, groups);
      const ownsTargetWindow = targetTabWindowId !== null &&
        (isPiOwnedWindow(targetTabWindowId) || dedicatedWindowIds.has(targetTabWindowId));
      // Where this session will actually work next. A record the machine-wide pick supersedes is about to
      // be rebuilt in the picked window, so reporting it as "Pi is working here" would point the picker at
      // a window Pi is leaving — the exact contradiction the live report caught (the ✓ sat on a window
      // while the user's own window held Pi's tabs). The pick is therefore the answer whenever it wins.
      const pick = await machineWindowPick(params);
      const superseded = supersededByMachinePick(target, pick);
      const workingCandidate = superseded
        ? pick.windowId
        : targetTabWindowId !== null
          ? targetTabWindowId
          : typeof target?.windowId === "number"
            ? target.windowId
            : pick
              ? pick.windowId
              : null;
      // Only ever report a workspace the user can see in this list. A closed window would otherwise mark
      // no entry in the picker, which leaves the TUI cursor on the first line — usually the user's focused
      // window — and makes a bare Enter pick a window Pi was not working in.
      const liveWindowIds = new Set(windows.map((win) => win.id));
      const workingWindowId = typeof workingCandidate === "number" && liveWindowIds.has(workingCandidate) ? workingCandidate : null;
      return {
        windows: windows.map((win) => {
          const tabs = Array.isArray(win.tabs) ? win.tabs : [];
          const activeTab = tabs.find((tab) => tab.active) ?? tabs[0];
          return {
            windowId: typeof win.id === "number" ? win.id : null,
            tabCount: tabs.length,
            title: (activeTab && (activeTab.title || activeTab.url)) || "(empty window)",
            focused: win.focused === true,
            holdsTargetTab: typeof target?.tabId === "number" && tabs.some((tab) => tab.id === target.tabId),
            // A dedicated Pi window, wherever the session record says the tab is. Discovery evidence —
            // the registry, a legacy #pi-chrome marker, or an all-Pi-tab "Pi Agent" group — decides, not
            // the per-session record: inherited targets and cleaned-up creating sessions must not
            // make a live Pi window look like one of the user's.
            ownedByPi: isPiOwnedWindow(win.id) || dedicatedWindowIds.has(win.id),
          };
        }),
        // Report the window the tab is really in, and only when it is a dedicated Pi window. A record
        // naming a Pi window the tab has left (or a tab that no longer exists) is reported as owning
        // no window: the picker then marks the window that actually holds the tab, and cleanup never
        // claims to have closed a window it did not.
        targetWindowId: ownsTargetWindow ? targetTabWindowId : null,
        ownsTargetWindow,
        // The workspace the picker should mark and offer first; the Pi side falls back to the saved
        // default when this is absent (an older extension never sends it).
        workingWindowId,
        // Diagnostic only (index.ts ignores it): the session has a target whose record no longer
        // matches where that tab lives, i.e. the state the live report caught in the act.
        targetStale: typeof target?.tabId === "number" && (targetTabWindowId === null || (recordedWindowId !== null && targetTabWindowId !== recordedWindowId)),
      };
    }
    case "window.select": {
      const wanted = params.windowId;
      if (wanted !== null && !Number.isInteger(wanted)) {
        throw new Error('window.select needs "windowId" as an integer. A window of Pi\'s own is no longer offered: run /chrome window to pick an existing window.');
      }
      // R3: a command may only move the workspace when it declares itself the user's picker
      // (`pickSource: "user"`). This is a mis-call guard, not authentication — the command body is
      // client-asserted, so a local caller can still claim the field; the durable barrier is the
      // connector-key attribution in machineWindowPick. It does stop the measured unmarked call: another
      // agent posted hand-built JSON to POST /command (no sessionKey, no pickSource) calling
      // window.select, and thereby pinned Pi to a window the user did not choose. Refuse HERE, before any
      // record write, tab create/move or sweep, so an unmarked call cannot move a workspace even while
      // failing. The restart hint exists for version skew: an older Pi session never sends pickSource, and
      // "run /chrome window" alone is circular while that same session is building the picker's call.
      if (params.pickSource !== "user") {
        throw new Error(
          "Only /chrome window can choose Pi's window. Run /chrome window to pick one of your open browser " +
            "windows; if the picker is refused too, restart the Pi session so it loads the updated pi-chrome.",
        );
      }
      const sessionKey = sessionKeyOf(params);
      const groupTitle = params.groupTitle || PI_GROUP_NAME;
      await hydrateAutomationTargets();
      const current = automationTargets.get(sessionKey);
      // The moment the user chose this window. Under the one-writer rule the stamp no longer decides the
      // workspace (see supersededByMachinePick); it is still written and returned so the Pi side can save
      // the same one and window.list can report it. One timestamp for the whole pick keeps the sweep and
      // the assignment consistent.
      const pickedAt = Date.now();
      const retireCurrent = async (keepTabId) => {
        if (current && typeof current.tabId === "number" && current.tabId !== keepTabId) {
          // Only a tab we can prove is Pi's is closed; a corrupted record naming a user tab must not turn a
          // new pick into "close that tab".
          const previous = await chrome.tabs.get(current.tabId).catch(() => null);
          if (previous && isPiRemovableTarget(previous)) await chrome.tabs.remove(current.tabId).catch(() => {});
        }
      };
      if (wanted === null) {
        // "A window of Pi's own" is gone, deliberately: automatic window creation was removed
        // because it kept creating a window Pi could not keep and then dropping the user's tab into
        // their own window. A window can only be used if it already exists AND the user picked it, so
        // there is nothing left for null to mean. Refuse with the fix instead of creating anything.
        throw new Error(
          "pi-chrome no longer creates a window of its own. Run /chrome window to pick one of your " +
            "open browser windows; that choice is saved for future sessions.",
        );
      }
      const win = await chrome.windows.get(wanted).catch(() => null);
      if (!win) throw new Error(`No browser window with id ${wanted}.`);
      // The pick is valid now, and window.select is one of the two places a pick enters this worker (the
      // other is preferredWindow on any command, via machineWindowPick). Mirror it the same way, so a
      // pick-less caller after a worker restart resolves into this window (R2). Deliberately AFTER the
      // existence check: a select naming a closed window must fail without becoming the remembered pick.
      // The connector key is kept from a previously mirrored pick when this worker cannot derive its own
      // id (storage unavailable), so that outage cannot silently downgrade the profile check to keyless.
      await hydratePreferredWindowPick();
      const ownKey = await selfClientKey();
      preferredWindowPick = { windowId: wanted, at: pickedAt, key: ownKey || preferredWindowPick?.key || null };
      await persistPreferredWindowPick(preferredWindowPick);
      // Already working in that window: keep the tab we have instead of churning a new one.
      if (typeof current?.tabId === "number") {
        const existing = await chrome.tabs.get(current.tabId).catch(() => null);
        if (existing && existing.windowId === wanted) {
          // The user has now chosen this window on purpose, so record it as the session's workspace.
          // For one of the user's windows the tab is a guest there (piWindow false) and cleanup closes
          // only the tab; for a Pi-created window the record stays a Pi window. The recorded window is
          // the setting later actions rebuild in, so a stale numeric Pi-window id must not survive here.
          const piWindow = isPiOwnedWindow(wanted) || current.piWindow === true;
          if (current.windowId !== wanted || current.piWindow !== piWindow || typeof current.pickedAt !== "number") {
            automationTargets.set(sessionKey, { windowId: wanted, tabId: current.tabId, piWindow, pickedAt });
            await persistAutomationTargets();
          }
          const swept = await sweepSupersededTargets(sessionKey, wanted, pickedAt);
          return { windowId: wanted, tabId: current.tabId, reused: true, pickedAt, swept };
        }
      }
      // Working somewhere else: MOVE the target tab we already have into the chosen window rather than
      // creating a replacement and closing the old one. The tab holds the agent's page — a half-filled
      // form, a logged-in session — and re-choosing a window must not throw that away; it also means Pi's
      // tab physically leaves the window it was in, which is what the user sees when they pick a new one.
      let tab = null;
      let moved = false;
      if (typeof current?.tabId === "number") {
        const existing = await chrome.tabs.get(current.tabId).catch(() => null);
        // Moving a tab is only safe for a tab we can prove is Pi's: a corrupted record naming one of the
        // user's tabs must not relocate it to a window they did not put it in.
        if (existing && typeof existing.id === "number" && isPiRemovableTarget(existing)) {
          const relocated = await chrome.tabs.move(existing.id, { windowId: wanted, index: -1 }).catch(() => null);
          if (relocated && typeof relocated.id === "number") {
            tab = await healMarkerTab(relocated);
            moved = true;
          }
        }
      }
      if (!tab) {
        // Created inactive, and the window is never focused: choosing a window must not bring that window,
        // or this tab, to the front.
        tab = await chrome.tabs.create({ url: BLANK_AUTOMATION_URL, active: false, windowId: wanted });
      }
      // Record the chosen window: this is the session's workspace setting. piWindow says who owns the
      // window, so cleanup closes the tab (and only the tab) in one of the user's windows.
      automationTargets.set(sessionKey, { windowId: wanted, tabId: tab.id, piWindow: isPiOwnedWindow(wanted), pickedAt });
      await persistAutomationTargets();
      if (moved) await regroupMovedTarget(tab);
      else await retireCurrent(tab.id);
      // A pick is machine-wide intent, so it is applied to every OTHER record still sitting in a window
      // nobody picked for it — on this action, not on some later one. This is what makes the user's window
      // stop holding Pi's tabs the moment they choose a different window, instead of until each abandoned
      // session happens to run again.
      const swept = await sweepSupersededTargets(sessionKey, wanted, pickedAt);
      // NOTE (follow-up, out of scope for the about:blank fix): the record above was written before
      // groupTab ran. If grouping ever relocates this tab (Chrome moves a tab that joins a group in
      // another window), the record's windowId no longer matches where the tab lives, and the next
      // implicit action's resolveOwnedAutomationTarget retires and recreates it. Re-read the tab's
      // windowId after groupTab and update the record (or record after grouping).
      await groupTab(tab, groupTitle, params.groupColor).catch(() => {});
      return { windowId: tab.windowId ?? null, tabId: tab.id ?? null, reused: false, moved, pickedAt, swept };
    }
    case "automation.status": {
      // Report this session's owned automation target (ids only). Used for diagnostics/tests.
      await hydrateAutomationTargets();
      const t = automationTargets.get(sessionKeyOf(params));
      return { windowId: t?.windowId ?? null, tabId: t?.tabId ?? null };
    }
    case "automation.cleanup":
      // Close recorded creations, and only ungroup user tabs still in their adopted group.
      // Group titles are not ownership evidence.
      return cleanupSessionTabs(sessionKeyOf(params));
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function formatTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title || "",
    url: tab.url || "",
    status: tab.status,
    pinned: tab.pinned,
    incognito: tab.incognito,
    groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
    group: await groupRecord(tab.groupId),
  };
}

// Resolve which Chrome tab an action targets.
//
// The session's automation target is found by its RECORDED tab id, never by url/title hints. Explicit
// targeting (targetId / urlIncludes / titleIncludes) is for a tab the caller deliberately points at
// (usually one of the user's), with one guard: when a url/title hint matches the session's own
// recorded target, the recorded target wins. A hint is not evidence — with two about:blank tabs the
// old first-match lookup drove whichever blank tab Chrome listed first (the user's), which is how
// chrome_navigate and chrome_evaluate ended up on different pages. Pi-owned automation tabs are also
// excluded from the selector search, so a hint can never discover another session's automation tab.
//
// `createOwnedTarget` controls the implicit case:
//   - true  (default): create the automation target on first use. Used by every page/content
//     action — page.navigate, click/type/fill/key/hover/drag/scroll/tap/upload, snapshot,
//     inspect, evaluate, screenshot, waitFor, console/network list, probe. These need a live
//     surface to drive, so auto-creating is correct and they no longer touch the user's tab.
//   - false: do NOT create. Used by tab.activate/close/group/ungroup (tab *management*): with no
//     explicit target they operate on an already-owned automation target if one exists, else
//     throw asking for an explicit target — so e.g. `chrome_tab close` can never silently close
//     the user's active tab the way it used to, and never spawns a throwaway tab just to close it.
async function getTabByParams(params, { createOwnedTarget = true } = {}) {
  const tabs = await chrome.tabs.query({});
  let tab;
  if (params.targetId !== undefined) {
    const id = Number(params.targetId);
    tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab?.id) {
      // Chrome tab ids are not stable across reloads/navigations; a long session can hold a
      // stale id. Surface the current tabs so the caller can re-target instead of guessing.
      const listed = tabs
        .filter((candidate) => candidate.id !== undefined)
        .slice(0, 20)
        .map((candidate) => `  ${candidate.id}${candidate.active ? " *" : ""}\t${(candidate.title || "(untitled)").slice(0, 60)}\t${candidate.url || ""}`)
        .join("\n");
      throw new Error(
        `No Chrome tab with id ${id} (it was likely closed or replaced). ` +
        `Re-target with chrome_tab list, or pass urlIncludes/titleIncludes instead of targetId.\n` +
        `Current tabs:\n${listed || "  (none)"}`,
      );
    }
    // An explicit targetId that names THIS session's own automation tab is still subject to the user's
    // newest pick: the tab is moved into the picked window first, so an explicit id cannot keep driving a
    // window the user has moved away from (the explicit id is how the agent usually addresses its own tab).
    // A targetId naming any other tab is left exactly where it is — that is a deliberate choice by the caller.
    await hydrateAutomationTargets();
    const ownerKey = sessionKeyOf(params);
    const ownRecord = automationTargets.get(ownerKey);
    if (ownRecord && typeof tab.id === "number" && ownRecord.tabId === tab.id) {
      const pick = await machineWindowPick(params);
      if (supersededByMachinePick(ownRecord, pick) && (await pickWindowIsOpen(pick.windowId))) {
        await retargetSupersededRecord(ownerKey, ownRecord, pick);
        await persistAutomationTargets();
        tab = (await chrome.tabs.get(tab.id).catch(() => null)) || tab;
      }
    }
  } else if (params.urlIncludes || params.titleIncludes) {
    const matches = (candidate) => {
      if (params.urlIncludes && !(candidate.url || "").includes(params.urlIncludes)) return false;
      if (params.titleIncludes && !(candidate.title || "").includes(params.titleIncludes)) return false;
      return true;
    };
    // The session's recorded target wins when the hint matches it: the recorded identity is the
    // source of truth, and a hint must never redirect Pi to a different tab that happens to match
    // (the two-about:blank live bug). If it does not match, the hint searches the browser's other
    // tabs — Pi-owned automation tabs are excluded so a hint cannot land on one.
    await hydrateAutomationTargets();
    const ownKey = sessionKeyOf(params);
    const own = automationTargets.get(ownKey);
    let candidates = tabs;
    if (own && typeof own.tabId === "number") {
      // A hint must not reach into a workspace the user has already replaced with their pick: a record the
      // machine-wide pick supersedes is moved (never silently kept where it is) before the hint is matched.
      const pick = await machineWindowPick(params);
      if (supersededByMachinePick(own, pick) && (await pickWindowIsOpen(pick.windowId))) {
        await retargetSupersededRecord(ownKey, own, pick);
        await persistAutomationTargets();
        // The candidate list was read before that tab moved, and moving changes where it lives, so re-read
        // the list the browser actually has.
        candidates = await chrome.tabs.query({}).catch(() => tabs);
      }
      // The session's recorded identity wins when the hint matches it: a hint must never redirect Pi to a
      // different tab that happens to match (the two-about:blank live bug). Read AFTER any supersede, so the
      // tab that just moved into the picked window is the one the hint resolves to.
      const settled = automationTargets.get(ownKey);
      if (settled && typeof settled.tabId === "number") {
        const ownTab = await chrome.tabs.get(settled.tabId).catch(() => null);
        if (ownTab && matches(ownTab)) tab = ownTab;
      }
    }
    if (!tab) tab = candidates.find((candidate) => matches(candidate) && !isPiChromeOwnedTarget(candidate.id));
  } else {
    // No explicit target: use this session's dedicated automation target instead of hijacking the
    // user's active tab. This keeps human browsing and Pi automation separated — navigating here
    // never replaces whatever the user currently has open. Callers that *want* a specific
    // existing tab pass targetId/urlIncludes/titleIncludes above.
    const sessionKey = sessionKeyOf(params);
    tab = createOwnedTarget
      ? await getOrCreateAutomationTarget(sessionKey, params.sessionGroupTitle, machinePickParams(params))
      : await resolveOwnedAutomationTarget(sessionKey, await machineWindowPick(params));
    if (!tab) {
      throw new Error(
        "No target tab specified and this Pi session has no automation tab yet. " +
        "Pass targetId/urlIncludes/titleIncludes, or run chrome_navigate first.",
      );
    }
  }
  if (!tab?.id) throw new Error("No matching Chrome tab found");
  // A Pi-owned tab that was moved out of its Pi window must not be driven or regrouped where it sits.
  // The implicit path already retired it in resolveOwnedAutomationTarget; this covers the explicit
  // selectors, which bypass that resolver by design, and refuses loudly instead of working in a window
  // the user owns.
  const movedTargetError = await movedAutomationTargetError(tab, sessionKeyOf(params));
  if (movedTargetError) throw new Error(movedTargetError);
  const url = tab.url || "";
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("devtools://")) {
    throw new Error(`Chrome blocks extension automation on protected URL: tab=${tab.id} url=${url}`);
  }
  // Tabs Pi interacts with (page.* actions) join this session's group so the user can see exactly
  // which tabs Pi is driving. We only adopt *ungrouped* tabs — never hijack a tab the user (or
  // another Pi session) already grouped, since groupTab would otherwise rename that group.
  if (params.joinSessionGroup && params.sessionGroupTitle) {
    await joinSessionGroup(tab, params.sessionGroupTitle, sessionKeyOf(params));
  }
  return tab;
}

// Add an ungrouped tab to the session's tab group (reusing it by title, else creating it).
// No-op when the tab is already grouped or tabGroups is unavailable.
async function joinSessionGroup(tab, title, sessionKey) {
  if (!chrome.tabGroups || typeof tab.id !== "number") return;
  if (typeof tab.groupId === "number" && tab.groupId >= 0) return;
  try {
    const grouped = await groupTab(tab, title);
    await trackSessionTab(sessionKey, tab.id, false, grouped.group?.id);
  } catch {
    // Grouping is best-effort; never block the actual page action on a grouping failure.
  }
}

// Helper sources that get concatenated into the injected MAIN-world script. Kept as separate
// functions so callers below can reference them by `.toString()`. The helpers do not perform any
// eval themselves — they're plain function declarations.
const HELPER_FUNCS = [
  getPiChromeState,
  rememberElement,
  elementBySelectorOrUid,
  installPiChromeInstrumentation,
  resolvePoint,
  dispatchInputEvents,
  setNativeValue,
  normalizeKey,
  isElementVisible,
  occluderAt,
  pageHash,
  pointerEventSequence,
  sleepPage,
  rand,
  dispatchPointerLikeEvent,
  humanMoveTo,
  humanClickPoint,
  usKeyLayoutForChar,
  printableKeyCode,
  dispatchKeyEvent,
  typeCharacter,
  pressKeyInPage,
  scrollPage,
];

async function executeInTab(params, func, args) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);

  // Phase 1: define the helpers and the action function as page globals via CDP
  // Runtime.evaluate. This bypasses page CSP (no `eval`/`new Function`), which is the
  // root cause of snapshot/click/etc silently failing on `script-src 'self'` sites.
  // Each helper is a named function declaration, assigned to window.<name> so the action
  // (which references helpers by bare name) resolves them as globals at call time.
  const assignments = HELPER_FUNCS.map((helper) => `window.${helper.name}=${helper.toString()}`).join(";\n");
  const actionAssign = `window.__piAction=(${func.toString()})`;
  const defineRes = await cdpEval(tab.id, `(()=>{${assignments};\n${actionAssign};})()`);
  if (defineRes.exceptionDetails) {
    throw new Error(`Failed to inject Chrome page helpers: ${cdpExceptionText(defineRes.exceptionDetails) || "unknown error"}`);
  }

  // Phase 2: run the action in the same MAIN world (executeScriptWithFallback falls back to CDP
  // Runtime.evaluate when Chrome refuses chrome.scripting on this URL, e.g. a fresh about:blank).
  const results = await executeScriptWithFallback({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        return { ok: true, value: await window.__piAction(...invocationArgs) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [args || []],
  }, `execute page action in tab ${tab.id}`);
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new Error(envelope.error || "Chrome page script failed");
  }
  return envelope?.value;
}

// Serializer for page.evaluate results. Embedded (via .toString()) into the CDP-evaluated
// expression so we can return rich markers for values that don't survive returnByValue
// (undefined/function/symbol/bigint/Error), plus expand DOMRect-like objects whose fields
// are non-enumerable. Kept as a standalone function so it stays editable/lintable.
function piEvalStringify(v) {
  if (v === undefined) return { kind: "undefined" };
  if (typeof v === "function") return { kind: "function", source: v.toString().slice(0, 500) };
  if (typeof v === "symbol") return { kind: "symbol", description: v.description };
  if (typeof v === "bigint") return { kind: "bigint", value: v.toString() };
  if (v instanceof Error) return { kind: "error", name: v.name, message: v.message, stack: v.stack };
  // DOMRect/DOMRectReadOnly (and getBoundingClientRect results) have non-enumerable
  // properties, so JSON.stringify yields `{}`. Expand the fields explicitly.
  if ((typeof DOMRectReadOnly !== "undefined" && v instanceof DOMRectReadOnly) ||
      (typeof DOMRect !== "undefined" && v instanceof DOMRect) ||
      (v && typeof v === "object" && typeof v.toJSON === "function" &&
       typeof v.width === "number" && typeof v.height === "number" && typeof v.top === "number")) {
    return { x: v.x, y: v.y, width: v.width, height: v.height, top: v.top, right: v.right, bottom: v.bottom, left: v.left };
  }
  return v;
}

// Dedicated executor for page.evaluate. Uses CDP Runtime.evaluate (via cdpEval) which is not
// subject to the page's CSP, fixing `chrome_evaluate` silently returning null / failing on
// pages that ship `script-src 'self'` without `'unsafe-eval'` (which blocks `eval`/`new Function`).
async function evaluateInTab(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  const expression = String(params.expression ?? "");
  const stringifySrc = `(${piEvalStringify.toString()})`;
  // Wrap the user expression so the result is run through piEvalStringify in-page before it
  // crosses the returnByValue boundary. Try expression form first (so `1+1` / `document.title`
  // work without `return`); on a SyntaxError fall back to statement form for multi-statement
  // bodies (loops, var decls, etc), matching the previous new Function() two-form behavior.
  const buildWrapper = (form) => `(async () => { const __s=${stringifySrc}; const __v = await ${form}; return __s(__v); })()`;
  const exprForm = `(async () => (${expression}))()`;
  const stmtForm = `(async () => { ${expression} })()`;

  let res = await cdpEval(tab.id, buildWrapper(exprForm));
  if (res.exceptionDetails && cdpIsSyntaxError(res.exceptionDetails)) {
    res = await cdpEval(tab.id, buildWrapper(stmtForm));
  }
  if (res.exceptionDetails) {
    throw new Error(`chrome_evaluate failed: ${cdpExceptionText(res.exceptionDetails) || "evaluation failed"}`);
  }
  const result = res.result;
  if (!result || result.type === "undefined") return undefined;
  const v = result.value;
  // Unwrap special markers produced by piEvalStringify.
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (v.kind === "undefined") return undefined;
    if (v.kind === "function") return `[Function: ${v.source}]`;
    if (v.kind === "symbol") return `[Symbol: ${v.description}]`;
    if (v.kind === "bigint") return v.value;
    if (v.kind === "error") throw new Error(`${v.name}: ${v.message}\n${v.stack || ""}`);
  }
  return v;
}

// Snapshot actions run the action then observe the page. A navigation started by the action is
// invisible to an immediate read: the snapshot can describe the OUTGOING document while the new one
// is still loading. Anchor the tab's url/status before the action, and when a load is plausibly in
// flight (the URL changed, or the tab was complete and is now loading) wait for it (bounded) before
// snapshotting. A tab that was ALREADY loading is reported but not waited on, so a hanging
// subresource cannot add a wait to every action. A timeout NEVER fails the action; it just reports
// navigation.settled=false so the caller knows the snapshot may be the old document.
async function withOptionalSnapshot(params, actionFn) {
  if (!params.includeSnapshot) return actionFn(params);
  let anchor = null;
  try {
    const tab = await getTabByParams(params);
    if (tab && typeof tab.id === "number") {
      const live = await chrome.tabs.get(tab.id).catch(() => null);
      anchor = {
        tabId: tab.id,
        params: { ...params, targetId: String(tab.id) },
        url: String(live?.url ?? tab.url ?? ""),
        status: String(live?.status ?? tab.status ?? ""),
      };
    }
  } catch {
    anchor = null; // Fall back to the old unanchored flow rather than failing the action.
  }
  const result = await actionFn(anchor ? anchor.params : params);
  let navigation;
  if (anchor) {
    const after = await chrome.tabs.get(anchor.tabId).catch(() => null);
    const afterUrl = String(after?.url ?? "");
    const urlChanged = Boolean(afterUrl && afterUrl !== anchor.url);
    const loading = after?.status === "loading";
    if (urlChanged || loading) {
      const bound = Math.min(Number(params.timeoutMs) || 15_000, 5_000);
      const started = Date.now();
      // Only wait when the action plausibly STARTED a load: the URL changed, or the tab was complete
      // before the action and is now loading. A tab that was already loading with the same URL
      // (hanging subresource/iframe/stream) stays flagged but must not add a bounded wait.
      const startedLoading = loading && (urlChanged || anchor.status === "complete");
      let settled = !loading;
      if (startedLoading) {
        try {
          await waitForTabComplete(anchor.tabId, bound);
          settled = true;
        } catch {
          settled = false; // Bounded wait: return the snapshot, flagged as possibly stale.
        }
      }
      const finalTab = await chrome.tabs.get(anchor.tabId).catch(() => after);
      navigation = { from: anchor.url, to: String(finalTab?.url ?? afterUrl), settled, waitedMs: Date.now() - started };
    }
  }
  const snapshot = await snapshotInTab(anchor ? { ...anchor.params, foreground: false } : { ...params, foreground: false });
  return navigation ? { result, snapshot, navigation } : { result, snapshot };
}

// Snapshot/inspect run from a packaged MAIN-world script (snapshot_injected.js) injected via
// chrome.scripting.executeScript({ files }), falling back to a CDP source injection when Chrome
// refuses scripting on the URL (see executeScriptWithFallback). That file is free of eval/new
// Function, so it works on strict-CSP pages, and it installs globalThis.__piChromeSnapshotPage /
// __piChromeInspectTarget. It shares window.__PI_CHROME_STATE__ (same el- uid scheme) with the
// CDP-injected input helpers.
async function snapshotInTab(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  const args = [
    params.maxElements || 80,
    params.containingText ?? null,
    params.roleFilter ?? null,
    params.nearUid ?? null,
    params.mode || "auto",
    params.query ?? null,
    params.maxTextChars ?? null,
  ];
  await executeScriptWithFallback({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    files: ["snapshot_injected.js"],
  }, `inject snapshot script in tab ${tab.id}`);
  const results = await executeScriptWithFallback({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        const snapshotPage = globalThis.__piChromeSnapshotPage;
        if (typeof snapshotPage !== "function") throw new Error("snapshot_injected.js did not install __piChromeSnapshotPage");
        return { ok: true, value: await snapshotPage(...invocationArgs) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [args],
  }, `run snapshot script in tab ${tab.id}`);
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new Error(envelope.error || "Chrome snapshot script failed");
  }
  return envelope?.value;
}

async function inspectInTab(params) {
  if (!params.uid && !params.selector) throw new Error("chrome_inspect requires uid or selector");
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  const args = [params.uid ?? null, params.selector ?? null, params.scrollIntoView === true];
  await executeScriptWithFallback({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    files: ["snapshot_injected.js"],
  }, `inject inspect script in tab ${tab.id}`);
  const results = await executeScriptWithFallback({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        const inspectTarget = globalThis.__piChromeInspectTarget;
        if (typeof inspectTarget !== "function") throw new Error("snapshot_injected.js did not install __piChromeInspectTarget");
        return { ok: true, value: await inspectTarget(...invocationArgs) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [args],
  }, `run inspect script in tab ${tab.id}`);
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new Error(envelope.error || "Chrome inspect script failed");
  }
  return envelope?.value;
}

// One-shot init script registry, scoped per tab. The source is registered with CDP
// Page.addScriptToEvaluateOnNewDocument, which runs it at document_start in the page's MAIN
// world and is NOT subject to page CSP (the old func:(code)=>new Function(code) path was
// blocked by `script-src 'self'`). page.navigate registers before the nav and unregisters
// after load, so only the intended navigation receives the script.
const initScriptIds = new Map(); // tabId -> CDP script identifier
async function registerInitScript(tabId, source) {
  await attachDebugger(tabId);
  await cdp(tabId, "Page.enable", {}).catch(() => undefined);
  const result = await cdp(tabId, "Page.addScriptToEvaluateOnNewDocument", { source });
  if (result && result.identifier !== undefined) initScriptIds.set(tabId, result.identifier);
}
async function unregisterInitScript(tabId) {
  const identifier = initScriptIds.get(tabId);
  if (identifier === undefined) return;
  initScriptIds.delete(tabId);
  await cdp(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => undefined);
}

// Always inject early console/network capture at document_start on every navigation.
// Catches console messages, errors, and network requests that fire during page load,
// before chrome_snapshot or chrome_evaluate install the instrumentation normally.
// The function installEarlyCapture sets __piChromeWrapped flags so the post-hoc
// installPiChromeInstrumentation() call is idempotent.
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      func: installEarlyCapture,
      args: [],
    }).catch(() => undefined);
  });
}

function foregroundRequested(params) {
  // Fail quiet when unspecified, and let background veto even a contradictory foreground flag.
  return params?.foreground === true && params.background !== true;
}

async function bringToFront(tab, params) {
  if (!foregroundRequested(params)) return tab;
  await chrome.windows.update(tab.windowId, { focused: true });
  return chrome.tabs.update(tab.id, { active: true });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for tab ${tabId} to load`));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// tab.new returns chrome.tabs.create's t=0 object ({url:"", title:"", status:"loading"}), which
// reads as "the URL never loaded" to an immediate consumer. Wait (bounded) for a real URL to reach
// complete, then report the SETTLED tab. A timeout never throws; about:blank never waits.
async function waitForCreatedTabLoad(tabId, url, requestedTimeoutMs) {
  const started = Date.now();
  const read = () => chrome.tabs.get(tabId).catch(() => null);
  if (!url || String(url) === "about:blank") return { loadStatus: "complete", tab: await read(), waitedMs: Date.now() - started };
  let tab = await read();
  if (tab?.status === "complete") return { loadStatus: "complete", tab, waitedMs: Date.now() - started };
  const bound = Math.min(Number(requestedTimeoutMs) || 15_000, 5_000);
  try {
    await waitForTabComplete(tabId, bound);
    return { loadStatus: "complete", tab: await read(), waitedMs: Date.now() - started };
  } catch {
    tab = await read();
    return { loadStatus: tab?.status === "complete" ? "complete" : "timedOut", tab, waitedMs: Date.now() - started };
  }
}

async function captureTabScreenshot(tabId, params) {
  const format = params.format || "png";
  try {
    await attachDebugger(tabId);
    const captureParams = { format, fromSurface: true, captureBeyondViewport: false };
    if (format === "jpeg" && params.quality !== undefined) captureParams.quality = params.quality;
    const result = await cdp(tabId, "Page.captureScreenshot", captureParams);
    if (typeof result?.data !== "string" || !result.data) throw new Error("CDP returned no screenshot data");
    return `data:image/${format};base64,${result.data}`;
  } catch (error) {
    // captureVisibleTab requires activation and can race with the user switching tabs. Never
    // use it as a fallback, even when debugger attachment or background rendering fails.
    throw new Error(`Chrome screenshot via CDP failed; no tab-activation fallback was attempted. ${error?.message || error}`);
  }
}

async function takeScreenshot(params) {
  const tab = await bringToFront(await getTabByParams(params), params);
  if (params.fullPage) {
    // Preserve the existing tile + manifest contract. Every tile captures the same resolved tab,
    // without activation; selector/title changes during capture must not retarget later tiles.
    const targetParams = { ...params, targetId: tab.id, foreground: false };
    const tiles = await executeInTab(targetParams, captureFullPageTiles, []);
    const captured = [];
    try {
      for (const tile of tiles.tiles) {
        await executeInTab(targetParams, scrollToY, [tile.scrollY]);
        await sleep(120); // Let scroll/lazy-load handlers settle.
        captured.push({ y: tile.y, dataUrl: await captureTabScreenshot(tab.id, params) });
      }
    } finally {
      // A failed tile must not strand the page at a new scroll position. Restore both axes
      // best-effort, without masking the capture error if the tab/debugger is gone.
      await executeInTab(targetParams, scrollToY, [tiles.originalScrollY, tiles.originalScrollX]).catch(() => undefined);
    }
    return {
      fullPage: true,
      method: "cdp",
      tab: await formatTab(tab),
      dimensions: { width: tiles.width, height: tiles.height, viewportHeight: tiles.viewportHeight, dpr: tiles.dpr },
      tiles: captured,
    };
  }
  const dataUrl = await captureTabScreenshot(tab.id, params);
  return { dataUrl, method: "cdp", tab: await formatTab(tab) };
}

// ---------------------------------------------------------------------------
// MAIN-world helpers (function declarations injected into the page).
// ---------------------------------------------------------------------------

function getPiChromeState() {
  const state = window.__PI_CHROME_STATE__ || {
    nextElementUid: 1,
    elements: {},
    console: [],
    network: [],
    nextRequestId: 1,
    instrumentationInstalled: false,
  };
  window.__PI_CHROME_STATE__ = state;
  return state;
}

function rememberElement(element) {
  const state = getPiChromeState();
  if (!element.__piChromeUid) element.__piChromeUid = "el-" + state.nextElementUid++;
  state.elements[element.__piChromeUid] = element;
  return element.__piChromeUid;
}

function elementBySelectorOrUid(selector, uid) {
  if (uid) {
    const element = getPiChromeState().elements[uid];
    if (!element || !element.isConnected) throw new Error(`No live element for uid: ${uid}. Take a fresh chrome_snapshot.`);
    return element;
  }
  if (selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`No element matches selector: ${selector}`);
    return element;
  }
  return null;
}

function isElementVisible(element) {
  if (!element || !element.getBoundingClientRect) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.bottom < 0 || rect.right < 0) return false;
  if (rect.top > innerHeight || rect.left > innerWidth) return false;
  return true;
}

function occluderAt(x, y, expected) {
  const top = document.elementFromPoint(x, y);
  if (!top || top === expected) return null;
  if (expected && expected.contains(top)) return null;
  if (top.contains(expected)) return null;
  return {
    tag: top.tagName.toLowerCase(),
    id: top.id || undefined,
    className: typeof top.className === "string" ? top.className : undefined,
  };
}

function pageHash() {
  // Cheap rolling hash used for `pageMutated`. Combines first 4kb of body innerText with the
  // current values of inputs/textareas (which are not part of innerText) and the count of
  // descendants of <body>. This catches: text changes, input value edits, and DOM structure
  // changes — the three things a click/type/fill might cause.
  const body = document.body;
  const text = (body ? body.innerText : "").slice(0, 4000);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  if (body) {
    const inputs = body.querySelectorAll("input,textarea,select");
    let valueBlob = "";
    for (let i = 0; i < inputs.length && valueBlob.length < 4000; i++) {
      const v = inputs[i].value;
      if (typeof v === "string") valueBlob += v + "\x00";
    }
    for (let i = 0; i < valueBlob.length; i++) h = (h * 31 + valueBlob.charCodeAt(i)) | 0;
    h = (h * 31 + body.getElementsByTagName("*").length) | 0;
  }
  return h;
}

function sleepPage(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function dispatchPointerLikeEvent(element, type, x, y, prevX, prevY, opts = {}) {
  const isPointer = type.startsWith("pointer");
  const Ctor = isPointer ? PointerEvent : MouseEvent;
  const isMove = type === "pointermove" || type === "mousemove";
  const isUpOrClick = type === "pointerup" || type === "mouseup" || type === "click";
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + (window.screenX || 0),
    screenY: y + (window.screenY || 0),
    movementX: Number.isFinite(prevX) ? x - prevX : 0,
    movementY: Number.isFinite(prevY) ? y - prevY : 0,
    button: 0,
    buttons: isMove || isUpOrClick ? 0 : 1,
  };
  if (isPointer) {
    init.pointerType = "mouse";
    init.pointerId = 1;
    init.isPrimary = true;
    init.width = 1;
    init.height = 1;
    init.pressure = opts.pressure ?? (type === "pointerdown" ? 0.5 : 0);
    init.tangentialPressure = 0;
    init.tiltX = 0;
    init.tiltY = 0;
  }
  const ev = new Ctor(type, init);
  element.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function pointerEventSequence(element, x, y, sequence) {
  let defaultPrevented = false;
  const state = getPiChromeState();
  const prevX = state.pointer?.x;
  const prevY = state.pointer?.y;
  for (const type of sequence) {
    defaultPrevented = dispatchPointerLikeEvent(element, type, x, y, prevX, prevY) || defaultPrevented;
  }
  state.pointer = { x, y, t: performance.now() };
  return defaultPrevented;
}

async function humanMoveTo(x, y, steps) {
  const state = getPiChromeState();
  const startX = Number.isFinite(state.pointer?.x) ? state.pointer.x : rand(12, Math.max(24, innerWidth - 12));
  const startY = Number.isFinite(state.pointer?.y) ? state.pointer.y : rand(12, Math.max(24, innerHeight - 12));
  const n = steps || Math.max(12, Math.min(42, Math.round(Math.hypot(x - startX, y - startY) / 18)));
  let prevX = startX, prevY = startY;
  let defaultPrevented = false;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 8;
    const px = startX + (x - startX) * ease + rand(-wobble, wobble);
    const py = startY + (y - startY) * ease + rand(-wobble, wobble);
    const el = document.elementFromPoint(px, py) || document.body || document.documentElement;
    defaultPrevented = dispatchPointerLikeEvent(el, "pointermove", px, py, prevX, prevY) || defaultPrevented;
    defaultPrevented = dispatchPointerLikeEvent(el, "mousemove", px, py, prevX, prevY) || defaultPrevented;
    prevX = px; prevY = py;
    await sleepPage(rand(4, 18));
  }
  state.pointer = { x, y, t: performance.now() };
  return defaultPrevented;
}

function humanClickPoint(point) {
  if (!point.rect) return { x: point.x, y: point.y };
  const rect = point.rect;
  const insetX = Math.min(rect.width * 0.35, Math.max(2, rect.width / 2 - 1));
  const insetY = Math.min(rect.height * 0.35, Math.max(2, rect.height / 2 - 1));
  return {
    x: rect.left + rect.width / 2 + rand(-insetX, insetX),
    y: rect.top + rect.height / 2 + rand(-insetY, insetY),
  };
}

function installPiChromeInstrumentation() {
  const state = getPiChromeState();
  if (state.instrumentationInstalled) return;
  state.instrumentationInstalled = true;
  const pushConsole = (level, args) => {
    state.console.push({
      id: state.console.length + 1,
      level,
      timestamp: Date.now(),
      url: location.href,
      args: Array.from(args).map((arg) => {
        try {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
          return JSON.parse(JSON.stringify(arg));
        } catch {
          return String(arg);
        }
      }),
    });
    if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
  };
  for (const level of ["debug", "log", "info", "warn", "error"]){
    const original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    const wrapped = function(...args) {
      pushConsole(level, args);
      return original.apply(this, args);
    };
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", (event) => pushConsole("pageerror", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]));
  window.addEventListener("unhandledrejection", (event) => pushConsole("unhandledrejection", [event.reason]));

  const trimBody = (text) => typeof text === "string" && text.length > 200000 ? text.slice(0, 200000) + `\n[truncated ${text.length - 200000} chars]` : text;
  const record = (entry) => {
    state.network.push(entry);
    if (state.network.length > 1000) state.network.splice(0, state.network.length - 1000);
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch = async (...args) => {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === "string" ? input : input?.url;
      const method = (init.method || input?.method || "GET").toUpperCase();
      const entry = record({ id, type: "fetch", method, url: String(url || ""), startedAt, pageUrl: location.href, status: "pending" });
      try {
        const response = await originalFetch(...args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.ok = response.ok;
        entry.responseUrl = response.url;
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = Array.from(response.headers.entries());
        response.clone().text().then((text) => {
          entry.responseBody = trimBody(text);
          entry.responseBodyTruncated = typeof text === "string" && text.length > 200000;
        }).catch((error) => { entry.responseBodyError = error?.message || String(error); });
        return response;
      } catch (error) {
        entry.error = error?.message || String(error);
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__piChromeRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function(body) {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const info = this.__piChromeRequest || {};
      const entry = record({ id, type: "xhr", method: info.method || "GET", url: info.url || "", startedAt, pageUrl: location.href, status: "pending" });
      this.addEventListener("loadend", () => {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.responseUrl = this.responseURL;
        entry.durationMs = Date.now() - startedAt;
        try { entry.responseHeadersText = this.getAllResponseHeaders(); } catch {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = trimBody(this.responseText);
            entry.responseBodyTruncated = this.responseText.length > 200000;
          }
        } catch (error) { entry.responseBodyError = error?.message || String(error); }
      });
      this.addEventListener("error", () => { entry.error = "XMLHttpRequest error"; entry.durationMs = Date.now() - startedAt; });
      return originalSend.call(this, body);
    };
  }
}

// Early-capture version of installPiChromeInstrumentation, designed to be injected
// at document_start via webNavigation.onCommitted. Wraps console, fetch, and XHR
// before the page's own JavaScript runs, so page-load errors are captured.
// Sets __piChromeWrapped flags so the post-hoc installPiChromeInstrumentation()
// sees them and skips (idempotent).
// NOTE: This function is self-contained — it does NOT close over any outer scope
// because it gets serialized by chrome.scripting.executeScript({func: ...}).
function installEarlyCapture() {
  if (window.__piChromeEarlyCaptureInstalled) return;
  window.__piChromeEarlyCaptureInstalled = true;
  var state = window.__PI_CHROME_STATE__;
  if (!state) {
    state = {
      nextElementUid: 1,
      elements: {},
      console: [],
      network: [],
      nextRequestId: 1,
      instrumentationInstalled: false,
    };
    window.__PI_CHROME_STATE__ = state;
  }
  function pushConsole(level, args) {
    state.console.push({
      id: state.console.length + 1,
      level: level,
      timestamp: Date.now(),
      url: location.href,
      args: Array.from(args).map(function(arg) {
        try {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
          return JSON.parse(JSON.stringify(arg));
        } catch (e) {
          return String(arg);
        }
      }),
    });
    if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
  }
  for (var i = 0; i < 5; i++) {
    var levels = ["debug", "log", "info", "warn", "error"];
    var level = levels[i];
    var original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    var wrapped = function(lvl, orig) {
      return function() {
        pushConsole(lvl, arguments);
        return orig.apply(this, arguments);
      };
    }(level, original);
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", function(event) {
    pushConsole("pageerror", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]);
  });
  window.addEventListener("unhandledrejection", function(event) {
    pushConsole("unhandledrejection", [event.reason]);
  });
  var trimBody = function(text) {
    return typeof text === "string" && text.length > 200000 ? text.slice(0, 200000) + "\n[truncated " + (text.length - 200000) + " chars]" : text;
  };
  var record = function(entry) {
    state.network.push(entry);
    if (state.network.length > 1000) state.network.splice(0, state.network.length - 1000);
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    var originalFetch = window.fetch.bind(window);
    var wrappedFetch = async function() {
      var args = [];
      for (var k = 0; k < arguments.length; k++) args.push(arguments[k]);
      var id = "req-" + state.nextRequestId++;
      var startedAt = Date.now();
      var input = args[0];
      var init = args[1] || {};
      var url = typeof input === "string" ? input : (input ? input.url : "");
      var method = (init.method || (input ? input.method : null) || "GET").toUpperCase();
      var entry = record({ id: id, type: "fetch", method: method, url: String(url || ""), startedAt: startedAt, pageUrl: location.href, status: "pending" });
      try {
        var response = await originalFetch.apply(window, args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.ok = response.ok;
        entry.responseUrl = response.url;
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = Array.from(response.headers.entries());
        response.clone().text().then(function(text) {
          entry.responseBody = trimBody(text);
          entry.responseBodyTruncated = typeof text === "string" && text.length > 200000;
        }).catch(function(error) { entry.responseBodyError = error ? error.message : String(error); });
        return response;
      } catch (error) {
        entry.error = error ? error.message : String(error);
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__piChromeRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function(body) {
      var id = "req-" + state.nextRequestId++;
      var startedAt = Date.now();
      var info = this.__piChromeRequest || {};
      var entry = record({ id: id, type: "xhr", method: info.method || "GET", url: info.url || "", startedAt: startedAt, pageUrl: location.href, status: "pending" });
      this.addEventListener("loadend", function() {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.responseUrl = this.responseURL;
        entry.durationMs = Date.now() - startedAt;
        try { entry.responseHeadersText = this.getAllResponseHeaders(); } catch (e) {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = trimBody(this.responseText);
            entry.responseBodyTruncated = this.responseText.length > 200000;
          }
        } catch (error) { entry.responseBodyError = error ? error.message : String(error); }
      });
      this.addEventListener("error", function() { entry.error = "XMLHttpRequest error"; entry.durationMs = Date.now() - startedAt; });
      return originalSend.apply(this, arguments);
    };
  }
  state.instrumentationInstalled = true;
}

function probePage() {
  // Sanity probe used by /chrome-doctor. Returns evidence that MAIN-world execution works.
  return {
    arithmetic: 1 + 1,
    location: location.href,
    title: document.title,
    documentReady: document.readyState,
    userAgent: navigator.userAgent.slice(0, 200),
    webdriver: !!navigator.webdriver,
  };
}

function captureFullPageTiles() {
  // Returns the plan for CDP tile capture in the worker: scroll positions and page metrics.
  const html = document.documentElement;
  const body = document.body;
  const width = Math.max(html.scrollWidth, body ? body.scrollWidth : 0, innerWidth);
  const height = Math.max(html.scrollHeight, body ? body.scrollHeight : 0, innerHeight);
  const viewportHeight = innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const originalScrollY = scrollY;
  const originalScrollX = scrollX;
  const tiles = [];
  let y = 0;
  while (y < height) {
    tiles.push({ y, scrollY: y });
    y += viewportHeight;
  }
  return { width, height, viewportHeight, dpr, originalScrollY, originalScrollX, tiles };
}

function scrollToY(y, x = 0) {
  window.scrollTo({ top: y, left: x, behavior: "instant" });
  return { scrollY };
}

function resolvePoint(selector, uid, x, y) {
  const element = elementBySelectorOrUid(selector, uid);
  if (element) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return { element, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
  }
  if (typeof x !== "number" || typeof y !== "number") throw new Error("Provide selector, uid, or x/y");
  return { element: document.elementFromPoint(x, y), x, y, rect: undefined };
}

async function clickPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element at click point");
  const clickPoint = humanClickPoint(point);
  point.x = clickPoint.x;
  point.y = clickPoint.y;
  point.element = document.elementFromPoint(point.x, point.y) || point.element;
  const visible = isElementVisible(point.element);
  const occluded = occluderAt(point.x, point.y, point.element);
  let defaultPrevented = await humanMoveTo(point.x, point.y);
  const state = getPiChromeState();
  const prevX = state.pointer?.x;
  const prevY = state.pointer?.y;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "pointerdown", point.x, point.y, prevX, prevY, { pressure: 0.5 }) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "mousedown", point.x, point.y, prevX, prevY) || defaultPrevented;
  if (typeof point.element.focus === "function" && /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/.test(point.element.tagName)) {
    try { point.element.focus({ preventScroll: true }); } catch { try { point.element.focus(); } catch {} }
  }
  await sleepPage(rand(45, 140));
  defaultPrevented = dispatchPointerLikeEvent(point.element, "pointerup", point.x, point.y, prevX, prevY) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "mouseup", point.x, point.y, prevX, prevY) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "click", point.x, point.y, prevX, prevY) || defaultPrevented;
  state.pointer = { x: point.x, y: point.y, t: performance.now() };
  // Heuristic: if the clicked thing looks like a media play affordance and the page has paused
  // audio/video, the DOM-event click may not unlock autoplay. Surface a warning.
  let autoplayHint;
  const labelRaw = (point.element.getAttribute("aria-label") || point.element.textContent || "").trim();
  const label = labelRaw.toLowerCase();
  if (/^(play|start|begin|next|continue|unmute)/.test(label)) {
    const idleMedia = Array.from(document.querySelectorAll("audio,video")).some((m) => m.paused);
    if (idleMedia) autoplayHint = "This element looks like a media affordance and the page has paused media. DOM-event clicks do not satisfy user-activation gates; audio/video may not start.";
  }
  const pageMutated = pageHash() !== before;
  // Smart-auto retry hint: only set when DOM-event path produced no observable change AND the
  // element looks gated, OR the page just emitted a user-activation rejection. The dispatcher
  // uses this to decide whether to retry with Chrome input.
  let suggestChromeInput = false;
  let suggestReason;
  if (!pageMutated) {
    if (autoplayHint) { suggestChromeInput = true; suggestReason = "play/media affordance + idle media"; }
    else if (/copy(\s|$)|paste|share|download|fullscreen|sign in with|continue with|allow|enable/i.test(label)) {
      suggestChromeInput = true; suggestReason = `label '${labelRaw.slice(0, 40)}' looks gated`;
    } else {
      // Inspect recent console errors for activation-gate rejections.
      const recent = (state.console || []).slice(-8);
      const hit = recent.find((e) => /NotAllowedError|Document is not focused|requires transient activation|gesture is required/.test(
        (e.args || []).map((a) => typeof a === "string" ? a : (a && a.message) || JSON.stringify(a)).join(" ")
      ));
      if (hit) { suggestChromeInput = true; suggestReason = "recent console error indicates user-activation gate"; }
    }
  }
  return {
    x: point.x,
    y: point.y,
    selector,
    uid,
    tag: point.element.tagName,
    label: labelRaw.slice(0, 80) || undefined,
    input: "dom",
    defaultPrevented,
    elementVisible: visible,
    occludedBy: occluded || undefined,
    pageMutated,
    autoplayHint,
    suggestChromeInput: suggestChromeInput || undefined,
    suggestReason,
  };
}

async function hoverPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element to hover");
  await humanMoveTo(point.x, point.y);
  const state = getPiChromeState();
  const prevX = state.pointer?.x, prevY = state.pointer?.y;
  let defaultPrevented = false;
  for (const type of ["pointerover", "mouseover", "pointerenter", "mouseenter"]) {
    defaultPrevented = dispatchPointerLikeEvent(point.element, type, point.x, point.y, prevX, prevY) || defaultPrevented;
  }
  // Small dwell so hover-intent handlers fire.
  await sleepPage(rand(80, 220));
  return { x: point.x, y: point.y, selector, uid, tag: point.element.tagName, defaultPrevented, input: "dom" };
}

async function dragPage(fromUid, fromSelector, fromX, fromY, toUid, toSelector, toX, toY, steps) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const from = resolvePoint(fromSelector, fromUid, fromX, fromY);
  const to = resolvePoint(toSelector, toUid, toX, toY);
  if (!from.element) throw new Error("Drag source element not found");
  if (!to.element) throw new Error("Drag target element not found");
  // Move to source.
  await humanMoveTo(from.x, from.y);
  const state = getPiChromeState();
  let prevX = state.pointer?.x, prevY = state.pointer?.y;
  // Build a shared DataTransfer so HTML5 drag-and-drop handlers can populate / read it.
  const dt = new DataTransfer();
  const dragInit = (type, target, x, y) => {
    const ev = new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y,
      screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
      button: 0, buttons: 1, view: window,
      dataTransfer: dt,
    });
    target.dispatchEvent(ev);
    return ev;
  };
  dispatchPointerLikeEvent(from.element, "pointerover", from.x, from.y, prevX, prevY);
  dispatchPointerLikeEvent(from.element, "pointerdown", from.x, from.y, prevX, prevY, { pressure: 0.5 });
  dispatchPointerLikeEvent(from.element, "mousedown", from.x, from.y, prevX, prevY);
  await sleepPage(rand(40, 110));
  dragInit("dragstart", from.element, from.x, from.y);
  dragInit("drag", from.element, from.x, from.y);
  let lastOver = from.element;
  const n = steps || 18;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 6;
    const x = from.x + (to.x - from.x) * ease + rand(-wobble, wobble);
    const y = from.y + (to.y - from.y) * ease + rand(-wobble, wobble);
    const overEl = document.elementFromPoint(x, y) || to.element;
    dispatchPointerLikeEvent(overEl, "pointermove", x, y, prevX, prevY);
    dispatchPointerLikeEvent(overEl, "mousemove", x, y, prevX, prevY);
    if (overEl !== lastOver) {
      dragInit("dragleave", lastOver, x, y);
      dragInit("dragenter", overEl, x, y);
      lastOver = overEl;
    }
    dragInit("dragover", overEl, x, y);
    dragInit("drag", from.element, x, y);
    prevX = x; prevY = y;
    await sleepPage(rand(8, 26));
  }
  dispatchPointerLikeEvent(to.element, "pointerover", to.x, to.y, prevX, prevY);
  dispatchPointerLikeEvent(to.element, "mouseover", to.x, to.y, prevX, prevY);
  dragInit("drop", to.element, to.x, to.y);
  dragInit("dragend", from.element, to.x, to.y);
  dispatchPointerLikeEvent(to.element, "pointerup", to.x, to.y, prevX, prevY);
  dispatchPointerLikeEvent(to.element, "mouseup", to.x, to.y, prevX, prevY);
  state.pointer = { x: to.x, y: to.y, t: performance.now() };
  return {
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    steps: n,
    pageMutated: pageHash() !== before,
    note: "DOM-event drag with HTML5 DragEvent + shared DataTransfer.",
  };
}

async function scrollPage(selector, uid, deltaY, deltaX, steps) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let target;
  if (selector || uid) {
    target = elementBySelectorOrUid(selector, uid);
  } else {
    target = document.scrollingElement || document.documentElement || document.body;
  }
  if (!target) throw new Error("No scroll target");
  const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const cx = Math.max(0, Math.min(innerWidth - 1, rect.left + Math.min(rect.width, innerWidth) / 2));
  const cy = Math.max(0, Math.min(innerHeight - 1, rect.top + Math.min(rect.height, innerHeight) / 2));
  const n = Math.max(3, Math.min(40, steps || Math.max(3, Math.ceil(Math.abs(deltaY || 0) / 100))));
  // Front-loaded wheel deltas, momentum-style.
  const totalY = deltaY || 0;
  const totalX = deltaX || 0;
  const weights = [];
  for (let i = 1; i <= n; i++) weights.push(1 / i);
  const sumW = weights.reduce((a, b) => a + b, 0);
  let movedY = 0, movedX = 0;
  for (let i = 0; i < n; i++) {
    const dy = totalY * (weights[i] / sumW);
    const dx = totalX * (weights[i] / sumW);
    const ev = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy,
      deltaX: dx, deltaY: dy, deltaMode: 0,
    });
    target.dispatchEvent(ev);
    if (!ev.defaultPrevented) {
      // Apply scroll ourselves; mirrors what the browser would do.
      if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
        window.scrollBy({ left: dx, top: dy, behavior: "instant" });
      } else {
        target.scrollTop += dy;
        target.scrollLeft += dx;
      }
    }
    movedY += dy; movedX += dx;
    await sleepPage(rand(12, 28));
  }
  return {
    deltaX: movedX, deltaY: movedY, steps: n,
    scrollTop: target.scrollTop, scrollLeft: target.scrollLeft,
    pageMutated: pageHash() !== before,
    input: "dom",
  };
}

function uploadFiles(selector, uid, files) {
  installPiChromeInstrumentation();
  const element = elementBySelectorOrUid(selector, uid);
  if (!element || element.tagName !== "INPUT" || element.type !== "file") {
    throw new Error("Target must be <input type=file>");
  }
  const dt = new DataTransfer();
  for (const f of files) {
    const bytes = Uint8Array.from(atob(f.base64 || ""), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream" }));
  }
  element.files = dt.files;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { uploaded: files.map((f) => ({ name: f.name, type: f.type, size: (f.base64 || "").length })) };
}

function dispatchInputEvents(element, data, inputType = "insertText") {
  element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data }));
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
}

function printableKeyCode(ch) {
  return ch.length === 1 ? usKeyLayoutForChar(ch).keyCode : 0;
}

function dispatchKeyEvent(element, type, key, mods = {}) {
  const SPECIAL = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, " ": 32, Shift: 16, Control: 17, Alt: 18, Meta: 91 };
  const code = key.length === 1 ? usKeyLayoutForChar(key).code : (key === " " ? "Space" : key);
  const keyCode = key.length === 1 ? printableKeyCode(key) : (SPECIAL[key] ?? 0);
  const ev = new KeyboardEvent(type, {
    key,
    code,
    keyCode,
    which: keyCode,
    charCode: type === "keypress" && key.length === 1 ? key.charCodeAt(0) : 0,
    shiftKey: !!mods.shiftKey,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    metaKey: !!mods.metaKey,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
  });
  element.dispatchEvent(ev);
  return ev;
}

async function typeCharacter(element, ch) {
  const needShift = ch.length === 1 && (/^[A-Z]$/.test(ch) || "~!@#$%^&*()_+{}|:\"<>?".includes(ch));
  if (needShift) {
    dispatchKeyEvent(element, "keydown", "Shift", { shiftKey: true });
    await sleepPage(rand(8, 24));
  }
  const mods = { shiftKey: needShift };
  const down = dispatchKeyEvent(element, "keydown", ch, mods);
  if (down.defaultPrevented) {
    if (needShift) dispatchKeyEvent(element, "keyup", "Shift", { shiftKey: false });
    return { defaultPrevented: true };
  }
  if (ch.length === 1) dispatchKeyEvent(element, "keypress", ch, mods);

  if (element.isContentEditable) {
    // execCommand("insertText") fires its own beforeinput + input. Don't double-dispatch.
    document.execCommand("insertText", false, ch);
  } else if ("value" in element) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    const next = element.value.slice(0, start) + ch + element.value.slice(end);
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch });
    element.dispatchEvent(before);
    if (!before.defaultPrevented) {
      setNativeValue(element, next);
      try { element.selectionStart = element.selectionEnd = start + ch.length; } catch {}
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
    }
  } else {
    throw new Error("Focused element is not text-editable");
  }

  await sleepPage(rand(25, 95));
  dispatchKeyEvent(element, "keyup", ch, mods);
  if (needShift) {
    await sleepPage(rand(5, 18));
    dispatchKeyEvent(element, "keyup", "Shift", { shiftKey: false });
  }
  await sleepPage(rand(35, 140));
  return { defaultPrevented: false };
}

async function typeIntoPage(selector, uid, text, pressEnter) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  const initialValue = "value" in element ? element.value : (element.isContentEditable ? element.textContent : null);
  element.focus();
  if (!(element.isContentEditable || "value" in element)) throw new Error("Focused element is not text-editable");
  for (const ch of Array.from(text)) await typeCharacter(element, ch);
  if (pressEnter) await pressKeyInPage("Enter");
  const finalValue = "value" in element ? element.value : element.textContent;
  const valueMatches = "value" in element ? element.value.includes(text) : (element.textContent || "").includes(text);
  const pageMutated = pageHash() !== before;
  // Smart-auto retry hint when typing didn't land at all (e.g., editor blocks DOM-event input).
  let suggestChromeInput = false, suggestReason;
  if (text.length > 0 && initialValue === finalValue) {
    suggestChromeInput = true;
    suggestReason = "value did not change — editor likely rejects DOM-event input";
  }
  return {
    selector, uid, length: text.length, pressEnter,
    input: "dom",
    valueMatches,
    pageMutated,
    suggestChromeInput: suggestChromeInput || undefined,
    suggestReason,
  };
}

async function fillPage(selector, uid, text, submit) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  element.focus();
  if (element.isContentEditable) {
    element.textContent = "";
    document.execCommand("insertText", false, text);
  } else if ("value" in element) {
    setNativeValue(element, text);
    const length = String(text).length;
    try { element.selectionStart = element.selectionEnd = length; } catch {}
    dispatchInputEvents(element, text, "insertReplacementText");
  } else {
    throw new Error("Focused element is not text-editable");
  }
  if (submit) await pressKeyInPage("Enter");
  return {
    selector, uid, length: String(text).length, submit,
    input: "dom",
    valueMatches: "value" in element ? element.value === String(text) : undefined,
    pageMutated: pageHash() !== before,
  };
}

async function pressKeyInPage(key) {
  const normalized = normalizeKey(key);
  const target = document.activeElement || document.body;
  const before = pageHash();
  const down = dispatchKeyEvent(target, "keydown", normalized);
  if (normalized.length === 1) dispatchKeyEvent(target, "keypress", normalized);
  // Character insertion for printable keys when focus is in an editable.
  if (normalized.length === 1 && !down.defaultPrevented && (target.isContentEditable || ("value" in target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")))) {
    if (target.isContentEditable) {
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: normalized });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        document.execCommand("insertText", false, normalized);
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: normalized }));
      }
    } else {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: normalized });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        setNativeValue(target, target.value.slice(0, start) + normalized + target.value.slice(end));
        try { target.selectionStart = target.selectionEnd = start + 1; } catch {}
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: normalized }));
      }
    }
  } else if (normalized === "Backspace" && "value" in target) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    if (start > 0 || end > start) {
      const from = start === end ? start - 1 : start;
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        setNativeValue(target, target.value.slice(0, from) + target.value.slice(end));
        try { target.selectionStart = target.selectionEnd = from; } catch {}
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }
    }
  }
  await sleepPage(rand(25, 95));
  const up = dispatchKeyEvent(target, "keyup", normalized);
  if (normalized === "Enter") {
    const form = target.closest?.("form");
    if (form) form.requestSubmit?.();
  }
  return {
    key: normalized,
    input: "dom",
    defaultPrevented: down.defaultPrevented || up.defaultPrevented,
    pageMutated: pageHash() !== before,
  };
}

function listConsoleMessages(clear) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const messages = state.console.slice();
  if (clear) state.console = [];
  return { messages, count: messages.length };
}

function listNetworkRequests(includePreservedRequests, clear) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const currentUrl = location.href;
  const requests = state.network
    .filter((request) => includePreservedRequests || request.pageUrl === currentUrl)
    .map(({ responseBody, ...summary }) => ({ ...summary, hasResponseBody: responseBody !== undefined }));
  if (clear) state.network = [];
  return { requests, count: requests.length, note: "Captures fetch/XHR after instrumentation is installed. Browser-initiated document/static asset requests are not captured." };
}

function getNetworkRequest(requestId) {
  installPiChromeInstrumentation();
  const request = getPiChromeState().network.find((entry) => entry.id === requestId);
  if (!request) throw new Error(`No network request with id ${requestId}`);
  return request;
}

function normalizeKey(key) {
  const table = {
    enter: "Enter",
    escape: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
  };
  return table[String(key).toLowerCase()] || key;
}
