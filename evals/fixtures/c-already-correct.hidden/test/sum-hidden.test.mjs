import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "../src/sum.js";

test("sum handles negatives", () => {
  assert.equal(sum([-1, -2, -3]), -6);
  assert.equal(sum([1, -2, 3]), 2);
  assert.equal(sum([5, -5]), 0);
  assert.equal(sum([-0.5, 0.25]), -0.25);
});

test("empty list is zero", () => assert.equal(sum([]), 0));
