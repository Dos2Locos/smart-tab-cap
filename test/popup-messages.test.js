"use strict";

// The toolbar popup reads its state through background.js
// rather than recomputing anything, so these messages are its whole contract.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChromeMock } = require("./support/chrome-mock");
const { loadBackground } = require("./support/load-background");

const SETTINGS = {
  enableTabLimit: true,
  enableDuplicateReuse: false,
  maxOpenTabs: 10,
  applyLimitPerWindow: true,
  ignoreSystemTabs: true,
  ignorePinnedTabs: true,
  protectAudibleTabs: true
};

function send(mock, message) {
  return new Promise((resolve) => {
    const kept = mock.listeners.onMessage[0](message, {}, resolve);
    assert.equal(kept, true, "the listener must keep the channel open");
  });
}

function setup({ tabs = [], syncSettings = {}, sessionData = {}, groups = [] } = {}) {
  const mock = createChromeMock({ tabs, syncSettings: { ...SETTINGS, ...syncSettings }, sessionData });
  mock.setTabGroups(groups);
  return { mock, context: loadBackground(mock.chrome) };
}

// ── getStatus ────────────────────────────────────────────────────────────────

test("getStatus reports the unit count, not the raw tab count", async () => {
  const { mock } = setup({
    tabs: [
      { id: 1, url: "https://a.test/", windowId: 1, groupId: 500 },
      { id: 2, url: "https://b.test/", windowId: 1, groupId: 500 },
      { id: 3, url: "https://c.test/", windowId: 1, groupId: 500 },
      { id: 4, url: "https://loose.test/", windowId: 1, groupId: -1 }
    ],
    groups: [{ id: 500, windowId: 1, collapsed: true }]
  });

  const status = await send(mock, { type: "getStatus", windowId: 1 });

  assert.equal(status.units, 2, "collapsed group (1) + loose tab (1)");
  assert.equal(status.collapsedGroups, 1);
  assert.equal(status.maxOpenTabs, 10);
  assert.equal(status.enableTabLimit, true);
  assert.equal(status.applyLimitPerWindow, true);
});

test("getStatus surfaces an active session override — the gap the options page left", async () => {
  const { mock } = setup({
    tabs: [{ id: 1, url: "https://a.test/", windowId: 1, groupId: -1 }],
    sessionData: { sessionMaxOpenTabs: 40 }
  });

  const status = await send(mock, { type: "getStatus", windowId: 1 });

  assert.equal(status.sessionOverride, 40, "so the popup can say the limit is temporary");
  assert.equal(status.maxOpenTabs, 40, "the effective limit");
});

test("getStatus reports no override when there is none", async () => {
  const { mock } = setup({ tabs: [{ id: 1, url: "https://a.test/", windowId: 1, groupId: -1 }] });

  const status = await send(mock, { type: "getStatus", windowId: 1 });

  assert.equal(status.sessionOverride, null);
});

test("getStatus scopes to the asked-for window when applyLimitPerWindow is on", async () => {
  const { mock } = setup({
    tabs: [
      { id: 1, url: "https://a.test/", windowId: 1, groupId: -1 },
      { id: 2, url: "https://b.test/", windowId: 2, groupId: -1 },
      { id: 3, url: "https://c.test/", windowId: 2, groupId: -1 }
    ]
  });

  assert.equal((await send(mock, { type: "getStatus", windowId: 1 })).units, 1);
  assert.equal((await send(mock, { type: "getStatus", windowId: 2 })).units, 2);
});

test("getStatus excludes ignored tabs, so the count matches what the limit sees", async () => {
  const { mock } = setup({
    tabs: [
      { id: 1, url: "https://a.test/", windowId: 1, groupId: -1 },
      { id: 2, url: "chrome://settings", windowId: 1, groupId: -1 },
      { id: 3, url: "https://pinned.test/", windowId: 1, groupId: -1, pinned: true }
    ]
  });

  assert.equal((await send(mock, { type: "getStatus", windowId: 1 })).units, 1);
});

// ── reopenClosedTab ──────────────────────────────────────────────────────────

test("reopenClosedTab restores through the session when the id is still valid", async () => {
  const { mock } = setup();
  mock.setRecentlyClosed([{ tab: { sessionId: "live-1", url: "https://gone.test/" } }]);

  const result = await send(mock, {
    type: "reopenClosedTab",
    entry: { url: "https://gone.test/", sessionId: "live-1" }
  });

  assert.equal(result.restored, true);
  assert.deepEqual([...mock.restoreCalls], ["live-1"]);
  assert.equal(mock.calls.windowsCreate.length, 0, "no new window, this is a tab restore");
});

test("reopenClosedTab falls back to opening the URL when the session id is stale", async () => {
  const { mock } = setup();
  mock.setRecentlyClosed([]); // the list rolled over, so restore() will reject

  const result = await send(mock, {
    type: "reopenClosedTab",
    entry: { url: "https://gone.test/", sessionId: "expired-9" }
  });

  assert.equal(result.restored, false);
  assert.equal(result.opened, true);
  assert.deepEqual([...mock.restoreCalls], ["expired-9"], "it did try the restore first");
  assert.ok(
    mock.tabsStore.some((tab) => tab.url === "https://gone.test/"),
    "and the URL was opened anyway"
  );
});

test("reopenClosedTab opens the URL directly for an entry with no session id", async () => {
  const { mock } = setup();

  const result = await send(mock, {
    type: "reopenClosedTab",
    entry: { url: "https://plain.test/", sessionId: null }
  });

  assert.equal(result.restored, false);
  assert.equal(result.opened, true);
  assert.equal(mock.restoreCalls.length, 0, "no point calling restore without an id");
});

test("reopenClosedTab reports failure rather than throwing on a useless entry", async () => {
  const { mock } = setup();

  const result = await send(mock, { type: "reopenClosedTab", entry: {} });

  assert.deepEqual({ ...result }, { restored: false, opened: false });
});

// ── sweepDuplicatesNow ───────────────────────────────────────────────────────

test("sweepDuplicatesNow closes duplicates on demand", async () => {
  const { mock } = setup({
    tabs: [
      { id: 1, url: "https://same.test/page", windowId: 1, groupId: -1 },
      { id: 2, url: "https://same.test/page", windowId: 1, groupId: -1 },
      { id: 3, url: "https://other.test/", windowId: 1, groupId: -1 }
    ],
    syncSettings: { enableDuplicateReuse: true, duplicateMatchMode: "exact" }
  });

  const result = await send(mock, { type: "sweepDuplicatesNow" });

  assert.deepEqual({ ...result }, { ok: true });
  assert.deepEqual(mock.calls.tabsRemove, [2], "the second copy goes, the first stays");
});

test("sweepDuplicatesNow respects the duplicate-reuse setting being off", async () => {
  const { mock } = setup({
    tabs: [
      { id: 1, url: "https://same.test/page", windowId: 1, groupId: -1 },
      { id: 2, url: "https://same.test/page", windowId: 1, groupId: -1 }
    ],
    syncSettings: { enableDuplicateReuse: false }
  });

  await send(mock, { type: "sweepDuplicatesNow" });

  assert.equal(mock.calls.tabsRemove.length, 0);
});
