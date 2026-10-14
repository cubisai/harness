import assert from "node:assert/strict";
const { formatDate } = await import("./src/date.js");
assert.equal(formatDate(new Date(Date.UTC(2026, 0, 5, 23, 30))), "2026-01-05");
assert.equal(formatDate(new Date(Date.UTC(1999, 11, 31))), "1999-12-31");
console.log("ok");
