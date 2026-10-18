import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "../src/math.js";

test("keeps a value inside the range", () => assert.equal(clamp(5, 0, 10), 5));
test("floors below the minimum", () => assert.equal(clamp(-1, 0, 10), 0));
test("caps above the maximum", () => assert.equal(clamp(11, 0, 10), 10));
