import assert from "node:assert/strict";
const { greet } = await import("./src/app.js");
assert.equal(greet("Ada"), "Hello, Ada!");
console.log("ok");
