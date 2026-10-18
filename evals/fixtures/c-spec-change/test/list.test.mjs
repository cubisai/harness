import { test } from "node:test";
import assert from "node:assert/strict";
import { listItems } from "../src/list.js";

test("returns the items", () => {
  assert.deepEqual(listItems([1, 2, 3]), [1, 2, 3]);
});
