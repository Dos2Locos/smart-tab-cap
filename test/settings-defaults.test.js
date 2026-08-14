"use strict";

// options.js no longer carries its own copy of DEFAULT_SETTINGS -- the form
// defaults live in options.html (checked / value / selected) and FIELD_IDS is
// derived from the `.field` controls at runtime. That removes the JS-to-JS
// duplication but leaves one drift risk: the markup defaults and
// background.js's DEFAULT_SETTINGS must still agree. This test is that guard.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { loadBackground } = require("./support/load-background");
const { createChromeMock } = require("./support/chrome-mock");

const OPTIONS_HTML = fs.readFileSync(
  path.join(__dirname, "..", "options.html"),
  "utf8"
);

// Only `.field` rows hold settings controls -- the same contract options.js
// relies on for FIELD_IDS. Everything outside them (#domainInput, warnings)
// is deliberately excluded.
function fieldBlocks(html) {
  return [...html.matchAll(/<div class="field">([\s\S]*?)<\/div>\s*(?=<div|<\/div>)/g)].map(
    (match) => match[1]
  );
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

// Reads the default the browser itself would apply to each control.
function markupDefaults(html) {
  const defaults = {};

  for (const block of fieldBlocks(html)) {
    const input = block.match(/<input\b[^>]*>/);

    if (input) {
      const tag = input[0];
      const id = attribute(tag, "id");
      const type = attribute(tag, "type");

      defaults[id] =
        type === "checkbox" ? /\bchecked\b/.test(tag) : Number(attribute(tag, "value"));
      continue;
    }

    const select = block.match(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/);

    if (select) {
      const options = [...select[2].matchAll(/<option value="([^"]+)"([^>]*)>/g)];
      const selected = options.find((option) => /\bselected\b/.test(option[2]));
      defaults[select[1]] = (selected || options[0])[1];
    }
  }

  return defaults;
}

function backgroundDefaults() {
  const context = loadBackground(createChromeMock().chrome);
  // Spread into a host object: the vm realm has its own Object.prototype, which
  // deepStrictEqual would otherwise flag as a mismatch.
  return { ...vm.runInContext("DEFAULT_SETTINGS", context) };
}

test("options.html form defaults match background.js DEFAULT_SETTINGS", () => {
  const markup = markupDefaults(OPTIONS_HTML);
  const background = backgroundDefaults();

  assert.deepEqual(
    Object.keys(markup).sort(),
    Object.keys(background).sort(),
    "every setting needs exactly one .field control, and vice versa"
  );

  assert.deepEqual(markup, background);
});
