import { test } from "node:test";
import assert from "node:assert/strict";
import { SENTINEL, clampIndex, isBlank, rowKey } from "../src/big.js";

test("clampIndex clamps to the last valid index", () => {
  assert.equal(clampIndex(5, 5), 4);
  assert.equal(clampIndex(-3, 5), 0);
  assert.equal(clampIndex(2, 5), 2);
  assert.equal(clampIndex(9, 1), 0);
});

test("nearby helpers still behave", () => {
  assert.equal(rowKey({}), SENTINEL);
  assert.equal(rowKey({ id: 7 }), "7");
  assert.equal(isBlank(""), true);
  assert.equal(isBlank("x"), false);
});
