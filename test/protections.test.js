"use strict";

// Three protections that make the limit less hostile.
//   - a tab playing sound counts toward the limit but is never the one closed
//   - the limit is enforced after a browser restart, not only on the next new tab
//   - tracking parameters do not stop two tabs being recognised as duplicates

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChromeMock } = require("./support/chrome-mock");
const { loadBackground } = require("./support/load-background");

const SETTINGS = {
  enableTabLimit: true,
  enableDuplicateReuse: false,
  maxOpenTabs: 2,
  applyLimitPerWindow: true,
  ignorePinnedTabs: true,
  ignoreSystemTabs: true,
  confirmBeforeClose: false,
  onLimitExceeded: "closeLeastRecentlyUsed",
  protectAudibleTabs: true
};

function setup(tabs, overrides = {}) {
  const mock = createChromeMock({ tabs, syncSettings: { ...SETTINGS, ...overrides } });
  return { mock, context: loadBackground(mock.chrome) };
}

// ── Audible tabs ─────────────────────────────────────────────────────────────

test("audible: the tab playing sound is not the one closed, the next-oldest is", async () => {
  // Over the limit of 2 by one. The oldest tab is playing audio, so the
  // second-oldest must be sacrificed instead.
  const tabs = [
    { id: 1, url: "https://a.test/", windowId: 1, lastAccessed: 100, audible: true },
    { id: 2, url: "https://b.test/", windowId: 1, lastAccessed: 200 },
    { id: 3, url: "https://c.test/", windowId: 1, lastAccessed: 300, active: true }
  ];
  const { mock, context } = setup(tabs);

  await context.enforceTabLimit({ id: 3, windowId: 1 }, await context.getSettings());

  assert.deepEqual(mock.calls.tabsRemove, [2], "tab 1 is audible, so tab 2 goes instead");
});

test("audible: it still counts toward the limit — no free slot for playing sound", async () => {
  // 3 tabs, limit 2, the audible one is the oldest. If audible tabs did not
  // count, the total would be 2 and nothing would be closed at all.
  const tabs = [
    { id: 1, url: "https://a.test/", windowId: 1, lastAccessed: 100, audible: true },
    { id: 2, url: "https://b.test/", windowId: 1, lastAccessed: 200 },
    { id: 3, url: "https://c.test/", windowId: 1, lastAccessed: 300, active: true }
  ];
  const { mock, context } = setup(tabs);

  await context.enforceTabLimit({ id: 3, windowId: 1 }, await context.getSettings());

  assert.equal(mock.calls.tabsRemove.length, 1, "the limit still bit, so the audible tab was counted");
});

test("audible: protection off means the oldest goes, audible or not", async () => {
  const tabs = [
    { id: 1, url: "https://a.test/", windowId: 1, lastAccessed: 100, audible: true },
    { id: 2, url: "https://b.test/", windowId: 1, lastAccessed: 200 },
    { id: 3, url: "https://c.test/", windowId: 1, lastAccessed: 300, active: true }
  ];
  const { mock, context } = setup(tabs, { protectAudibleTabs: false });

  await context.enforceTabLimit({ id: 3, windowId: 1 }, await context.getSettings());

  assert.deepEqual(mock.calls.tabsRemove, [1]);
});

test("audible: when every candidate is protected, nothing is closed at all", async () => {
  // Standing down is deliberate: acting would break a protection the user
  // switched on. The limit simply does not bite this time.
  const tabs = [
    { id: 1, url: "https://a.test/", windowId: 1, lastAccessed: 100, audible: true },
    { id: 2, url: "https://b.test/", windowId: 1, lastAccessed: 200, audible: true },
    { id: 3, url: "https://c.test/", windowId: 1, lastAccessed: 300, active: true }
  ];
  const { mock, context } = setup(tabs);

  await context.enforceTabLimit({ id: 3, windowId: 1 }, await context.getSettings());

  assert.equal(mock.calls.tabsRemove.length, 0);
});

test("audible: the closeNewTab strategy still closes the new tab even if it is audible", async () => {
  // Protection covers picking victims among existing tabs. Here the user chose
  // "close the tab I just opened", and Chrome puts links opened from a grouped
  // or playing tab into similar company -- honouring protection here would stop
  // the limit working at all.
  const tabs = [
    { id: 1, url: "https://a.test/", windowId: 1, lastAccessed: 100 },
    { id: 2, url: "https://b.test/", windowId: 1, lastAccessed: 200 },
    { id: 3, url: "https://c.test/", windowId: 1, lastAccessed: 300, active: true, audible: true }
  ];
  const { mock, context } = setup(tabs, { onLimitExceeded: "closeNewTab" });

  await context.enforceTabLimit({ id: 3, windowId: 1 }, await context.getSettings());

  assert.deepEqual(mock.calls.tabsRemove, [3]);
});

test("audible: the confirm window is never offered a protected tab", async () => {
  const tabs = [
    { id: 1, url: "https://a.test/", windowId: 1, lastAccessed: 100, audible: true },
    { id: 2, url: "https://b.test/", windowId: 1, lastAccessed: 200 },
    { id: 3, url: "https://c.test/", windowId: 1, lastAccessed: 300, active: true }
  ];
  const { mock, context } = setup(tabs, { confirmBeforeClose: true });

  await context.enforceTabLimit({ id: 3, windowId: 1 }, await context.getSettings());

  // Spread into a host array: the value was built inside the vm realm.
  const offered = [...mock.sessionStore.pendingClosure.allTabs].map((t) => t.id);
  assert.ok(!offered.includes(1), "the audible tab must not be tickable");
  assert.deepEqual(offered.sort(), [2, 3]);
  assert.ok(
    mock.sessionStore.pendingClosure.excessCount <= offered.length,
    "Confirm must never demand more tabs than the list can supply"
  );
});

// ── Enforcement after a browser restart ──────────────────────────────────────

test("restart: the limit is enforced across every window, not just the active one", async () => {
  const tabs = [
    { id: 1, url: "https://a.test/", windowId: 1, lastAccessed: 100 },
    { id: 2, url: "https://b.test/", windowId: 1, lastAccessed: 200 },
    { id: 3, url: "https://c.test/", windowId: 1, lastAccessed: 300, active: true },
    { id: 11, url: "https://d.test/", windowId: 2, lastAccessed: 100 },
    { id: 12, url: "https://e.test/", windowId: 2, lastAccessed: 200 },
    { id: 13, url: "https://f.test/", windowId: 2, lastAccessed: 300, active: true }
  ];
  const { mock, context } = setup(tabs);
  mock.setWindows([{ id: 1 }, { id: 2 }]);

  await context.enforceLimitInAllWindows(await context.getSettings());

  assert.deepEqual(mock.calls.tabsRemove.sort((a, b) => a - b), [1, 11], "oldest tab in each window");
});

test("restart: nothing happens when the tab limit is disabled", async () => {
  const tabs = [
    { id: 1, url: "https://a.test/", windowId: 1, lastAccessed: 100 },
    { id: 2, url: "https://b.test/", windowId: 1, lastAccessed: 200 },
    { id: 3, url: "https://c.test/", windowId: 1, lastAccessed: 300, active: true }
  ];
  const { mock, context } = setup(tabs, { enableTabLimit: false });
  mock.setWindows([{ id: 1 }]);

  await context.enforceLimitInAllWindows(await context.getSettings());

  assert.equal(mock.calls.tabsRemove.length, 0);
});

test("restart: an onStartup listener is registered", () => {
  const { mock } = setup([]);

  assert.equal(mock.listeners.onStartup.length, 1);
});

// ── Tracking parameters ──────────────────────────────────────────────────────

test("tracking params: utm_* and click ids are stripped when matching duplicates", async () => {
  const { context } = setup([]);
  const settings = await context.getSettings();

  const cases = [
    ["https://x.test/post?utm_source=twitter&utm_medium=social", "https://x.test/post"],
    ["https://x.test/post?fbclid=abc123", "https://x.test/post"],
    ["https://x.test/post?gclid=xyz", "https://x.test/post?"],
    ["https://x.test/post?utm_campaign=a", "https://x.test/post?fbclid=b"],
    ["https://x.test/p?id=7&utm_source=n", "https://x.test/p?id=7"]
  ];

  for (const [a, b] of cases) {
    assert.equal(
      context.urlsMatch(a, b, settings),
      true,
      `${a} should match ${b}`
    );
  }
});

test("tracking params: meaningful params are left alone", async () => {
  const { context } = setup([]);
  const settings = await context.getSettings();

  // `id`, `page`, `q` and `ref` carry meaning on real sites. Stripping them
  // would merge two genuinely different pages into one.
  assert.equal(context.urlsMatch("https://x.test/p?id=1", "https://x.test/p?id=2", settings), false);
  assert.equal(context.urlsMatch("https://x.test/s?q=cats", "https://x.test/s?q=dogs", settings), false);
  assert.equal(context.urlsMatch("https://x.test/p?page=1", "https://x.test/p", settings), false);
  assert.equal(context.urlsMatch("https://x.test/p?ref=nav", "https://x.test/p", settings), false);
});

test("tracking params: with the setting off, utm_* makes two tabs distinct again", async () => {
  const { context } = setup([], { ignoreTrackingParams: false });
  const settings = await context.getSettings();

  assert.equal(
    context.urlsMatch("https://x.test/post?utm_source=twitter", "https://x.test/post", settings),
    false
  );
});

test("tracking params: a stripped URL leaves no dangling question mark", async () => {
  const { context } = setup([]);
  const settings = await context.getSettings();

  assert.equal(
    context.normalizeUrl("https://x.test/post?utm_source=a", settings),
    "https://x.test/post"
  );
});
