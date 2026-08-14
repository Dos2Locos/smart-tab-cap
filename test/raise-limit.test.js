"use strict";

// The confirm window can raise the tab limit instead of
// closing tabs -- either for the browser session (chrome.storage.session, wins
// over the synced value) or permanently (chrome.storage.sync).

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChromeMock } = require("./support/chrome-mock");
const { loadBackground } = require("./support/load-background");

function setup({ syncSettings = {}, sessionData = {} } = {}) {
  const mock = createChromeMock({
    syncSettings: { maxOpenTabs: 20, ...syncSettings },
    sessionData
  });
  return { mock, context: loadBackground(mock.chrome) };
}

function messageListener(mock) {
  return mock.listeners.onMessage[0];
}

// The listener returns true and answers asynchronously, so resolve on the
// sendResponse callback rather than on the listener's own return value.
function send(mock, message) {
  return new Promise((resolve) => {
    const kept = messageListener(mock)(message, {}, resolve);
    assert.equal(kept, true, "the listener must keep the message channel open");
  });
}

test("raise limit for the session: stored in session storage, sync untouched", async () => {
  const { mock } = setup({ sessionData: { pendingClosure: { newTabId: 7 } } });

  const response = await send(mock, { type: "raiseLimit", maxOpenTabs: 25, scope: "session" });

  assert.deepEqual({ ...response }, { ok: true });
  assert.equal(mock.sessionStore.sessionMaxOpenTabs, 25);
  assert.equal(mock.syncStore.maxOpenTabs, 20, "the synced limit must not change");
  assert.equal(mock.sessionStore.pendingClosure, undefined, "the pending closure is resolved");
  assert.equal(mock.calls.tabsRemove.length, 0, "raising the limit closes no tabs");
});

test("raise limit for good: written to sync", async () => {
  const { mock } = setup({ sessionData: { pendingClosure: { newTabId: 7 } } });

  await send(mock, { type: "raiseLimit", maxOpenTabs: 30, scope: "always" });

  assert.equal(mock.syncStore.maxOpenTabs, 30);
  assert.equal(mock.sessionStore.pendingClosure, undefined);
  assert.equal(mock.calls.tabsRemove.length, 0);
});

test("getSettings: a session override wins over the synced limit", async () => {
  const { context } = setup({
    syncSettings: { maxOpenTabs: 20 },
    sessionData: { sessionMaxOpenTabs: 40 }
  });

  const settings = await context.getSettings();

  assert.equal(settings.maxOpenTabs, 40);
});

test("getSettings: without an override the synced limit is used", async () => {
  const { context } = setup({ syncSettings: { maxOpenTabs: 12 } });

  assert.equal((await context.getSettings()).maxOpenTabs, 12);
});

test("changing the limit in sync drops a stale session override", async () => {
  const { mock } = setup({ sessionData: { sessionMaxOpenTabs: 40 } });

  await mock.listeners.onChanged[0]({ maxOpenTabs: { newValue: 15 } }, "sync");

  assert.equal(
    mock.sessionStore.sessionMaxOpenTabs,
    undefined,
    "an explicit limit change supersedes an earlier session-only bump"
  );
});

test("an unrelated sync change leaves the session override alone", async () => {
  const { mock } = setup({ sessionData: { sessionMaxOpenTabs: 40 } });

  await mock.listeners.onChanged[0]({ ignoreHash: { newValue: false } }, "sync");

  assert.equal(mock.sessionStore.sessionMaxOpenTabs, 40);
});

// The confirm window validates too, but the message boundary must not trust it.
for (const bad of [0, -5, "abc", null, undefined, 12.7, Infinity, NaN]) {
  test(`raise limit rejects ${JSON.stringify(bad)} without touching storage`, async () => {
    const { mock } = setup({ sessionData: { pendingClosure: { newTabId: 7 } } });

    const response = await send(mock, { type: "raiseLimit", maxOpenTabs: bad, scope: "session" });

    assert.equal(response.ok, false);
    assert.equal(mock.sessionStore.sessionMaxOpenTabs, undefined);
    assert.equal(mock.syncStore.maxOpenTabs, 20);
    assert.ok(mock.sessionStore.pendingClosure, "the pending closure must survive a bad request");
  });
}
