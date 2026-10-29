import { test } from "node:test";
import assert from "node:assert/strict";
import { listItems } from "../src/list.js";

test("returns the new { items, total } shape", () => {
  assert.deepEqual(listItems(["a", "b"]), { items: ["a", "b"], total: 2 });
});

test("empty list", () => {
  assert.deepEqual(listItems([]), { items: [], total: 0 });
});

test("total counts the items", () => {
  assert.deepEqual(listItems([1, 2, 3, 4]), { items: [1, 2, 3, 4], total: 4 });
});
