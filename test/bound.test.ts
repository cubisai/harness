import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bound, pruneOutputDir, savedOutputOf } from "../src/main/harness/tools/bound";

let dir: string;
const long = Array.from({ length: 2500 }, (_, i) => `L${i + 1}`).join("\n");

describe("savedOutputOf", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-bound-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a head note", () => {
    const ctx = { outputDir: join(dir, ".out"), callId: "c1" };
    const out = bound(long, ctx, "head");
    expect(out.endsWith("(Read it with offset/limit, or Grep it)]")).toBe(true);
    expect(savedOutputOf(out)).toBe(join(dir, ".out", "c1.txt"));
  });

  it("round-trips a tail note", () => {
    const ctx = { outputDir: join(dir, ".out"), callId: "c2" };
    const out = bound(long, ctx, "tail");
    expect(out.startsWith("[")).toBe(true);
    expect(savedOutputOf(out)).toBe(join(dir, ".out", "c2.txt"));
  });

  it("returns null for unbounded text", () => {
    expect(savedOutputOf("hello\nworld")).toBeNull();
    expect(savedOutputOf(`${long}`)).toBeNull();
  });
});

describe("pruneOutputDir", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-prune-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes an old saved output and keeps a fresh one", () => {
    const oldFile = join(dir, "old.txt");
    const freshFile = join(dir, "fresh.txt");
    writeFileSync(oldFile, "old");
    writeFileSync(freshFile, "fresh");
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(oldFile, old, old);

    expect(pruneOutputDir(dir)).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });

  it("returns 0 for a missing folder", () => {
    expect(pruneOutputDir(join(dir, "nope"))).toBe(0);
  });
});
