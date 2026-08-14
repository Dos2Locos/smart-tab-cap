"use strict";

// Minimal hand-rolled chrome.* mock. Covers exactly the surface background.js
// touches (chrome.storage.sync/session/local, chrome.tabs, chrome.windows,
// chrome.runtime). No npm dependency (sinon, jest, etc.) is used, per project
// convention: no build step, zero dependencies.

function createChromeMock({ tabs = [], syncSettings = {}, sessionData = {} } = {}) {
  const tabsStore = tabs.map((tab) => ({ ...tab }));
  const syncStore = { ...syncSettings };
  const sessionStore = { ...sessionData };
  const localStore = {};

  const listeners = {
    onFocusChanged: [],
    onRemoved: [],
    onMessage: [],
    onInstalled: [],
    onStartup: [],
    onUpdated: [],
    onCreated: [],
    onChanged: []
  };

  const calls = {
    windowsUpdate: [],
    windowsCreate: [],
    tabsRemove: [],
    tabsUpdate: [],
    tabsCreate: []
  };

  let nextWindowId = 9000;
  let nextTabId = 7000;
  let windowsCreateImpl = async () => ({ id: nextWindowId++ });
  let lastFocusedWindow = { id: 1, left: 0, top: 0, width: 1440, height: 900 };
  // Empty by default so existing tests see no windows to sweep.
  let windowsList = [];
  // Tab groups the mock exposes. Empty by default; setTabGroups() per test.
  let tabGroupsList = [];
  let recentlyClosed = [];
  const restoreCalls = [];

  function storageGet(store, keyOrKeys) {
    const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : Object.keys(keyOrKeys || {});
    const defaults = typeof keyOrKeys === "string" ? {} : keyOrKeys || {};
    const result = {};
    for (const key of keys) {
      result[key] = key in store ? store[key] : defaults[key];
    }
    return result;
  }

  const chrome = {
    storage: {
      sync: {
        get: async (keyOrKeys) => storageGet(syncStore, keyOrKeys),
        set: async (items) => {
          Object.assign(syncStore, items);
        }
      },
      session: {
        get: async (keyOrKeys) => storageGet(sessionStore, keyOrKeys),
        set: async (items) => {
          Object.assign(sessionStore, items);
        },
        remove: async (key) => {
          delete sessionStore[key];
        }
      },
      local: {
        get: async (keyOrKeys) => storageGet(localStore, keyOrKeys),
        set: async (items) => {
          Object.assign(localStore, items);
        }
      },
      onChanged: {
        addListener: (fn) => listeners.onChanged.push(fn)
      }
    },
    tabs: {
      get: async (tabId) => {
        const tab = tabsStore.find((t) => t.id === tabId);
        if (!tab) {
          throw new Error("No tab with id: " + tabId);
        }
        return { ...tab };
      },
      query: async (query = {}) => {
        return tabsStore
          .filter((tab) => Object.keys(query).every((key) => tab[key] === query[key]))
          .map((tab) => ({ ...tab }));
      },
      create: async (props) => {
        calls.tabsCreate.push(props);
        const tab = { id: nextTabId++, windowId: 1, groupId: -1, ...props };
        tabsStore.push(tab);
        return { ...tab };
      },
      update: async (tabId, props) => {
        calls.tabsUpdate.push({ tabId, props });
        const tab = tabsStore.find((t) => t.id === tabId);
        if (tab) {
          Object.assign(tab, props);
        }
        return tab ? { ...tab } : undefined;
      },
      remove: async (tabId) => {
        calls.tabsRemove.push(tabId);
        const index = tabsStore.findIndex((t) => t.id === tabId);
        if (index >= 0) {
          tabsStore.splice(index, 1);
        }
      },
      onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) },
      onCreated: { addListener: (fn) => listeners.onCreated.push(fn) }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      create: async (options) => {
        calls.windowsCreate.push(options);
        return windowsCreateImpl(options);
      },
      update: async (windowId, props) => {
        calls.windowsUpdate.push({ windowId, props });
        const found = windowsList.find((w) => w.id === windowId);
        if (found) {
          Object.assign(found, props);
        }
      },
      get: async (windowId) => {
        const found = windowsList.find((w) => w.id === windowId);
        if (!found) {
          throw new Error("No window with id: " + windowId);
        }
        return { ...found };
      },
      getAll: async () => windowsList,
      // Bounds the popup-centring helper measures against. Overridable per test
      // via setLastFocusedWindow; null makes the call reject, standing in for
      // "no window to centre against".
      getLastFocused: async () => {
        if (lastFocusedWindow === null) {
          throw new Error("No focused window");
        }
        return lastFocusedWindow;
      },
      onFocusChanged: { addListener: (fn) => listeners.onFocusChanged.push(fn) },
      onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) }
    },
    sessions: {
      getRecentlyClosed: async () => recentlyClosed,
      restore: async (sessionId) => {
        restoreCalls.push(sessionId);
        const found = recentlyClosed.find((s) => s.tab?.sessionId === sessionId);
        if (!found) {
          throw new Error("Invalid session id");
        }
        return found;
      }
    },
    tabGroups: {
      query: async (query = {}) =>
        tabGroupsList.filter((group) =>
          Object.keys(query).every((key) => group[key] === query[key])
        )
    },
    runtime: {
      getURL: (relativePath) => "chrome-extension://test-extension-id/" + relativePath,
      onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
      onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
      onStartup: { addListener: (fn) => listeners.onStartup.push(fn) }
    }
  };

  return {
    chrome,
    listeners,
    calls,
    tabsStore,
    syncStore,
    sessionStore,
    setWindowsCreateImpl: (fn) => {
      windowsCreateImpl = fn;
    },
    setLastFocusedWindow: (window) => {
      lastFocusedWindow = window;
    },
    setWindows: (windows) => {
      windowsList = windows;
    },
    restoreCalls,
    setRecentlyClosed: (sessions) => {
      recentlyClosed = sessions;
    },
    removeSessionsApi: () => {
      delete chrome.sessions;
    },
    setTabGroups: (groups) => {
      tabGroupsList = groups;
    },
    // Stands in for the permission being absent or Chrome being too old.
    removeTabGroupsApi: () => {
      delete chrome.tabGroups;
    }
  };
}

module.exports = { createChromeMock };
