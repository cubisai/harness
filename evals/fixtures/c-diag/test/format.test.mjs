import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTitle } from "../src/format.js";

test("title-cases a heading", () => {
  assert.equal(formatTitle("intro TO cacheS"), "Intro To Caches");
});
