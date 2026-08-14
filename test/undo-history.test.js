"use strict";

// A closed tab is recorded with the sessionId that makes a
// real restore possible — navigation history and scroll, not just the URL.
// Extension-closed tabs do enter chrome.sessions, verified against a real Chrome.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChromeMock } = require("./support/chrome-mock");
const { loadBackground } = require("./support/load-background");

const SETTINGS = { enableTabLimit: false, enableDuplicateReuse: false, ignoreSystemTabs: true };

const VICTIM = { id: 7, url: "https://article.test/post", title: "Un artículo", windowId: 1 };

function setup({ tabs = [VICTIM], recentlyClosed = null } = {}) {
  const mock = createChromeMock({ tabs, syncSettings: SETTINGS });

  // Chrome's list is populated by the closure itself; the mock cannot know when,
  // so it is seeded up front with what the closure would produce.
  mock.setRecentlyClosed(
    recentlyClosed === null
      ? [{ tab: { sessionId: "sess-42", url: VICTIM.url, title: VICTIM.title } }]
      : recentlyClosed
  );

  return { mock, context: loadBackground(mock.chrome) };
}

function historyOf(mock) {
  // Reach into the mock's local store through the same API background.js uses,
  // so the assertion goes through the real path.
  return mock.chrome.storage.local.get({ closedTabsHistory: [] });
}

test("closing with record captures the sessionId for a real restore", async () => {
  const { mock, context } = setup();

  await context.closeTab(7, { record: true });

  const { closedTabsHistory } = await historyOf(mock);
  assert.equal(closedTabsHistory.length, 1);
  assert.equal(closedTabsHistory[0].sessionId, "sess-42");
  assert.equal(closedTabsHistory[0].url, VICTIM.url);
  assert.equal(closedTabsHistory[0].title, "Un artículo");
  assert.deepEqual(mock.calls.tabsRemove, [7], "and the tab really was closed");
});

test("the tab is removed before the history entry is written", async () => {
  // Order matters and is easy to regress: a sessionId does not exist until the
  // tab is gone, so recording first would always store null.
  const { mock, context } = setup();

  await context.closeTab(7, { record: true });

  const { closedTabsHistory } = await historyOf(mock);
  assert.ok(closedTabsHistory[0].sessionId, "a null here means the order flipped back");
});

test("no matching session leaves sessionId null but still records the tab", async () => {
  const { mock, context } = setup({ recentlyClosed: [{ tab: { sessionId: "other", url: "https://elsewhere.test/" } }] });

  await context.closeTab(7, { record: true });

  const { closedTabsHistory } = await historyOf(mock);
  assert.equal(closedTabsHistory[0].sessionId, null);
  assert.equal(closedTabsHistory[0].url, VICTIM.url, "the entry is still useful as a plain URL");
});

test("without the sessions API the closure still works and records a URL-only entry", async () => {
  const mock = createChromeMock({ tabs: [VICTIM], syncSettings: SETTINGS });
  mock.removeSessionsApi();
  const context = loadBackground(mock.chrome);

  await context.closeTab(7, { record: true });

  const { closedTabsHistory } = await historyOf(mock);
  assert.deepEqual(mock.calls.tabsRemove, [7]);
  assert.equal(closedTabsHistory[0].sessionId, null);
});

test("record: false writes no history at all", async () => {
  const { mock, context } = setup();

  await context.closeTab(7);

  const { closedTabsHistory } = await historyOf(mock);
  assert.equal(closedTabsHistory.length, 0);
  assert.deepEqual(mock.calls.tabsRemove, [7]);
});

test("system tabs are closed but never recorded", async () => {
  const systemTab = { id: 8, url: "chrome://settings", title: "Settings", windowId: 1 };
  const { mock, context } = setup({ tabs: [systemTab] });

  await context.closeTab(8, { record: true });

  const { closedTabsHistory } = await historyOf(mock);
  assert.equal(closedTabsHistory.length, 0);
  assert.deepEqual(mock.calls.tabsRemove, [8]);
});

test("history is capped at 50 entries, newest first", async () => {
  const mock = createChromeMock({ tabs: [VICTIM], syncSettings: SETTINGS });
  mock.setRecentlyClosed([{ tab: { sessionId: "sess-42", url: VICTIM.url } }]);
  await mock.chrome.storage.local.set({
    closedTabsHistory: Array.from({ length: 50 }, (_, i) => ({ url: `https://old${i}.test/`, closedAt: i }))
  });
  const context = loadBackground(mock.chrome);

  await context.closeTab(7, { record: true });

  const { closedTabsHistory } = await historyOf(mock);
  assert.equal(closedTabsHistory.length, 50);
  assert.equal(closedTabsHistory[0].url, VICTIM.url, "the new entry is first");
  assert.equal(closedTabsHistory[49].url, "https://old48.test/", "the oldest fell off");
});
