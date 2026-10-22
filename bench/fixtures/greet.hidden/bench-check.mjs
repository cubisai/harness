import assert from "node:assert/strict";
import { farewell, greet } from "./src/greet.js";

try {
  assert.equal(greet("Ana"), "Hi, Ana!");
  assert.equal(farewell("Ana"), "Goodbye, Ana.");
  console.log("greet ok");
} catch (err) {
  // One short line: the grader keeps only the output's tail.
  console.error(`FAIL ${err.message.replace(/\s+/g, " ")}`);
  process.exit(1);
}
