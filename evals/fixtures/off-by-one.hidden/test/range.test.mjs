import { test } from "node:test";
import assert from "node:assert/strict";
import { range } from "../src/range.js";

test("inclusive on both ends", () => assert.deepEqual(range(1, 4), [1, 2, 3, 4]));
test("a single value", () => assert.deepEqual(range(3, 3), [3]));
test("empty when b < a", () => assert.deepEqual(range(5, 2), []));
