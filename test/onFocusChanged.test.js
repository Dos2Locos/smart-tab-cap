"use strict";

// The chrome.windows.onFocusChanged listener that
// aggressively refocuses + un-minimizes the tracked confirm window.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChromeMock } = require("./support/chrome-mock");
const { loadBackground } = require("./support/load-background");

function getFocusChangedListener(mock) {
  loadBackground(mock.chrome);
  assert.equal(
    mock.listeners.onFocusChanged.length,
    1,
    "expected exactly one chrome.windows.onFocusChanged listener to be registered"
  );
  return mock.listeners.onFocusChanged[0];
}

test("onFocusChanged: does nothing when no pendingClosure exists", async () => {
  const mock = createChromeMock();
  const listener = getFocusChangedListener(mock);

  await listener(555);

  assert.equal(mock.calls.windowsUpdate.length, 0);
});

test("onFocusChanged: does nothing when pendingClosure has no confirmWindowId yet (creation-time race)", async () => {
  const mock = createChromeMock({
    sessionData: { pendingClosure: { tabIdsToClose: [] } }
  });
  const listener = getFocusChangedListener(mock);

  await listener(555);

  assert.equal(mock.calls.windowsUpdate.length, 0);
});

test("onFocusChanged: does nothing when the newly-focused window IS the confirm window", async () => {
  const mock = createChromeMock({
    sessionData: { pendingClosure: { confirmWindowId: 42 } }
  });
  const listener = getFocusChangedListener(mock);

  await listener(42);

  assert.equal(mock.calls.windowsUpdate.length, 0);
});

test("onFocusChanged: does nothing when Chrome itself loses all focus (WINDOW_ID_NONE)", async () => {
  const mock = createChromeMock({
    sessionData: { pendingClosure: { confirmWindowId: 42 } }
  });
  const listener = getFocusChangedListener(mock);

  await listener(mock.chrome.windows.WINDOW_ID_NONE);

  assert.equal(mock.calls.windowsUpdate.length, 0);
});

test("onFocusChanged: refocuses and un-minimizes the confirm window when a different window gains focus", async () => {
  const mock = createChromeMock({
    sessionData: { pendingClosure: { confirmWindowId: 42 } }
  });
  const listener = getFocusChangedListener(mock);

  await listener(999);

  assert.equal(mock.calls.windowsUpdate.length, 1);
  // NOTE: mock.calls.windowsUpdate[0].props is an object literal constructed
  // inside the vm context (a separate realm), so it cannot be compared with
  // assert.deepEqual/deepStrictEqual against a main-realm literal (different
  // Object.prototype -> "same structure but not reference-equal"). Assert on
  // primitive fields instead.
  const call = mock.calls.windowsUpdate[0];
  assert.equal(call.windowId, 42);
  assert.equal(call.props.focused, true);
  assert.equal(call.props.state, "normal");
});

test("onFocusChanged: swallows errors if chrome.windows.update rejects (window already closed)", async () => {
  const mock = createChromeMock({
    sessionData: { pendingClosure: { confirmWindowId: 42 } }
  });
  const listener = getFocusChangedListener(mock);
  mock.chrome.windows.update = async () => {
    throw new Error("no such window");
  };

  await assert.doesNotReject(() => listener(999));
});

// Minimising the confirm window while it is the ONLY open Chrome window
// fires onFocusChanged(WINDOW_ID_NONE). The old guard returned there to avoid
// stealing focus from another application, which left the pending closure
// invisible with no way back. The two cases WINDOW_ID_NONE covers need different
// answers, and these tests pin both.

function focusHarness({ confirmState, pendingClosure = { confirmWindowId: 500 } }) {
  const mock = createChromeMock({ sessionData: { pendingClosure } });
  mock.setWindows([{ id: 500, state: confirmState }, { id: 501, state: "normal" }]);
  const context = loadBackground(mock.chrome);
  return { mock, listener: mock.listeners.onFocusChanged[0] };
}

test("WINDOW_ID_NONE with the confirm window minimised un-minimises it WITHOUT claiming focus", async () => {
  const { mock, listener } = focusHarness({ confirmState: "minimized" });

  await listener(-1);

  assert.equal(mock.calls.windowsUpdate.length, 1, "it acts, where it used to give up");
  const { windowId, props } = mock.calls.windowsUpdate[0];
  assert.equal(windowId, 500);
  assert.deepEqual({ ...props }, { state: "normal" });
  assert.ok(!("focused" in props), "asking for focus would yank the user out of another app");
});

test("WINDOW_ID_NONE with the confirm window already normal still touches nothing", async () => {
  // This is the case the guard exists for: the user switched to another application.
  // Restoring a window that is not minimised would raise Chrome over it.
  const { mock, listener } = focusHarness({ confirmState: "normal" });

  await listener(-1);

  assert.equal(mock.calls.windowsUpdate.length, 0);
});

test("a real window id still claims focus as well as un-minimising", async () => {
  const { mock, listener } = focusHarness({ confirmState: "minimized" });

  await listener(501);

  assert.equal(mock.calls.windowsUpdate.length, 1);
  assert.deepEqual({ ...mock.calls.windowsUpdate[0].props }, { focused: true, state: "normal" });
});

test("WINDOW_ID_NONE with no pending closure does nothing", async () => {
  const mock = createChromeMock({});
  mock.setWindows([{ id: 500, state: "minimized" }]);
  loadBackground(mock.chrome);

  await mock.listeners.onFocusChanged[0](-1);

  assert.equal(mock.calls.windowsUpdate.length, 0);
});

test("a confirm window that vanished mid-flight does not throw", async () => {
  const mock = createChromeMock({ sessionData: { pendingClosure: { confirmWindowId: 999 } } });
  mock.setWindows([{ id: 500, state: "normal" }]); // 999 is gone
  loadBackground(mock.chrome);

  await mock.listeners.onFocusChanged[0](-1);

  assert.equal(mock.calls.windowsUpdate.length, 0, "onRemoved handles reopening, not this listener");
});
