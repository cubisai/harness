import assert from "node:assert/strict";
import { farewell, greet } from "./src/greet.js";

assert.equal(greet("Ana"), "Hi, Ana!");
assert.equal(farewell("Ana"), "Goodbye, Ana.");
console.log("greet ok");
