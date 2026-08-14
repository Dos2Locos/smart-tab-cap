"use strict";

// The chrome.windows.onRemoved reopen-on-
// system-close listener, plus the awaited pendingClosure removal in the
// existing chrome.runtime.onMessage handler (confirmClose / closeNewTab)
// that closes the race with the reopen listener.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChromeMock } = require("./support/chrome-mock");
const { loadBackground } = require("./support/load-background");

function getRemovedListener(mock) {
  loadBackground(mock.chrome);
  assert.equal(
    mock.listeners.onRemoved.length,
    1,
    "expected exactly one chrome.windows.onRemoved listener to be registered"
  );
  return mock.listeners.onRemoved[0];
}

function getMessageListener(mock) {
  loadBackground(mock.chrome);
  assert.equal(
    mock.listeners.onMessage.length,
    1,
    "expected exactly one chrome.runtime.onMessage listener to be registered"
  );
  return mock.listeners.onMessage[0];
}

function invokeMessageListener(listener, message) {
  return new Promise((resolve) => {
    const keepChannelOpen = listener(message, {}, resolve);
    assert.equal(
      keepChannelOpen,
      true,
      "the listener must return true to keep the async sendResponse channel open"
    );
  });
}

// -- onRemoved: reopen-on-system-close --

test("onRemoved: does nothing when there is no pendingClosure", async () => {
  const mock = createChromeMock();
  const listener = getRemovedListener(mock);

  await listener(42);

  assert.equal(mock.calls.windowsCreate.length, 0);
});

test("onRemoved: does nothing when the removed window is not the tracked confirm window", async () => {
  const mock = createChromeMock({
    sessionData: { pendingClosure: { confirmWindowId: 42, sourceWindowId: 1 } }
  });
  const listener = getRemovedListener(mock);

  await listener(999);

  assert.equal(mock.calls.windowsCreate.length, 0);
  assert.deepEqual(mock.sessionStore.pendingClosure, { confirmWindowId: 42, sourceWindowId: 1 });
});

test("onRemoved: reopens the confirm window and rewrites confirmWindowId, preserving other fields", async () => {
  const mock = createChromeMock({
    sessionData: {
      pendingClosure: {
        confirmWindowId: 42,
        sourceWindowId: 1,
        tabIdsToClose: [7, 8],
        excessCount: 2
      }
    }
  });
  const listener = getRemovedListener(mock);

  await listener(42);

  assert.equal(mock.calls.windowsCreate.length, 1);
  assert.equal(mock.calls.windowsCreate[0].url, mock.chrome.runtime.getURL("confirm.html"));

  const updated = mock.sessionStore.pendingClosure;
  assert.ok(updated, "pendingClosure must still be present after a successful reopen");
  assert.notEqual(updated.confirmWindowId, 42, "confirmWindowId must be rewritten to the newly created window's id");
  assert.equal(updated.sourceWindowId, 1);
  assert.deepEqual(updated.tabIdsToClose, [7, 8]);
  assert.equal(updated.excessCount, 2);
});

test("onRemoved: clears pendingClosure entirely when the reopen resolves without a usable id", async () => {
  const mock = createChromeMock({
    sessionData: { pendingClosure: { confirmWindowId: 42 } }
  });
  mock.setWindowsCreateImpl(async () => undefined);
  const listener = getRemovedListener(mock);

  await listener(42);

  assert.equal(mock.sessionStore.pendingClosure, undefined);
});

test("onRemoved: clears pendingClosure entirely when the reopen call rejects", async () => {
  const mock = createChromeMock({
    sessionData: { pendingClosure: { confirmWindowId: 42 } }
  });
  const listener = getRemovedListener(mock);
  mock.chrome.windows.create = async () => {
    throw new Error("create failed");
  };

  await listener(42);

  assert.equal(mock.sessionStore.pendingClosure, undefined);
});

// -- onMessage race-fix: pendingClosure removal awaited before sendResponse --

test("onMessage confirmClose: pendingClosure is removed before sendResponse fires, and still responds ok", async () => {
  const mock = createChromeMock({
    tabs: [{ id: 7, url: "https://example.com", title: "Example" }],
    sessionData: { pendingClosure: { tabIdsToClose: [7], confirmWindowId: 42 } }
  });
  const listener = getMessageListener(mock);

  const response = await invokeMessageListener(listener, { type: "confirmClose", tabIds: [7] });

  // NOTE: response is an object literal constructed inside the vm context
  // (a separate realm), so deepEqual against a main-realm literal fails
  // despite matching content ("same structure but not reference-equal").
  // Assert on the primitive field instead.
  assert.equal(response.ok, true);
  assert.equal(
    mock.sessionStore.pendingClosure,
    undefined,
    "pendingClosure must already be removed by the time sendResponse resolves"
  );
});

test("onMessage closeNewTab: pendingClosure is removed before sendResponse fires, and still responds ok", async () => {
  const mock = createChromeMock({
    tabs: [{ id: 9, url: "https://example.com", title: "Example" }],
    sessionData: { pendingClosure: { newTabId: 9, confirmWindowId: 42 } }
  });
  const listener = getMessageListener(mock);

  const response = await invokeMessageListener(listener, { type: "closeNewTab" });

  assert.equal(response.ok, true);
  assert.equal(
    mock.sessionStore.pendingClosure,
    undefined,
    "pendingClosure must already be removed by the time sendResponse resolves"
  );
});
