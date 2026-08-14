"use strict";

// The limit counts what the tab strip shows. A collapsed
// group is one item however many tabs it holds; an expanded group's tabs are
// just tabs.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChromeMock } = require("./support/chrome-mock");
const { loadBackground } = require("./support/load-background");

const SETTINGS = {
  enableTabLimit: true,
  enableDuplicateReuse: false,
  maxOpenTabs: 3,
  applyLimitPerWindow: true,
  ignorePinnedTabs: true,
  ignoreSystemTabs: true,
  confirmBeforeClose: false,
  onLimitExceeded: "closeLeastRecentlyUsed",
  protectAudibleTabs: true
};

const GROUP = 900;

// Four tabs in one group plus two loose ones. With the group expanded that is
// six items; collapsed it is three.
function fixture() {
  return [
    { id: 1, url: "https://g1.test/", windowId: 1, lastAccessed: 100, groupId: GROUP },
    { id: 2, url: "https://g2.test/", windowId: 1, lastAccessed: 110, groupId: GROUP },
    { id: 3, url: "https://g3.test/", windowId: 1, lastAccessed: 120, groupId: GROUP },
    { id: 4, url: "https://g4.test/", windowId: 1, lastAccessed: 130, groupId: GROUP },
    { id: 5, url: "https://loose1.test/", windowId: 1, lastAccessed: 200, groupId: -1 },
    { id: 6, url: "https://loose2.test/", windowId: 1, lastAccessed: 300, groupId: -1, active: true }
  ];
}

function setup({ collapsed, overrides = {}, tabs = fixture() } = {}) {
  const mock = createChromeMock({ tabs, syncSettings: { ...SETTINGS, ...overrides } });
  mock.setTabGroups([{ id: GROUP, windowId: 1, collapsed: Boolean(collapsed), title: "Grupo" }]);
  return { mock, context: loadBackground(mock.chrome) };
}

test("expanded group: each of its tabs counts, so 6 items over a limit of 3 closes 3", async () => {
  const { mock, context } = setup({ collapsed: false });

  await context.enforceTabLimit({ id: 6, windowId: 1 }, await context.getSettings());

  assert.deepEqual(
    [...mock.calls.tabsRemove].sort((a, b) => a - b),
    [1, 2, 3],
    "the three oldest individual tabs"
  );
});

test("collapsed group: counts as one, so 3 items against a limit of 3 closes nothing", async () => {
  const { mock, context } = setup({ collapsed: true });

  await context.enforceTabLimit({ id: 6, windowId: 1 }, await context.getSettings());

  assert.equal(mock.calls.tabsRemove.length, 0, "collapsed group (1) + two loose tabs = 3, at the limit");
});

test("collapsed group: over the limit, only loose tabs are sacrificed — never the group", async () => {
  const { mock, context } = setup({ collapsed: true, overrides: { maxOpenTabs: 2 } });

  await context.enforceTabLimit({ id: 6, windowId: 1 }, await context.getSettings());

  assert.deepEqual(
    mock.calls.tabsRemove,
    [5],
    "the loose non-active tab goes; closing the group would destroy 4 tabs for 1 slot"
  );
  assert.ok(
    !mock.calls.tabsRemove.some((id) => [1, 2, 3, 4].includes(id)),
    "no tab inside the collapsed group may be touched"
  );
});

test("collapsed group: when it is the only thing over the limit, enforcement stands down", async () => {
  // Limit 1, and the only units are the collapsed group and the active tab.
  const tabs = [
    { id: 1, url: "https://g1.test/", windowId: 1, lastAccessed: 100, groupId: GROUP },
    { id: 2, url: "https://g2.test/", windowId: 1, lastAccessed: 110, groupId: GROUP },
    { id: 6, url: "https://loose.test/", windowId: 1, lastAccessed: 300, groupId: -1, active: true }
  ];
  const { mock, context } = setup({ collapsed: true, tabs, overrides: { maxOpenTabs: 1 } });

  await context.enforceTabLimit({ id: 6, windowId: 1 }, await context.getSettings());

  assert.equal(mock.calls.tabsRemove.length, 0);
});

test("collapsed group: the confirm window is told how many groups are counting", async () => {
  const { mock, context } = setup({ collapsed: true, overrides: { maxOpenTabs: 2, confirmBeforeClose: true } });

  await context.enforceTabLimit({ id: 6, windowId: 1 }, await context.getSettings());

  const pending = mock.sessionStore.pendingClosure;
  assert.equal(pending.collapsedGroupCount, 1);

  const offered = [...pending.allTabs].map((t) => t.id).sort((a, b) => a - b);
  assert.deepEqual(offered, [5, 6], "only loose tabs are offered, never the group's");
});

test("collapsed group: a group whose every tab is excluded contributes no unit", async () => {
  // The group's tabs are all system URLs, which shouldIgnoreTab drops. The group
  // must not conjure a unit out of nothing.
  const tabs = [
    { id: 1, url: "chrome://settings", windowId: 1, lastAccessed: 100, groupId: GROUP },
    { id: 2, url: "chrome://history", windowId: 1, lastAccessed: 110, groupId: GROUP },
    { id: 5, url: "https://loose1.test/", windowId: 1, lastAccessed: 200, groupId: -1 },
    { id: 6, url: "https://loose2.test/", windowId: 1, lastAccessed: 300, groupId: -1, active: true }
  ];
  const { mock, context } = setup({ collapsed: true, tabs, overrides: { maxOpenTabs: 2 } });

  await context.enforceTabLimit({ id: 6, windowId: 1 }, await context.getSettings());

  assert.equal(mock.calls.tabsRemove.length, 0, "two loose tabs against a limit of 2 is not over");
});

test("no tabGroups API: falls back to counting every tab on its own", async () => {
  // Permission revoked, or Chrome older than 89. The limit must keep working
  // rather than throw, even if collapsed groups stop being special.
  const mock = createChromeMock({ tabs: fixture(), syncSettings: { ...SETTINGS } });
  mock.setTabGroups([{ id: GROUP, windowId: 1, collapsed: true }]);
  mock.removeTabGroupsApi();
  const context = loadBackground(mock.chrome);

  await context.enforceTabLimit({ id: 6, windowId: 1 }, await context.getSettings());

  assert.deepEqual(
    [...mock.calls.tabsRemove].sort((a, b) => a - b),
    [1, 2, 3],
    "six tabs, limit 3, collapsed state unknowable — one unit per tab, as before groups were handled"
  );
});

test("two collapsed groups count as two, not as their tab totals", async () => {
  const OTHER = 901;
  const tabs = [
    { id: 1, url: "https://a1.test/", windowId: 1, lastAccessed: 100, groupId: GROUP },
    { id: 2, url: "https://a2.test/", windowId: 1, lastAccessed: 110, groupId: GROUP },
    { id: 3, url: "https://b1.test/", windowId: 1, lastAccessed: 120, groupId: OTHER },
    { id: 4, url: "https://b2.test/", windowId: 1, lastAccessed: 130, groupId: OTHER },
    { id: 6, url: "https://loose.test/", windowId: 1, lastAccessed: 300, groupId: -1, active: true }
  ];
  const mock = createChromeMock({ tabs, syncSettings: { ...SETTINGS, maxOpenTabs: 3 } });
  mock.setTabGroups([
    { id: GROUP, windowId: 1, collapsed: true },
    { id: OTHER, windowId: 1, collapsed: true }
  ]);
  const context = loadBackground(mock.chrome);

  await context.enforceTabLimit({ id: 6, windowId: 1 }, await context.getSettings());

  assert.equal(mock.calls.tabsRemove.length, 0, "2 collapsed groups + 1 loose tab = 3 items, at the limit");
});

// Regression: the confirm window's "raise the limit to" minimum came from
// pendingClosure.allTabs, which holds only the CLOSABLE tabs. The limit compares
// against the unit count, which also includes collapsed groups and protected
// tabs, so raising to allTabs.length could leave you still over the limit and
// reopen the window immediately — the exact failure that minimum exists to stop.
test("pendingClosure carries the unit count, not just the closable tabs", async () => {
  const OTHER = 902;
  const tabs = [
    { id: 1, url: "https://a1.test/", windowId: 1, lastAccessed: 100, groupId: GROUP },
    { id: 2, url: "https://a2.test/", windowId: 1, lastAccessed: 110, groupId: GROUP },
    { id: 3, url: "https://b1.test/", windowId: 1, lastAccessed: 120, groupId: OTHER },
    { id: 4, url: "https://b2.test/", windowId: 1, lastAccessed: 130, groupId: OTHER },
    { id: 5, url: "https://loose1.test/", windowId: 1, lastAccessed: 200, groupId: -1 },
    { id: 6, url: "https://loose2.test/", windowId: 1, lastAccessed: 300, groupId: -1, active: true }
  ];
  const mock = createChromeMock({
    tabs,
    syncSettings: { ...SETTINGS, maxOpenTabs: 2, confirmBeforeClose: true }
  });
  mock.setTabGroups([
    { id: GROUP, windowId: 1, collapsed: true },
    { id: OTHER, windowId: 1, collapsed: true }
  ]);
  const context = loadBackground(mock.chrome);

  await context.enforceTabLimit({ id: 6, windowId: 1 }, await context.getSettings());

  const pending = mock.sessionStore.pendingClosure;

  // 2 collapsed groups + 2 loose tabs = 4 units, but only the 2 loose tabs are
  // offered for closing.
  assert.equal([...pending.allTabs].length, 2, "only closable tabs are offered");
  assert.equal(
    pending.unitCount,
    4,
    "raising the limit to 2 would leave 4 units over a limit of 2 and reopen this window"
  );
});
