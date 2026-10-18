import { describe, expect, it } from "vitest";
import { memoryPrompt } from "../src/main/memory";
import { GLOBAL_SCOPE, MemoryStore } from "../src/main/memory/store";
import { memoryReadTool, memoryWriteTool } from "../src/main/memory/tool";
import { tempDir } from "./helpers";

const ctx = { projectId: "p1" };

describe("memoryPrompt", () => {
  it("returns nothing for empty or whitespace-only text", () => {
    expect(memoryPrompt("")).toBe("");
    expect(memoryPrompt("  \n ")).toBe("");
  });

  it("wraps the block with the shared-memory instructions", () => {
    const out = memoryPrompt("- [Commit Style](commit-style.md) — Max 150");
    expect(out.startsWith("<harness-memory>\n")).toBe(true);
    expect(out.endsWith("\n</harness-memory>")).toBe(true);
    expect(out).toContain("CubiQ memory, shared by every agent and session.");
    expect(out).toContain("with memory_write");
    expect(out).toContain("No secrets.");
    expect(out).toContain("- [Commit Style](commit-style.md) — Max 150");
  });

  it("keeps the instruction overhead within its token budget", () => {
    // These lines ride on every agent's first request of a session;
    // ~4 chars/token, with the one-char block subtracted.
    const tokens = Math.ceil(memoryPrompt("x").length / 4) - 1;
    expect(tokens).toBeLessThanOrEqual(130);
  });
});

describe("memoryReadTool", () => {
  function seeded() {
    const store = new MemoryStore(tempDir());
    store.write("p1", { name: "Commit Style", description: "Max 150 chars", type: "feedback", body: "Keep it short." });
    return store;
  }

  it("lists every note with its scope, file, type and description", async () => {
    const store = seeded();
    const tool = memoryReadTool({ store, enabled: () => true });
    const res = await tool.run({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("project: commit-style.md (feedback");
    expect(res.text).toContain("— Commit Style: Max 150 chars");
  });

  it("says there are no notes yet when the store is empty", async () => {
    const tool = memoryReadTool({ store: new MemoryStore(tempDir()), enabled: () => true });
    expect((await tool.run({}, ctx)).text).toBe("No notes yet.");
  });

  it("reads one note in full with its scope, type and updated date", async () => {
    const store = seeded();
    const tool = memoryReadTool({ store, enabled: () => true });
    const res = await tool.run({ file: "commit-style.md" }, ctx);
    expect(res.text).toContain("# Commit Style\n");
    expect(res.text).toMatch(/\(project · feedback · updated \d{4}-\d{2}-\d{2}\)/);
    expect(res.text).toContain("\nMax 150 chars\n\nKeep it short.");
  });

  it("records usage for the note it read", async () => {
    const store = seeded();
    const tool = memoryReadTool({ store, enabled: () => true });
    await tool.run({ file: "commit-style.md" }, ctx);
    expect(Object.keys(store.usage("p1"))).toContain("commit-style.md");
  });

  it("finds a global note without a scope, and the project's note when both share a file name", async () => {
    const store = new MemoryStore(tempDir());
    store.write(GLOBAL_SCOPE, { name: "Shared", description: "global one", type: "user", body: "global body" });
    const tool = memoryReadTool({ store, enabled: () => true });
    const global = await tool.run({ file: "shared.md" }, ctx);
    expect(global.text).toContain("(global · user");
    expect(global.text).toContain("global body");

    store.write("p1", { name: "Shared", description: "project one", type: "project", body: "project body" });
    const project = await tool.run({ file: "shared.md" }, ctx);
    expect(project.text).toContain("(project · project");
    expect(project.text).toContain("project body");
  });

  it("honours an explicit global scope", async () => {
    const store = new MemoryStore(tempDir());
    store.write(GLOBAL_SCOPE, { name: "Terse", description: "prefers terse answers", type: "user", body: "no fluff" });
    store.write("p1", { name: "Terse", description: "project one", type: "project", body: "project body" });
    const tool = memoryReadTool({ store, enabled: () => true });
    expect((await tool.run({ file: "terse.md", scope: "global" }, ctx)).text).toContain("no fluff");
  });

  it("searches names, descriptions and bodies, capped at five, and says when nothing matches", async () => {
    const store = new MemoryStore(tempDir());
    store.write("p1", { name: "Commit Style", description: "max 150 chars", type: "feedback", body: "keep commits short" });
    store.write("p1", { name: "Deploys", description: "ship on fridays", type: "project", body: "no deploys friday" });
    const tool = memoryReadTool({ store, enabled: () => true });
    const hit = await tool.run({ query: "COMMIT" }, ctx);
    expect(hit.text.split("\n")).toHaveLength(1);
    expect(hit.text).toContain("commit-style.md");
    expect(hit.text).toContain("project: ");
    const none = await tool.run({ query: "zzz" }, ctx);
    expect(none.isError).toBeFalsy();
    expect(none.text).toBe('No notes match "zzz".');

    for (let i = 0; i < 6; i++) store.write("p1", { name: `Note ${i}`, description: "alpha topic", type: "project", body: "alpha" });
    expect((await tool.run({ query: "alpha" }, ctx)).text.split("\n")).toHaveLength(5);
  });

  it("ranks a correction above its older twin for the same query", async () => {
    const store = new MemoryStore(tempDir());
    store.write("p1", { name: "Staging One", description: "deploy target is staging one", type: "project", body: "deploy target staging one" });
    store.write("p1", { name: "Staging Two", description: "deploy target is staging two", type: "project", body: "deploy target staging two" });
    store.markCorrection("p1", "staging-two.md");
    const tool = memoryReadTool({ store, enabled: () => true });
    const lines = (await tool.run({ query: "deploy target" }, ctx)).text.split("\n");
    expect(lines[0]).toContain("staging-two.md");
    expect(lines[1]).toContain("staging-one.md");
  });

  it("matches whole words, so a query word hidden inside another does not count", async () => {
    const store = new MemoryStore(tempDir());
    store.write("p1", { name: "Latest", description: "the latest build", type: "project", body: "the latest build" });
    store.write("p1", { name: "Checks", description: "run the test suite", type: "project", body: "run the test suite" });
    const tool = memoryReadTool({ store, enabled: () => true });
    const text = (await tool.run({ query: "test" }, ctx)).text;
    expect(text).toContain("checks.md");
    expect(text).not.toContain("latest.md");
  });

  it("caps the list at 60 lines and ends with a query hint", async () => {
    const store = new MemoryStore(tempDir());
    for (let i = 0; i < 70; i++) store.write("p1", { name: `N${String(i).padStart(2, "0")}`, description: "d", type: "project", body: "b" });
    const tool = memoryReadTool({ store, enabled: () => true });
    const lines = (await tool.run({}, ctx)).text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(lines.at(-1)).toMatch(/^… \d+ more; use query to search$/);
  });

  it("truncates a very long note body", async () => {
    const store = new MemoryStore(tempDir());
    store.write("p1", { name: "Big", description: "d", type: "project", body: "x".repeat(5000) });
    const tool = memoryReadTool({ store, enabled: () => true });
    const res = await tool.run({ file: "big.md" }, ctx);
    const body = res.text.split("\n\n").slice(1).join("\n\n");
    expect(body).toBe(`${"x".repeat(4000)}\n… (truncated)`);
  });

  it("errors on an unknown file with a hint to list", async () => {
    const store = seeded();
    const tool = memoryReadTool({ store, enabled: () => true });
    const res = await tool.run({ file: "nope.md" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("No note named nope.md");
  });

  it("refuses without a project or when memory is off", async () => {
    const store = seeded();
    const tool = memoryReadTool({ store, enabled: () => true });
    expect((await tool.run({}, undefined)).isError).toBe(true);
    const off = memoryReadTool({ store, enabled: () => false });
    expect((await off.run({}, ctx)).isError).toBe(true);
  });
});

describe("memoryWriteTool", () => {
  function writer(store = new MemoryStore(tempDir())) {
    return { store, tool: memoryWriteTool({ store, enabled: () => true }) };
  }

  it("adds a project note", async () => {
    const { store, tool } = writer();
    const res = await tool.run({ op: "add", name: "Commit Style", description: "max 150", body: "keep short", type: "feedback" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.text).toBe("Saved commit-style.md (project).");
    expect(store.read("p1", "commit-style.md")?.body).toBe("keep short");
  });

  it("defaults a user fact to the global scope, and any add to that scope's default type", async () => {
    const { store, tool } = writer();
    const user = await tool.run({ op: "add", name: "Terse", description: "prefers terse", body: "no fluff", type: "user" }, ctx);
    expect(user.text).toBe("Saved terse.md (global).");
    expect(store.read(GLOBAL_SCOPE, "terse.md")?.type).toBe("user");

    const scoped = await tool.run({ op: "add", scope: "global", name: "Other", description: "d", body: "b" }, ctx);
    expect(scoped.text).toBe("Saved other.md (global).");
    expect(store.read(GLOBAL_SCOPE, "other.md")?.type).toBe("user");
  });

  it("names the missing field on an incomplete add", async () => {
    const { tool } = writer();
    const res = await tool.run({ op: "add", description: "d", body: "b" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("name");
  });

  it("turns a same-name add into an update instead of duplicating", async () => {
    const { store, tool } = writer();
    await tool.run({ op: "add", name: "Commit Style", description: "max 150", body: "keep short", type: "feedback" }, ctx);
    const res = await tool.run({ op: "add", name: "commit style", description: "max 100", body: "keep shorter", type: "feedback" }, ctx);
    expect(res.text).toBe("Updated existing note commit-style.md (project).");
    expect(store.list("p1")).toHaveLength(1);
    expect(store.read("p1", "commit-style.md")?.description).toBe("max 100");
  });

  it("refuses a near-duplicate, pointing at the note to update", async () => {
    const { tool } = writer();
    await tool.run({ op: "add", name: "Commit Style Guide", description: "commit messages use imperative mood", body: "a", type: "feedback" }, ctx);
    const res = await tool.run({ op: "add", name: "Commit Style Rules", description: "commit messages use imperative mood", body: "b", type: "feedback" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Similar note exists: commit-style-guide.md");
    expect(res.text).toContain('op "update"');
  });

  it("refuses a note that looks like a credential", async () => {
    const { tool } = writer();
    const res = await tool.run({ op: "add", name: "Key", description: "the key", body: "api_key=abcdefghijklmnop", type: "reference" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toBe("That looks like a credential; memory never stores secrets.");
  });

  it("refuses a body over the limit", async () => {
    const { tool } = writer();
    const res = await tool.run({ op: "add", name: "Big", description: "d", body: "x".repeat(2400), type: "project" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toBe("Body is 2400 chars; keep a note under 2000 (split it or summarise).");
  });

  it("merges an update over the existing note", async () => {
    const { store, tool } = writer();
    store.write("p1", { name: "Commit Style", description: "max 150", type: "feedback", body: "keep short" });
    const res = await tool.run({ op: "update", file: "commit-style.md", description: "max 100" }, ctx);
    expect(res.text).toBe("Updated commit-style.md (project).");
    expect(store.read("p1", "commit-style.md")).toMatchObject({ name: "Commit Style", description: "max 100", body: "keep short", type: "feedback" });
  });

  it("deletes a note", async () => {
    const { store, tool } = writer();
    store.write("p1", { name: "Commit Style", description: "max 150", type: "feedback", body: "keep short" });
    const res = await tool.run({ op: "delete", file: "commit-style.md" }, ctx);
    expect(res.text).toBe("Deleted commit-style.md (project).");
    expect(store.list("p1")).toEqual([]);
  });

  it("marks a correction, deletes the note it supersedes, and names both", async () => {
    const { store, tool } = writer();
    store.write("p1", { name: "Staging One", description: "deploy target is staging", type: "project", body: "deploy to staging" });
    const res = await tool.run({ op: "add", name: "Staging Two", description: "deploy target changed", body: "deploy to staging-2", type: "project", correction: true, supersedes: "staging-one.md" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.text).toBe("Saved staging-two.md (project); deleted superseded staging-one.md.");
    expect(store.read("p1", "staging-one.md")).toBeNull();
    expect(store.meta("p1")["staging-two.md"]?.correction).toBeTypeOf("number");
  });

  it("marks a note updated with correction: true", async () => {
    const { store, tool } = writer();
    store.write("p1", { name: "Commit Style", description: "max 150", type: "feedback", body: "keep short" });
    const res = await tool.run({ op: "update", file: "commit-style.md", correction: true, description: "max 100" }, ctx);
    expect(res.text).toBe("Updated commit-style.md (project).");
    expect(store.meta("p1")["commit-style.md"]?.correction).toBeTypeOf("number");
  });

  it("finds a global note to update or delete when no scope is given", async () => {
    const { store, tool } = writer();
    store.write(GLOBAL_SCOPE, { name: "Terse", description: "prefers terse", type: "user", body: "no fluff" });
    expect((await tool.run({ op: "update", file: "terse.md", body: "short answers" }, ctx)).text).toBe("Updated terse.md (global).");
    expect(store.read(GLOBAL_SCOPE, "terse.md")?.body).toBe("short answers");
    expect(store.list("p1")).toEqual([]);
    expect((await tool.run({ op: "delete", file: "terse.md" }, ctx)).text).toBe("Deleted terse.md (global).");
    expect(store.list(GLOBAL_SCOPE)).toEqual([]);
  });

  it("errors on update/delete of an unknown file", async () => {
    const { tool } = writer();
    const update = await tool.run({ op: "update", file: "nope.md", name: "x" }, ctx);
    expect(update.isError).toBe(true);
    expect(update.text).toContain("No note named nope.md");
    const del = await tool.run({ op: "delete", file: "nope.md" }, ctx);
    expect(del.isError).toBe(true);
    expect(del.text).toContain("No note named nope.md");
  });

  it("errors on a path-shaped file name without throwing", async () => {
    const { tool } = writer();
    await expect(tool.run({ op: "update", file: "../x.md", description: "x" }, ctx)).resolves.toMatchObject({ isError: true });
    await expect(tool.run({ op: "delete", file: "../x.md" }, ctx)).resolves.toMatchObject({ isError: true });
  });

  it("refuses without a project or when memory is off", async () => {
    const off = memoryWriteTool({ store: new MemoryStore(tempDir()), enabled: () => false });
    expect((await off.run({ op: "add", name: "x", description: "d", body: "b" }, ctx)).isError).toBe(true);
    expect((await off.run({ op: "add", name: "x", description: "d", body: "b" }, undefined)).isError).toBe(true);
  });
});
