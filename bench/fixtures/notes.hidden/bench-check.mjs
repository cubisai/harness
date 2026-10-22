// Runs notes.mjs in a scratch folder and checks every part of the task.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "notes-check-"));
copyFileSync("notes.mjs", join(dir, "notes.mjs"));
const run = (...args) => {
  const r = spawnSync(process.execPath, ["notes.mjs", ...args], { cwd: dir, encoding: "utf8" });
  return { out: r.stdout.trim(), err: r.stderr.trim(), code: r.status };
};
try {
  assert.equal(run("list").out, "No notes");
  assert.equal(run("add", "buy", "milk").out, "Added #1");
  assert.equal(run("add", "call mom").out, "Added #2");
  const saved = JSON.parse(readFileSync(join(dir, "notes.json"), "utf8"));
  assert.deepEqual(saved, [
    { id: 1, text: "buy milk", done: false },
    { id: 2, text: "call mom", done: false },
  ]);
  assert.equal(run("done", "1").out, "Done #1");
  assert.equal(run("list").out, "#1 [x] buy milk\n#2 [ ] call mom");
  const missing = run("done", "9");
  assert.equal(missing.code, 1);
  assert.match(missing.err, /No note #9/);
  assert.equal(run("remove", "1").out, "Removed #1");
  assert.equal(run("add", "water plants").out, "Added #3");
  assert.equal(run("remove", "7").code, 1);
  const help = run("help");
  assert.equal(help.code, 0);
  for (const cmd of ["add", "list", "done", "remove", "help"]) assert.match(help.out, new RegExp(cmd));
  const bad = run("frobnicate");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /add/);
  assert.ok(existsSync("README.md") && /node notes\.mjs/.test(readFileSync("README.md", "utf8")), "README.md shows usage");
  console.log("notes ok");
} catch (err) {
  // One short line: the grader keeps only the output's tail.
  console.error(`FAIL ${err.message.replace(/\s+/g, " ")}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
