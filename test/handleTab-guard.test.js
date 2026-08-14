"use strict";

// The pending-aware new-tab guard inside
// handleTab that silently closes only genuinely new, in-scope, non-excluded
// tabs opened while a closure is pending -- never the confirm window's own
// tab, never a pre-existing tab that is merely navigated, and never a
// pinned/domain-excepted tab.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChromeMock } = require("./support/chrome-mock");
const { loadBackground } = require("./support/load-background");

// enableTabLimit/enableDuplicateReuse are disabled so that, for the cases
// where the new guard clause does NOT fire and handleTab falls through,
// nothing beyond that guard's own tabsRemove call is exercised -- keeping
// each assertion focused on the guard itself.
const BASE_SETTINGS = {
  enableTabLimit: false,
  enableDuplicateReuse: false,
  ignoreSystemTabs: true,
  ignorePinnedTabs: true,
  applyLimitPerWindow: true
};

function setupHarness({ tabs, syncSettings = {}, pendingClosure }) {
  const mock = createChromeMock({
    tabs,
    syncSettings: { ...BASE_SETTINGS, ...syncSettings },
    sessionData: pendingClosure ? { pendingClosure } : {}
  });
  const context = loadBackground(mock.chrome);
  return { mock, context };
}

test("handleTab guard: never closes the confirm window's own tab", async () => {
  const currentTab = { id: 100, url: "https://example.com/new", windowId: 5 };
  const { mock, context } = setupHarness({
    tabs: [currentTab],
    pendingClosure: {
      confirmWindowId: 5,
      sourceWindowId: 5,
      existingTabIds: [] // absent from the snapshot -- would otherwise look "new"
    }
  });

  await context.handleTab(100);

  assert.equal(mock.calls.tabsRemove.length, 0, "the confirm window's own tab must never be closed");
});

test("handleTab guard: never closes a pre-existing tab that is merely navigated", async () => {
  const currentTab = { id: 101, url: "https://example.com/navigated", windowId: 6 };
  const { mock, context } = setupHarness({
    tabs: [currentTab],
    pendingClosure: {
      confirmWindowId: 999, // a different, unrelated window
      sourceWindowId: 6,
      existingTabIds: [101] // present in the snapshot -> pre-existing, not new
    }
  });

  await context.handleTab(101);

  assert.equal(mock.calls.tabsRemove.length, 0, "a pre-existing tab merely navigated must never be closed");
});

test("handleTab guard: never closes a pinned tab even if it is genuinely new", async () => {
  const currentTab = { id: 102, url: "https://example.com/pinned", windowId: 6, pinned: true };
  const { mock, context } = setupHarness({
    tabs: [currentTab],
    pendingClosure: {
      confirmWindowId: 999,
      sourceWindowId: 6,
      existingTabIds: []
    }
  });

  await context.handleTab(102);

  assert.equal(mock.calls.tabsRemove.length, 0, "a pinned tab must be excluded via shouldIgnoreTab");
});

test("handleTab guard: never closes a tab matching a domain exception even if it is genuinely new", async () => {
  const currentTab = { id: 103, url: "https://excluded.example.com/page", windowId: 6 };
  const { mock, context } = setupHarness({
    tabs: [currentTab],
    syncSettings: { domainRules: ["excluded.example.com"] },
    pendingClosure: {
      confirmWindowId: 999,
      sourceWindowId: 6,
      existingTabIds: []
    }
  });

  await context.handleTab(103);

  assert.equal(mock.calls.tabsRemove.length, 0, "a domain-excepted tab must be excluded via shouldIgnoreTab");
});

test("handleTab guard: closes a genuinely new, in-scope, non-excluded tab", async () => {
  const currentTab = { id: 104, url: "https://example.com/genuinely-new", windowId: 6 };
  const { mock, context } = setupHarness({
    tabs: [currentTab],
    pendingClosure: {
      confirmWindowId: 999,
      sourceWindowId: 6,
      existingTabIds: []
    }
  });

  await context.handleTab(104);

  assert.deepEqual(mock.calls.tabsRemove, [104], "a genuinely new, in-scope, non-excluded tab must be closed");
});

test("handleTab guard: applyLimitPerWindow=true leaves a new tab in a different window untouched", async () => {
  const currentTab = { id: 105, url: "https://example.com/other-window", windowId: 77 };
  const { mock, context } = setupHarness({
    tabs: [currentTab],
    syncSettings: { applyLimitPerWindow: true },
    pendingClosure: {
      confirmWindowId: 999,
      sourceWindowId: 6, // the closure was triggered in a different window
      existingTabIds: []
    }
  });

  await context.handleTab(105);

  assert.equal(
    mock.calls.tabsRemove.length,
    0,
    "a new tab outside sourceWindowId must be left alone when applyLimitPerWindow is true"
  );
});

test("handleTab guard: applyLimitPerWindow=false closes a new tab in a different window too", async () => {
  const currentTab = { id: 106, url: "https://example.com/other-window-2", windowId: 77 };
  const { mock, context } = setupHarness({
    tabs: [currentTab],
    syncSettings: { applyLimitPerWindow: false },
    pendingClosure: {
      confirmWindowId: 999,
      sourceWindowId: 6,
      existingTabIds: []
    }
  });

  await context.handleTab(106);

  assert.deepEqual(
    mock.calls.tabsRemove,
    [106],
    "applyLimitPerWindow=false scopes the guard globally, so this tab must be closed"
  );
});

test("handleTab guard: an unset confirmWindowId is treated as 'this counts as the confirm window' (creation-time race)", async () => {
  const currentTab = { id: 107, url: "https://example.com/race", windowId: 6 };
  const { mock, context } = setupHarness({
    tabs: [currentTab],
    pendingClosure: {
      // confirmWindowId intentionally absent -- enforceTabLimit hasn't
      // recorded it yet (the narrow race window Task 1/3 defend against).
      sourceWindowId: 6,
      existingTabIds: []
    }
  });

  await context.handleTab(107);

  assert.equal(
    mock.calls.tabsRemove.length,
    0,
    "an unset confirmWindowId must not license closing a new tab during the creation-time race"
  );
});
