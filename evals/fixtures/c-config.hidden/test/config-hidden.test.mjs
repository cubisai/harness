import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

test("returns defaults when the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  assert.deepEqual(loadConfig(join(dir, "does-not-exist.json")), { retries: 3, verbose: false });
});

test("parses a present file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const path = join(dir, "cfg.json");
  writeFileSync(path, JSON.stringify({ retries: 9 }));
  assert.deepEqual(loadConfig(path), { retries: 9 });
});

test("still throws on invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, "{ this is not json");
  assert.throws(() => loadConfig(path));
});
