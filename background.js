const DEFAULT_SETTINGS = {
  maxOpenTabs: 20,
  enableDuplicateReuse: true,
  enableTabLimit: true,
  confirmBeforeClose: false,
  applyLimitPerWindow: true,
  ignorePinnedTabs: true,
  ignoreSystemTabs: true,
  ignoreHash: true,
  ignoreTrailingSlash: true,
  ignoreTrackingParams: true,
  duplicateMatchMode: "exact",
  onLimitExceeded: "closeLeastRecentlyUsed",
  protectAudibleTabs: true
};

const recentlyHandledTabs = new Set();

// Session restore repopulates tabs asynchronously; enforcing immediately would
// judge a half-restored window and close tabs that were still loading.
const STARTUP_SETTLE_MS = 5000;

// Params that identify how you arrived at a page, never which page it is. Kept
// deliberately conservative — anything ambiguous (`ref`, `source`, `id`) stays,
// because stripping a meaningful param would merge two genuinely different pages.
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "twclid",
  "yclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "vero_id",
  "oly_enc_id",
  "oly_anon_id"
]);

async function getSettings() {
  const settings = await chrome.storage.sync.get({ ...DEFAULT_SETTINGS, domainRules: [] });

  // A limit raised "for this session" lives in session storage so it survives
  // service-worker restarts but dies with the browser. It wins over the synced
  // value while it exists.
  const { sessionMaxOpenTabs } = await chrome.storage.session.get("sessionMaxOpenTabs");

  return sessionMaxOpenTabs ? { ...settings, maxOpenTabs: sessionMaxOpenTabs } : settings;
}

// The confirm window is the only caller, but it is still a message boundary.
// Rejects rather than rounds: silently flooring 12.7 to 12 could land the limit
// below the number of tabs already open, reopening the window at once.
function parseRaisedLimit(value) {
  const limit = Number(value);

  return Number.isInteger(limit) && limit >= 1 ? limit : null;
}

function isSystemUrl(url) {
  return (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:")
  );
}

function normalizeUrl(url, settings) {
  try {
    const parsedUrl = new URL(url);

    if (settings.ignoreHash) {
      parsedUrl.hash = "";
    }

    if (
      settings.ignoreTrailingSlash &&
      parsedUrl.pathname.endsWith("/") &&
      parsedUrl.pathname !== "/"
    ) {
      parsedUrl.pathname = parsedUrl.pathname.slice(0, -1);
    }

    if (settings.ignoreTrackingParams) {
      for (const key of [...parsedUrl.searchParams.keys()]) {
        if (TRACKING_PARAMS.has(key) || key.startsWith("utm_")) {
          parsedUrl.searchParams.delete(key);
        }
      }
      // Otherwise a stripped-clean URL keeps a dangling "?" and stops matching
      // the same page opened without params at all.
      parsedUrl.search = parsedUrl.searchParams.toString();
    }

    return parsedUrl.toString();
  } catch {
    return url;
  }
}

function urlsMatch(currentUrl, candidateUrl, settings) {
  const normalizedCurrentUrl = normalizeUrl(currentUrl, settings);
  const normalizedCandidateUrl = normalizeUrl(candidateUrl, settings);
  const mode = settings.duplicateMatchMode;

  if (mode !== "sameOrigin" && mode !== "samePath") {
    return normalizedCurrentUrl === normalizedCandidateUrl;
  }

  try {
    const currentParsedUrl = new URL(normalizedCurrentUrl);
    const candidateParsedUrl = new URL(normalizedCandidateUrl);

    return (
      currentParsedUrl.origin === candidateParsedUrl.origin &&
      (mode === "sameOrigin" || currentParsedUrl.pathname === candidateParsedUrl.pathname)
    );
  } catch {
    return false;
  }
}

async function focusTab(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

// A sessionId only exists once the tab is gone, so this must run after the
// removal. With it, reopening restores navigation history and scroll position;
// without it, all we can do is open the URL again.
async function closedTabSessionId(url) {
  try {
    const sessions = await chrome.sessions.getRecentlyClosed();
    const match = sessions.find((session) => session.tab?.url === url);

    return match?.tab?.sessionId || null;
  } catch {
    // No `sessions` permission, or the call failed: degrade to a URL-only entry.
    return null;
  }
}

async function addToHistory(tab) {
  const { closedTabsHistory = [] } = await chrome.storage.local.get({ closedTabsHistory: [] });
  const entry = {
    title: tab.title || tab.url,
    url: tab.url,
    favIconUrl: tab.favIconUrl || "",
    closedAt: Date.now(),
    sessionId: await closedTabSessionId(tab.url)
  };
  await chrome.storage.local.set({
    closedTabsHistory: [entry, ...closedTabsHistory].slice(0, 50)
  });
}

async function closeTab(tabId, { record = false } = {}) {
  const tab = record ? await chrome.tabs.get(tabId).catch(() => null) : null;

  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The tab may already be closed.
  }

  // Recorded after the removal, not before: the sessionId that makes a real
  // reopen possible does not exist until then.
  if (tab?.url && !isSystemUrl(tab.url)) {
    await addToHistory(tab);
  }
}

function matchesDomainRule(tab, domainRules) {
  if (!tab.url || !domainRules || !domainRules.length) {
    return false;
  }
  try {
    const hostname = new URL(tab.url).hostname;
    return domainRules.some(
      (domain) => hostname === domain || hostname.endsWith("." + domain)
    );
  } catch {
    return false;
  }
}

function shouldIgnoreTab(tab, settings) {
  if (!tab.id) {
    return true;
  }

  if (settings.ignorePinnedTabs && tab.pinned) {
    return true;
  }

  if (settings.ignoreSystemTabs && isSystemUrl(tab.url)) {
    return true;
  }

  if (matchesDomainRule(tab, settings.domainRules)) {
    return true;
  }

  return false;
}

// Counting and closing are separate questions, and conflating them was wrong.
// shouldIgnoreTab answers "does this tab exist as far as the limit is concerned".
// This answers "may the limit take this one away", which is a smaller set: a tab
// playing audio still consumes the limit -- it just is not the one that gets
// sacrificed.
function isProtectedFromClosing(tab, settings) {
  if (settings.protectAudibleTabs && tab.audible) {
    return true;
  }

  return false;
}

async function closeDuplicatesAcrossAllTabs(settings) {
  if (!settings.enableDuplicateReuse) {
    return;
  }

  const allTabs = await chrome.tabs.query({});
  const seen = [];

  for (const tab of allTabs) {
    if (!tab.url || shouldIgnoreTab(tab, settings)) {
      continue;
    }

    const original = seen.find((s) => urlsMatch(tab.url, s.url, settings));

    if (original) {
      await closeTab(tab.id, { record: false });
    } else {
      seen.push(tab);
    }
  }
}

async function findDuplicateTab(currentTab, settings) {
  if (!currentTab.url || isSystemUrl(currentTab.url)) {
    return null;
  }

  const tabs = await chrome.tabs.query({});

  return tabs.find((tab) => {
    if (!tab.id || tab.id === currentTab.id || !tab.url) {
      return false;
    }

    if (shouldIgnoreTab(tab, settings)) {
      return false;
    }

    return urlsMatch(currentTab.url, tab.url, settings);
  });
}

async function collapsedGroupIds(query) {
  try {
    const groups = await chrome.tabGroups.query(query);

    return new Set(groups.filter((group) => group.collapsed).map((group) => group.id));
  } catch {
    // tabGroups missing (permission revoked, or Chrome older than 89): fall back
    // to counting every tab on its own, which is the pre-Phase-06 behaviour.
    return new Set();
  }
}

// The limit counts what the user actually sees on the tab strip, so the unit is
// not the tab: a collapsed group is one item however many tabs it holds, while an
// expanded group's tabs are just tabs. Collapsed state is the reason this
// extension needs the tabGroups permission -- tab.groupId alone cannot reveal it
// permission.
async function getLimitableUnits(currentTab, settings) {
  const query = settings.applyLimitPerWindow
    ? { windowId: currentTab.windowId }
    : {};

  const tabs = (await chrome.tabs.query(query)).filter((tab) => !shouldIgnoreTab(tab, settings));
  const collapsed = await collapsedGroupIds(query);

  const units = [];
  const unitByGroup = new Map();

  for (const tab of tabs) {
    if (!collapsed.has(tab.groupId)) {
      units.push({ tabs: [tab], collapsedGroup: false, lastAccessed: tab.lastAccessed || 0 });
      continue;
    }

    let unit = unitByGroup.get(tab.groupId);

    if (!unit) {
      unit = { tabs: [], collapsedGroup: true, lastAccessed: 0 };
      unitByGroup.set(tab.groupId, unit);
      units.push(unit);
    }

    unit.tabs.push(tab);
    unit.lastAccessed = Math.max(unit.lastAccessed, tab.lastAccessed || 0);
  }

  return units;
}

// Chrome places popups wherever it likes -- usually offset toward the top-left
// corner. Centre them on the window the user is actually looking at.
async function centeredPosition(width, height) {
  try {
    const window = await chrome.windows.getLastFocused();

    if (!window?.width || !window?.height) {
      return {};
    }

    return {
      left: Math.max(0, Math.round((window.left || 0) + (window.width - width) / 2)),
      top: Math.max(0, Math.round((window.top || 0) + (window.height - height) / 2))
    };
  } catch {
    // No window to centre against; let Chrome pick the position.
    return {};
  }
}

async function openPopup(page, width, height) {
  return chrome.windows.create({
    url: chrome.runtime.getURL(page),
    type: "popup",
    width,
    height,
    focused: true,
    ...(await centeredPosition(width, height))
  });
}

function openConfirmWindow() {
  return openPopup("confirm.html", 520, 560);
}

// Tells the user which tab was closed for being a duplicate. Dismissible only by
// an explicit click in the popup -- no timeout, no dismiss-on-blur.
async function showDuplicateNotice(closedTab) {
  await chrome.storage.session.set({
    duplicateNotice: {
      closedTitle: closedTab.title || closedTab.url,
      closedUrl: closedTab.url
    }
  });

  // One popup per duplicate: a burst of duplicates yields a burst of popups.
  // Worth coalescing into a single notice if that ever shows up in practice.
  await openPopup("notice.html", 420, 300);
}

async function enforceTabLimit(currentTab, settings) {
  if (!settings.enableTabLimit) {
    return;
  }

  const units = await getLimitableUnits(currentTab, settings);

  if (units.length <= settings.maxOpenTabs) {
    return;
  }

  // A collapsed group occupies one unit but is never offered for closing:
  // sacrificing it would destroy every tab inside to reclaim a single slot.
  // Protection applies to picking victims among existing tabs, NOT to the
  // closeNewTab strategy, where the user explicitly asked for the tab they just
  // opened to go.
  const pickable = units
    .filter((unit) => !unit.collapsedGroup)
    .map((unit) => unit.tabs[0])
    .filter((tab) => tab.id === currentTab.id || !isProtectedFromClosing(tab, settings));

  const collapsedGroupCount = units.filter((unit) => unit.collapsedGroup).length;
  const excessCount = units.length - settings.maxOpenTabs;

  let tabIdsToClose;

  if (settings.onLimitExceeded === "closeNewTab") {
    tabIdsToClose = [currentTab.id];
  } else {
    tabIdsToClose = pickable
      .filter((tab) => tab.id !== currentTab.id && !tab.active)
      .sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0))
      .slice(0, excessCount)
      .map((tab) => tab.id);

    // Everything over the limit is protected or active. Acting anyway would
    // break a protection the user switched on, so stand down: the limit simply
    // does not bite this time.
    if (!tabIdsToClose.length) {
      return;
    }
  }

  if (!settings.confirmBeforeClose) {
    for (const id of tabIdsToClose) {
      await closeTab(id, { record: true });
    }
    return;
  }

  const existing = await chrome.storage.session.get("pendingClosure");
  if (existing.pendingClosure) {
    return;
  }

  // Only offer what may actually be closed, so a protected tab can never be
  // ticked. excessCount below is capped to match, or the Confirm button could
  // demand more tabs than the list can supply.
  const allTabsData = pickable
    .slice()
    .sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0))
    .map((tab) => ({
      id: tab.id,
      title: tab.title || tab.url,
      url: tab.url,
      favIconUrl: tab.favIconUrl || "",
      isNew: tab.id === currentTab.id
    }));

  const existingTabIds = (await chrome.tabs.query({})).map((tab) => tab.id);

  await chrome.storage.session.set({
    pendingClosure: {
      tabIdsToClose,
      allTabs: allTabsData,
      excessCount: Math.min(excessCount, allTabsData.length),
      collapsedGroupCount,
      // What the limit is actually compared against. allTabs below holds only the
      // CLOSABLE tabs, so using its length as the "raise the limit to" minimum
      // let the user pick a number they were still over -- reopening this very
      // window, which is the failure that minimum exists to prevent.
      unitCount: units.length,
      newTabId: currentTab.id,
      strategy: settings.onLimitExceeded,
      maxOpenTabs: settings.maxOpenTabs,
      existingTabIds
    }
  });

  const confirmWindow = await openConfirmWindow();

  if (confirmWindow?.id) {
    const { pendingClosure } = await chrome.storage.session.get("pendingClosure");
    await chrome.storage.session.set({
      pendingClosure: {
        ...pendingClosure,
        confirmWindowId: confirmWindow.id,
        sourceWindowId: currentTab.windowId
      }
    });
  }
}

// Shared by the options history and the toolbar popup, so there is one
// implementation of "bring this tab back" rather than a copy in each page.
async function reopenClosedTab(entry) {
  if (entry?.sessionId) {
    try {
      const session = await chrome.sessions.restore(entry.sessionId);

      // Scroll is only reapplied once the tab paints.
      if (session?.tab?.id) {
        await chrome.tabs.update(session.tab.id, { active: true });
      }

      return { restored: true };
    } catch {
      // Session ids go stale as Chrome's recently-closed list rolls over. Not
      // exceptional -- fall through to opening the URL.
    }
  }

  if (!entry?.url) {
    return { restored: false, opened: false };
  }

  await chrome.tabs.create({ url: entry.url });

  return { restored: false, opened: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "getStatus") {
    (async () => {
      const settings = await getSettings();
      const units = await getLimitableUnits({ id: -1, windowId: message.windowId }, settings);
      const { sessionMaxOpenTabs } = await chrome.storage.session.get("sessionMaxOpenTabs");

      sendResponse({
        units: units.length,
        collapsedGroups: units.filter((unit) => unit.collapsedGroup).length,
        maxOpenTabs: settings.maxOpenTabs,
        // Surfacing this is the point: the options page shows the synced value and
        // gives no hint that a session-only bump is in force.
        sessionOverride: sessionMaxOpenTabs || null,
        enableTabLimit: settings.enableTabLimit,
        applyLimitPerWindow: settings.applyLimitPerWindow
      });
    })();

    return true;
  }

  if (message.type === "reopenClosedTab") {
    (async () => {
      sendResponse(await reopenClosedTab(message.entry));
    })();

    return true;
  }

  if (message.type === "sweepDuplicatesNow") {
    (async () => {
      await sweepDuplicates();
      sendResponse({ ok: true });
    })();

    return true;
  }

  if (message.type === "confirmClose") {
    chrome.storage.session.get("pendingClosure").then(async ({ pendingClosure }) => {
      if (pendingClosure) {
        const idsToClose = message.tabIds || pendingClosure.tabIdsToClose || [];
        await Promise.all(idsToClose.map((id) => closeTab(id, { record: true })));
        await chrome.storage.session.remove("pendingClosure");
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "raiseLimit") {
    (async () => {
      const limit = parseRaisedLimit(message.maxOpenTabs);

      if (limit === null) {
        sendResponse({ ok: false, error: "invalid limit" });
        return;
      }

      if (message.scope === "always") {
        // Writing to sync fires onChanged, which drops any session override and
        // re-runs enforcement -- harmless, since the limit only went up.
        await chrome.storage.sync.set({ maxOpenTabs: limit });
      } else {
        await chrome.storage.session.set({ sessionMaxOpenTabs: limit });
      }

      await chrome.storage.session.remove("pendingClosure");
      sendResponse({ ok: true });
    })();

    return true;
  }

  if (message.type === "closeNewTab") {
    chrome.storage.session.get("pendingClosure").then(async ({ pendingClosure }) => {
      if (pendingClosure?.newTabId) {
        await closeTab(pendingClosure.newTabId, { record: true });
        await chrome.storage.session.remove("pendingClosure");
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});

async function handleTab(tabId) {
  if (recentlyHandledTabs.has(tabId)) {
    return;
  }

  let currentTab;

  try {
    currentTab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }

  const settings = await getSettings();

  if (settings.ignoreSystemTabs && isSystemUrl(currentTab.url)) {
    return;
  }

  const { pendingClosure } = await chrome.storage.session.get("pendingClosure");

  if (pendingClosure) {
    const isConfirmWindow =
      !pendingClosure.confirmWindowId || currentTab.windowId === pendingClosure.confirmWindowId;
    const isInScope = settings.applyLimitPerWindow
      ? currentTab.windowId === pendingClosure.sourceWindowId
      : true;
    const isNewlyOpenedTab = !(pendingClosure.existingTabIds || []).includes(currentTab.id);
    const isTabExcluded = shouldIgnoreTab(currentTab, settings);

    if (!isConfirmWindow && isInScope && isNewlyOpenedTab && !isTabExcluded) {
      await closeTab(tabId, { record: true });
      return;
    }
  }

  recentlyHandledTabs.add(tabId);

  setTimeout(() => {
    recentlyHandledTabs.delete(tabId);
  }, 2000);

  if (settings.enableDuplicateReuse && !shouldIgnoreTab(currentTab, settings)) {
    const existingTab = await findDuplicateTab(currentTab, settings);

    if (existingTab) {
      await focusTab(existingTab);
      await closeTab(tabId);

      // A pending closure owns the screen: its onFocusChanged listener would
      // immediately steal focus back from the notice, so stay quiet.
      if (!pendingClosure) {
        await showDuplicateNotice(currentTab);
      }

      return;
    }
  }

  await enforceTabLimit(currentTab, settings);
}

async function sweepDuplicates() {
  await closeDuplicatesAcrossAllTabs(await getSettings());
}

async function enforceLimitInAllWindows(settings) {
  if (!settings.enableTabLimit) {
    return;
  }

  for (const win of await chrome.windows.getAll({})) {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: win.id });

    if (activeTab) {
      await enforceTabLimit(activeTab, settings);
    }
  }
}

// Startup used to only dedupe, so a session restored well over the limit stayed
// over it until the user happened to open one more tab. Named rather than inline
// so the whole composed path can be driven directly in a real browser -- Chrome
// only fires onStartup on a genuine profile start, which a test cannot arrange.
async function handleStartup() {
  await sweepDuplicates();

  setTimeout(async () => {
    await enforceLimitInAllWindows(await getSettings());
  }, STARTUP_SETTLE_MS);
}

chrome.runtime.onInstalled.addListener(sweepDuplicates);
chrome.runtime.onStartup.addListener(handleStartup);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  if (!tab.url) {
    return;
  }

  handleTab(tabId);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.id) {
    return;
  }

  setTimeout(() => {
    handleTab(tab.id);
  }, 1000);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") {
    return;
  }

  // An explicit change to the limit -- from the options page or from "raise
  // always" -- supersedes an earlier session-only bump.
  if ("maxOpenTabs" in changes) {
    await chrome.storage.session.remove("sessionMaxOpenTabs");
  }

  const settings = await getSettings();

  await closeDuplicatesAcrossAllTabs(settings);
  await enforceLimitInAllWindows(settings);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const { pendingClosure } = await chrome.storage.session.get("pendingClosure");

  if (!pendingClosure?.confirmWindowId) {
    return;
  }

  if (windowId === pendingClosure.confirmWindowId) {
    return;
  }

  // Chrome losing focus to another application fires this with WINDOW_ID_NONE --
  // and so does minimising the confirm window while it is the only window open,
  // which is how a pending closure used to end up invisible with no way back
  // Those two cases need different answers:
  //
  //   - user switched to another app: touch nothing. Claiming focus, or even
  //     restoring a window, would yank them out of it.
  //   - confirm window minimised with nothing else open: un-minimise it, but do
  //     NOT ask for focus, since we cannot tell whether Chrome is even frontmost.
  const userIsStillInChrome = windowId !== chrome.windows.WINDOW_ID_NONE;

  try {
    if (!userIsStillInChrome) {
      const confirmWindow = await chrome.windows.get(pendingClosure.confirmWindowId);

      if (confirmWindow.state !== "minimized") {
        return;
      }

      await chrome.windows.update(pendingClosure.confirmWindowId, { state: "normal" });
      return;
    }

    await chrome.windows.update(pendingClosure.confirmWindowId, {
      focused: true,
      state: "normal"
    });
  } catch {
    // The confirm window may already be closed; onRemoved handles reopening it.
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { pendingClosure } = await chrome.storage.session.get("pendingClosure");

  if (!pendingClosure || pendingClosure.confirmWindowId !== windowId) {
    return;
  }

  try {
    const confirmWindow = await openConfirmWindow();

    if (!confirmWindow?.id) {
      await chrome.storage.session.remove("pendingClosure");
      return;
    }

    await chrome.storage.session.set({
      pendingClosure: { ...pendingClosure, confirmWindowId: confirmWindow.id }
    });
  } catch {
    // The reopen attempt failed; clear pendingClosure rather than leave a stale confirmWindowId.
    await chrome.storage.session.remove("pendingClosure");
  }
});
