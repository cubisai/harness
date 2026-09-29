import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeProjectKey, importNativeMemory } from "../src/main/memory/import";
import { MemoryStore, serializeFact } from "../src/main/memory/store";
import { tempDir } from "./helpers";

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe("claudeProjectKey", () => {
  it("turns every non-alphanumeric character into a dash", () => {
    expect(claudeProjectKey("/Users/x/my repo")).toBe("-Users-x-my-repo");
    expect(claudeProjectKey("C:\\Users\\x\\repo")).toBe("C--Users-x-repo");
  });
});

describe("importNativeMemory", () => {
  it("copies Claude's facts keeping their basenames, skips MEMORY.md, and leaves the source untouched", () => {
    const home = tempDir();
    const key = claudeProjectKey("/Users/x/my repo");
    const src = join(home, ".claude", "projects", key, "memory");
    const aText = serializeFact({ name: "Commit Style", description: "Max 150 chars", type: "feedback", body: "Keep it short." });
    const bText = serializeFact({ name: "Deploy", description: "Use make deploy", type: "project", body: "Steps." });
    write(join(src, "commit-style.md"), aText);
    write(join(src, "deploy.md"), bText);
    write(join(src, "MEMORY.md"), "# Index\n- [Commit Style](commit-style.md) — x\n");

    const store = new MemoryStore(tempDir());
    expect(importNativeMemory(store, "p1", "/Users/x/my repo", { home })).toEqual({ imported: 2, skipped: 0 });
    expect(store.list("p1").map((f) => f.file)).toEqual(["commit-style.md", "deploy.md"]);
    expect(store.read("p1", "commit-style.md")?.name).toBe("Commit Style");
    expect(store.read("p1", "deploy.md")?.type).toBe("project");
    // The sources are read-only for us.
    expect(readFileSync(join(src, "commit-style.md"), "utf8")).toBe(aText);
    expect(readFileSync(join(src, "deploy.md"), "utf8")).toBe(bText);
    expect(existsSync(join(store.dir("p1"), ".imported"))).toBe(true);
  });

  it("skips a fact whose name already exists, case-insensitively", () => {
    const home = tempDir();
    const key = claudeProjectKey("/proj");
    const src = join(home, ".claude", "projects", key, "memory");
    write(join(src, "commit-style.md"), serializeFact({ name: "commit STYLE", description: "dup", type: "feedback", body: "dup" }));
    write(join(src, "deploy.md"), serializeFact({ name: "Deploy", description: "new", type: "project", body: "new" }));

    const store = new MemoryStore(tempDir());
    store.write("p1", { name: "Commit Style", description: "old", type: "feedback", body: "old" });
    expect(importNativeMemory(store, "p1", "/proj", { home })).toEqual({ imported: 1, skipped: 1 });
  });

  it("is a no-op on the second call because of the .imported marker", () => {
    const home = tempDir();
    const store = new MemoryStore(tempDir());
    importNativeMemory(store, "p1", "/proj", { home });
    expect(importNativeMemory(store, "p1", "/proj", { home })).toEqual({ imported: 0, skipped: 0 });
  });

  it("imports Codex's own memories as codex-memories", () => {
    const home = tempDir();
    write(join(home, ".codex", "memories", "MEMORY.md"), "Codex notes here");
    const store = new MemoryStore(tempDir());
    expect(importNativeMemory(store, "p1", "/proj", { home })).toEqual({ imported: 1, skipped: 0 });
    const fact = store.read("p1", "codex-memories.md");
    expect(fact?.name).toBe("codex-memories");
    expect(fact?.type).toBe("reference");
    expect(fact?.body).toBe("Codex notes here");
  });

  it("writes the marker even when there's nothing to import", () => {
    const store = new MemoryStore(tempDir());
    expect(importNativeMemory(store, "p1", "/proj", { home: tempDir() })).toEqual({ imported: 0, skipped: 0 });
    const marker = join(store.dir("p1"), ".imported");
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(readFileSync(marker, "utf8")).imported).toBe(0);
  });
});
