import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTitle } from "../src/format.js";
import { capitalize } from "../src/text.js";

test("the failing case now passes", () => {
  assert.equal(formatTitle("intro TO cacheS"), "Intro To Caches");
});

test("capitalize lowercases the rest of the word", () => {
  assert.equal(capitalize("HELLO"), "Hello");
  assert.equal(capitalize("hello"), "Hello");
  assert.equal(capitalize("hELLO"), "Hello");
});

test("a single word is title-cased", () => {
  assert.equal(formatTitle("HELLO"), "Hello");
});

test("a padded phrase is trimmed first", () => {
  assert.equal(formatTitle("  mixed CASE words  "), "Mixed Case Words");
});
