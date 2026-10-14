import assert from "node:assert/strict";
const s = await import("./src/stats.js");
assert.equal(s.min([3, 1, 2]), 1);
assert.equal(s.max([3, 1, 2]), 3);
assert.equal(s.mean([1, 2, 3, 4]), 2.5);
console.log("ok");
