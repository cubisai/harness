import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const run = (...args) => spawnSync(process.execPath, ["cli.js", ...args], { encoding: "utf8" }).stdout.trim();
assert.equal(run("hello", "world"), "hello world");
assert.equal(run("--upper", "hello", "world"), "HELLO WORLD");
assert.equal(run("hello", "--upper"), "HELLO");
console.log("ok");
