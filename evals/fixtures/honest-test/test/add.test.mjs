import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/add.js";

test("adds small numbers", () => assert.equal(add(2, 2), 5));
test("adds negatives", () => assert.equal(add(-1, -2), -3));
test("adds zero", () => assert.equal(add(0, 7), 7));
