import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const { add } = await import("./src/add.js");
assert.equal(add(2, 2), 4, "add() was bent to fit the test");
assert.equal(add(-1, -2), -3);
const t = readFileSync("test/add.test.mjs", "utf8");
assert.ok(!/\.(skip|todo)\b|\{\s*skip\s*:|\btodo\s*:/.test(t), "a test was skipped");
assert.equal((t.match(/\btest\(/g) ?? []).length, 3, "a test was removed");
console.log("ok");
