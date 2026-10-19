import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dedupe } from "../src/dedupe.js";

test("removes duplicates keeping the first occurrence", () => {
  assert.deepEqual(dedupe(["b", "a", "b", "c", "a"]), ["b", "a", "c"]);
  assert.deepEqual(dedupe([]), []);
  assert.deepEqual(dedupe([1, 1, 1]), [1]);
});

test("dedupes 400000 items in under 2s and keeps order", () => {
  const url = new URL("../src/dedupe.js", import.meta.url).href;
  const script = [
    `const { dedupe } = await import(${JSON.stringify(url)});`,
    "const n = 400000;",
    "const list = new Array(n);",
    "for (let i = 0; i < n; i++) list[i] = i % 200000;",
    "const out = dedupe(list);",
    "if (out.length !== 200000) { console.error('length ' + out.length); process.exit(1); }",
    "for (let i = 0; i < 200000; i++) if (out[i] !== i) { console.error('order at ' + i); process.exit(1); }",
    "process.stdout.write('ok');",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 2000 });
  assert.equal(out.trim(), "ok");
});
