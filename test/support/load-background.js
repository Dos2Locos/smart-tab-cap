"use strict";

// Loads background.js (a classic, non-module script) into an isolated vm
// context wired to a mocked `chrome` global, without modifying the file or
// requiring a bundler/module system -- matches this project's "no build
// step, no dependencies" convention.
//
// background.js's top-level `function` declarations (getSettings, handleTab,
// enforceTabLimit, shouldIgnoreTab, etc.) attach to the vm context's global
// object in non-strict sloppy mode, so tests can call them directly via the
// returned context object. `chrome.*.addListener` calls made at load time
// are captured into the mock's `listeners` map for direct invocation.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BACKGROUND_PATH = path.join(__dirname, "..", "..", "background.js");

function loadBackground(chrome) {
  const sandbox = {
    chrome,
    console,
    // background.js uses the WHATWG URL global (normalizeUrl, urlsMatch,
    // matchesDomainRule). vm.createContext() does not inherit Node's
    // globals, so without this, `new URL(...)` throws ReferenceError inside
    // the sandbox and is silently swallowed by background.js's own
    // try/catch fallbacks -- making domain-rule matching look broken when
    // it is actually just missing this binding.
    URL,
    setTimeout: (fn, ms, ...args) => {
      const timer = global.setTimeout(fn, ms, ...args);
      // Prevent debounce timers (e.g. recentlyHandledTabs cleanup) from
      // keeping the test process alive after assertions are done.
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      return timer;
    },
    clearTimeout: (timer) => global.clearTimeout(timer)
  };

  const context = vm.createContext(sandbox);
  const code = fs.readFileSync(BACKGROUND_PATH, "utf8");
  vm.runInContext(code, context, { filename: BACKGROUND_PATH });

  return context;
}

module.exports = { loadBackground, BACKGROUND_PATH };
