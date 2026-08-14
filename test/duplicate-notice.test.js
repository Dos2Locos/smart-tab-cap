"use strict";

// When handleTab reuses an existing tab and
// closes the duplicate, it must hand the closed tab's identity to notice.html
// via chrome.storage.session and open the notice popup -- except while a
// closure is pending, where the confirm window's aggressive refocus owns the screen.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChromeMock } = require("./support/chrome-mock");
const { loadBackground } = require("./support/load-background");

const BASE_SETTINGS = {
  enableDuplicateReuse: true,
  enableTabLimit: false,
  duplicateMatchMode: "exact",
  ignoreHash: true,
  ignoreTrailingSlash: true,
  ignoreSystemTabs: true,
  ignorePinnedTabs: true
};

const KEPT = { id: 200, url: "https://example.com/page", title: "Existing page", windowId: 1 };
const DUPLICATE = { id: 201, url: "https://example.com/page", title: "Same page again", windowId: 1 };

function setup({ syncSettings = {}, pendingClosure } = {}) {
  const mock = createChromeMock({
    tabs: [KEPT, DUPLICATE],
    syncSettings: { ...BASE_SETTINGS, ...syncSettings },
    sessionData: pendingClosure ? { pendingClosure } : {}
  });
  return { mock, context: loadBackground(mock.chrome) };
}

function noticeWindows(mock) {
  return mock.calls.windowsCreate.filter((options) => options.url.endsWith("notice.html"));
}

test("duplicate notice: records the closed tab and opens the notice popup", async () => {
  const { mock, context } = setup();

  await context.handleTab(DUPLICATE.id);

  assert.deepEqual(
    mock.calls.tabsRemove,
    [DUPLICATE.id],
    "the duplicate tab is the one closed, not the tab that was kept"
  );

  // Spread into a host object: the value was built inside the vm realm, whose
  // Object.prototype deepStrictEqual would otherwise reject.
  assert.deepEqual({ ...mock.sessionStore.duplicateNotice }, {
    closedTitle: "Same page again",
    closedUrl: "https://example.com/page"
  });

  assert.equal(noticeWindows(mock).length, 1, "exactly one notice popup is opened");
  assert.equal(noticeWindows(mock)[0].type, "popup");
  assert.equal(noticeWindows(mock)[0].focused, true);
});

test("duplicate notice: stays quiet while a closure is pending", async () => {
  const { mock, context } = setup({
    pendingClosure: {
      confirmWindowId: 999,
      sourceWindowId: 1,
      // Present in the snapshot, so the pending-tab guard treats it as
      // pre-existing and lets it fall through to the duplicate check.
      existingTabIds: [KEPT.id, DUPLICATE.id]
    }
  });

  await context.handleTab(DUPLICATE.id);

  assert.deepEqual(mock.calls.tabsRemove, [DUPLICATE.id], "the duplicate is still closed");
  assert.equal(
    mock.sessionStore.duplicateNotice,
    undefined,
    "no notice is recorded while a closure is pending"
  );
  assert.equal(noticeWindows(mock).length, 0, "no notice popup competes with the confirm window");
});

test("duplicate notice: nothing is opened when there is no duplicate to close", async () => {
  const mock = createChromeMock({
    tabs: [KEPT],
    syncSettings: BASE_SETTINGS
  });
  const context = loadBackground(mock.chrome);

  await context.handleTab(KEPT.id);

  assert.equal(mock.calls.tabsRemove.length, 0);
  assert.equal(mock.sessionStore.duplicateNotice, undefined);
  assert.equal(noticeWindows(mock).length, 0);
});

test("duplicate notice: disabling enableDuplicateReuse suppresses both the close and the notice", async () => {
  const { mock, context } = setup({ syncSettings: { enableDuplicateReuse: false } });

  await context.handleTab(DUPLICATE.id);

  assert.equal(mock.calls.tabsRemove.length, 0);
  assert.equal(mock.sessionStore.duplicateNotice, undefined);
  assert.equal(noticeWindows(mock).length, 0);
});

// Popups are centred on the window the user is looking at -- Chrome otherwise
// drops them toward the top-left corner.
test("duplicate notice: the popup is centred on the last focused window", async () => {
  const { mock, context } = setup();
  mock.setLastFocusedWindow({ id: 1, left: 100, top: 50, width: 1440, height: 900 });

  await context.handleTab(DUPLICATE.id);

  const [popup] = noticeWindows(mock);
  assert.equal(popup.width, 420);
  assert.equal(popup.height, 300);
  // 100 + (1440 - 420)/2 = 610 ; 50 + (900 - 300)/2 = 350
  assert.equal(popup.left, 610);
  assert.equal(popup.top, 350);
});

test("duplicate notice: a popup wider than the window is clamped to 0, never negative", async () => {
  const { mock, context } = setup();
  mock.setLastFocusedWindow({ id: 1, left: 0, top: 0, width: 300, height: 200 });

  await context.handleTab(DUPLICATE.id);

  const [popup] = noticeWindows(mock);
  assert.equal(popup.left, 0, "a negative left would push the popup off screen");
  assert.equal(popup.top, 0);
});

test("duplicate notice: falls back to Chrome's placement when there is no window to centre on", async () => {
  const { mock, context } = setup();
  mock.setLastFocusedWindow(null); // getLastFocused rejects

  await context.handleTab(DUPLICATE.id);

  const [popup] = noticeWindows(mock);
  assert.equal(popup.left, undefined, "no left/top is sent, so Chrome decides");
  assert.equal(popup.top, undefined);
  assert.equal(popup.focused, true, "the popup still opens");
});
