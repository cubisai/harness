import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "../src/sum.js";

test("adds mixed signs", () => assert.equal(sum([1, -2, 3]), 2));
test("empty list is zero", () => assert.equal(sum([]), 0));
