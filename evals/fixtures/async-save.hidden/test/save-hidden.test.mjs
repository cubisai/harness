import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAll } from "../src/save.js";

test("resolves with the count after every file is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "save-"));
  const items = [1, 2, 3, 4, 5].map((id) => ({ id, name: `n${id}` }));
  assert.equal(await saveAll(dir, items), 5);
  for (const it of items) assert.deepEqual(JSON.parse(readFileSync(join(dir, `${it.id}.json`), "utf8")), it);
});

test("rejects when a write fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "save-"));
  await assert.rejects(saveAll(dir, [{ id: "ok" }, { id: join("no-such-dir", "x") }]));
});

test("empty list resolves 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "save-"));
  assert.equal(await saveAll(dir, []), 0);
});
