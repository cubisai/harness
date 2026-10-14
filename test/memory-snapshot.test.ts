import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemorySnapshots, PENDING_SESSION } from "../src/main/memory/snapshot";
import { tempDir } from "./helpers";

/** A compute that counts its calls, so tests can assert it ran (or didn't). */
function counting(block: string): { calls: number; compute: () => string } {
  const out = { calls: 0, compute: () => { out.calls++; return block; } };
  return out;
}

describe("MemorySnapshots", () => {
  it("computes once and returns the identical block for the same session", () => {
    const snaps = new MemorySnapshots(tempDir());
    const c = counting("BLOCK v1");
    expect(snaps.get("t1", "s1", c.compute)).toBe("BLOCK v1");
    expect(snaps.get("t1", "s1", c.compute)).toBe("BLOCK v1");
    expect(c.calls).toBe(1);
  });

  it("serves the stored block after a restart without computing", () => {
    const root = tempDir();
    new MemorySnapshots(root).get("t1", "s1", () => "BLOCK v1");
    const c = counting("SHOULD NOT RUN");
    expect(new MemorySnapshots(root).get("t1", "s1", c.compute)).toBe("BLOCK v1");
    expect(c.calls).toBe(0);
  });

  it("recomputes and stores when the session key changes", () => {
    const snaps = new MemorySnapshots(tempDir());
    expect(snaps.get("t1", "s1", () => "one")).toBe("one");
    expect(snaps.get("t1", "s2", () => "two")).toBe("two");
    const c = counting("nope");
    expect(snaps.get("t1", "s2", c.compute)).toBe("two");
    expect(c.calls).toBe(0);
  });

  it("rekeys in place without changing the block or computing again", () => {
    const snaps = new MemorySnapshots(tempDir());
    snaps.get("t1", "temp", () => "BLOCK");
    snaps.rekey("t1", "real");
    const c = counting("nope");
    expect(snaps.get("t1", "real", c.compute)).toBe("BLOCK");
    expect(c.calls).toBe(0);
    // The old key no longer matches, so that session recomputes.
    expect(snaps.get("t1", "temp", () => "fresh")).toBe("fresh");
  });

  it("drops a thread's snapshot", () => {
    const snaps = new MemorySnapshots(tempDir());
    snaps.get("t1", "s1", () => "one");
    snaps.drop("t1");
    const c = counting("two");
    expect(snaps.get("t1", "s1", c.compute)).toBe("two");
    expect(c.calls).toBe(1);
  });

  it("treats a malformed file as no snapshot and recomputes", () => {
    const root = tempDir();
    const snaps = new MemorySnapshots(root);
    snaps.get("t1", "s1", () => "one");
    writeFileSync(join(root, "_snapshots", "t1.json"), "{not json");
    const c = counting("two");
    expect(snaps.get("t1", "s1", c.compute)).toBe("two");
    expect(c.calls).toBe(1);
  });

  it("ignores invalid thread ids without writing anything", () => {
    const root = tempDir();
    const snaps = new MemorySnapshots(root);
    const c = counting("BLOCK");
    expect(snaps.get("../x", "s1", c.compute)).toBe("BLOCK");
    expect(c.calls).toBe(1);
    snaps.rekey("../x", "s2");
    snaps.drop("../x");
    expect(readdirSync(root)).toEqual([]);
  });

  it("prunes dead, stale and malformed snapshots and returns the count", () => {
    const root = tempDir();
    let clock = 1_000_000;
    const snaps = new MemorySnapshots(root, () => clock);
    snaps.get("stale", "s1", () => "stale");
    clock += 5_000;
    snaps.get("live", "s1", () => "live");
    clock += 5_000;
    snaps.get("dead", "s1", () => "dead");
    writeFileSync(join(root, "_snapshots", "broken.json"), "not json");
    // "live" is in the set and young; "stale" is past the cap; "dead" isn't live; "broken" is malformed.
    const removed = snaps.prune(new Set(["live"]), 8_000);
    expect(removed).toBe(3);
    expect(existsSync(join(root, "_snapshots", "live.json"))).toBe(true);
    expect(existsSync(join(root, "_snapshots", "stale.json"))).toBe(false);
    expect(existsSync(join(root, "_snapshots", "dead.json"))).toBe(false);
    expect(existsSync(join(root, "_snapshots", "broken.json"))).toBe(false);
  });

  it("always computes for a new (pending) session, and the first real key adopts that block", () => {
    const snaps = new MemorySnapshots(tempDir());
    let n = 0;
    const compute = () => `block-${++n}`;
    expect(snaps.get("t1", "s-old", compute)).toBe("block-1");
    // A new session recomputes even though a snapshot exists.
    expect(snaps.get("t1", PENDING_SESSION, compute)).toBe("block-2");
    // The agent reports its id on the next turn: same block, no recompute.
    expect(snaps.get("t1", "s-new", compute)).toBe("block-2");
    expect(snaps.get("t1", "s-new", compute)).toBe("block-2");
    expect(n).toBe(2);
    // Resuming the old session afterwards is a different session: recompute.
    expect(snaps.get("t1", "s-old", compute)).toBe("block-3");
  });
});
