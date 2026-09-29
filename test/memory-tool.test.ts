import { describe, expect, it } from "vitest";
import { memoryPrompt } from "../src/main/memory";
import { MemoryStore } from "../src/main/memory/store";
import { memoryReadTool } from "../src/main/memory/tool";
import { tempDir } from "./helpers";

describe("memoryPrompt", () => {
  it("returns nothing for empty or whitespace-only text", () => {
    expect(memoryPrompt("")).toBe("");
    expect(memoryPrompt("  \n ")).toBe("");
  });

  it("wraps the index with the shared-memory instructions", () => {
    const out = memoryPrompt("- [Commit Style](commit-style.md) — Max 150");
    expect(out.startsWith("<harness-memory>\n")).toBe(true);
    expect(out.endsWith("\n</harness-memory>")).toBe(true);
    expect(out).toContain("Project memory shared across agents (CubiQ)");
    expect(out).toContain("- [Commit Style](commit-style.md) — Max 150");
  });
});

describe("memoryReadTool", () => {
  function seeded() {
    const store = new MemoryStore(tempDir());
    store.write("p1", { name: "Commit Style", description: "Max 150 chars", type: "feedback", body: "Keep it short." });
    return store;
  }

  it("lists every note's file, type, and description", async () => {
    const store = seeded();
    const tool = memoryReadTool({ store, enabled: () => true });
    const res = await tool.run({}, { projectId: "p1" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toBe("commit-style.md (feedback) — Commit Style: Max 150 chars");
  });

  it("says there are no notes yet when the store is empty", async () => {
    const tool = memoryReadTool({ store: new MemoryStore(tempDir()), enabled: () => true });
    expect((await tool.run({}, { projectId: "p1" })).text).toBe("No notes yet.");
  });

  it("reads one note in full", async () => {
    const store = seeded();
    const tool = memoryReadTool({ store, enabled: () => true });
    const res = await tool.run({ file: "commit-style.md" }, { projectId: "p1" });
    expect(res.text).toBe("# Commit Style\nMax 150 chars\n\nKeep it short.");
  });

  it("errors on an unknown file with a hint to list", async () => {
    const store = seeded();
    const tool = memoryReadTool({ store, enabled: () => true });
    const res = await tool.run({ file: "nope.md" }, { projectId: "p1" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("No note named nope.md");
  });

  it("refuses without a project or when memory is off", async () => {
    const store = seeded();
    const tool = memoryReadTool({ store, enabled: () => true });
    expect((await tool.run({}, undefined)).isError).toBe(true);
    const off = memoryReadTool({ store, enabled: () => false });
    expect((await off.run({}, { projectId: "p1" })).isError).toBe(true);
  });
});
