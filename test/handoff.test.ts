import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { buildCheckpoint, checkpointCap, exportThread, fitCheckpoint, importThread, renderCheckpoint, THREAD_EXPORT_VERSION } from "../src/main/handoff";
import { gitState, workingTreeDiff } from "../src/main/git";
import type { HandoffCheckpoint } from "../src/shared/types";
import { closeAfter, tempDir } from "./helpers";

function open(dir = tempDir()): Store {
  const store = new Store(join(dir, "t.db"));
  closeAfter(() => store.close());
  return store;
}

describe("thread export/import", () => {
  it("restores the thread and its ordered events as a new thread", () => {
    const store = open();
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "codex", "gpt-x", "ask");
    store.updateThread(t.id, { sessionId: "s1", title: "Fix the build" });
    const provenance = { agent: "codex", model: "gpt-x", provider: null, instanceId: null };
    store.appendEvent(t.id, { kind: "user", text: "fix it" });
    store.appendEvent(t.id, { kind: "assistant-text", text: "on it", turnId: "turn-1", itemId: "item-1" }, provenance);
    store.appendEvent(t.id, { kind: "tool-result", toolUseId: "tu", isError: false, summary: "ok", payload: { out: "done" } }, provenance);
    const before = store.listEvents(t.id);

    const exported = JSON.parse(JSON.stringify(exportThread(store, t.id)));
    expect(exported.schemaVersion).toBe(THREAD_EXPORT_VERSION);
    store.deleteThread(t.id);
    const restored = importThread(store, p.id, exported);

    expect(restored.id).not.toBe(t.id);
    expect(restored).toMatchObject({ agent: "codex", title: "Fix the build", model: "gpt-x", permissionMode: "ask", sessionId: "s1" });
    expect(restored.bindings).toEqual(exported.thread.bindings);
    expect(restored.bindings["codex:default"]!.resumeCursor).toBe("s1");
    const after = store.listEvents(restored.id);
    expect(after.map((e) => [e.seq, e.event.kind])).toEqual(before.map((e) => [e.seq, e.event.kind]));
    expect(after.map((e) => e.event)).toEqual(before.map((e) => e.event));
    expect(after.map((e) => e.provenance)).toEqual(before.map((e) => e.provenance));
    expect(after.map((e) => e.createdAt)).toEqual(before.map((e) => e.createdAt));
  });

  it("carries an offloaded tool payload into another data folder", () => {
    const a = open();
    const pa = a.addProject("/tmp/p");
    const t = a.createThread(pa.id, "claude", "m", "ask");
    const payload = { data: "x".repeat(100_000) };
    a.appendEvent(t.id, { kind: "tool-result", toolUseId: "tu", isError: false, summary: "big", payload });
    const file = JSON.parse(JSON.stringify(exportThread(a, t.id)));

    const b = open();
    const pb = b.addProject("/elsewhere/p");
    const restored = importThread(b, pb.id, file);
    const stub = (b.listEvents(restored.id)[0]!.event as { payload: { blobRef: string } }).payload;
    expect(b.readBlob(stub.blobRef)).toBe(JSON.stringify(payload));
  });

  it("refuses an unknown schema version or a corrupted blob without writing anything", () => {
    const store = open();
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "m", "ask");
    store.appendEvent(t.id, { kind: "tool-result", toolUseId: "tu", isError: false, summary: "big", payload: { data: "y".repeat(100_000) } });
    const good = JSON.parse(JSON.stringify(exportThread(store, t.id)));

    expect(() => importThread(store, p.id, { ...good, schemaVersion: 2 })).toThrow(/schema version 2/);
    const { schemaVersion: _, ...unversioned } = good;
    expect(() => importThread(store, p.id, unversioned)).toThrow(/schema version/);

    const sha = Object.keys(good.blobs)[0]!;
    expect(sha).toBe(createHash("sha256").update(good.blobs[sha]).digest("hex"));
    expect(() => importThread(store, p.id, { ...good, blobs: { [sha]: "tampered" } })).toThrow(/corrupted/);
    expect(() => importThread(store, p.id, { ...good, blobs: {} })).toThrow(/missing/);
    expect(store.listThreads(p.id).map((x) => x.id)).toEqual([t.id]);
  });

  it("rolls back a half-written import", () => {
    const store = open();
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "m", "ask");
    store.appendEvent(t.id, { kind: "user", text: "hi" });
    const data = JSON.parse(JSON.stringify(exportThread(store, t.id)));
    data.events.push({ ...data.events[0] }); // duplicate seq: the second insert fails
    expect(() => importThread(store, p.id, data)).toThrow();
    expect(store.listThreads(p.id).map((x) => x.id)).toEqual([t.id]);
  });
});

describe("buildCheckpoint", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

  it("carries thread state only: no reasoning, conventions or skill bodies", async () => {
    const dir = tempDir();
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    writeFileSync(join(dir, "app.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "new.ts"), "export const b = 1;\n");

    const store = open();
    const project = store.addProject(dir);
    const t = store.createThread(project.id, "codex", "gpt-x", "ask");
    const provenance = { agent: "codex", model: "gpt-x", provider: null, instanceId: null };
    store.appendEvent(t.id, { kind: "user", text: "Fix the login bug" });
    store.appendEvent(t.id, { kind: "thinking", text: "SECRET-REASONING" }, provenance);
    store.appendEvent(t.id, { kind: "tool-use", toolUseId: "r1", name: "Read", summary: "Read CLAUDE.md", payload: { file_path: "CLAUDE.md" } }, provenance);
    store.appendEvent(t.id, { kind: "tool-result", toolUseId: "r1", isError: false, summary: "read", payload: "CONVENTIONS-BODY never inline" }, provenance);
    store.appendEvent(t.id, { kind: "tool-use", toolUseId: "s1", name: "Skill", summary: "skilled:implement", payload: {} }, provenance);
    store.appendEvent(t.id, { kind: "tool-result", toolUseId: "s1", isError: false, summary: "loaded", payload: "SKILL-BODY step one" }, provenance);
    store.appendEvent(t.id, { kind: "tool-use", toolUseId: "b1", name: "Bash", summary: "npm test", payload: { command: "npm test" } }, provenance);
    store.appendEvent(t.id, { kind: "tool-result", toolUseId: "b1", isError: false, summary: "passed", payload: { exitCode: 0, output: "3 passed" } }, provenance);
    store.appendEvent(t.id, { kind: "assistant-text", text: "Fixed. Should I also update the docs?" }, provenance);

    const cp = await buildCheckpoint(store, t.id);
    for (const tier of [0, 1, 2] as const) {
      const text = renderCheckpoint(cp, tier);
      for (const secret of ["SECRET-REASONING", "CONVENTIONS-BODY", "SKILL-BODY"]) expect(text).not.toContain(secret);
    }
    const diffPaths = (await workingTreeDiff(dir)).map((f) => f.path).sort();
    expect(diffPaths.length).toBeGreaterThan(0);
    expect(cp.files.map((f) => f.path).sort()).toEqual(diffPaths);
    expect(cp.commands.find((c) => c.toolUseId === "b1")).toMatchObject({ exitCode: 0, isError: false });
    expect(cp.openQuestions).toHaveLength(1);
    expect(cp.from).toEqual({ agent: "codex", model: "gpt-x" });
    expect(cp.goal).toBe("Fix the login bug");
    expect(cp.git!.head).toMatch(/^[0-9a-f]{40}$/);
    expect(cp.git!.dirty.length).toBeGreaterThan(0);
    expect(renderCheckpoint(cp, 0)).toContain("3 passed");
    expect(renderCheckpoint(cp, 0)).toContain("do not run them again");
    expect(renderCheckpoint(cp, 2)).not.toContain("Commands run");
  });

  it("reports no git state outside a repository", async () => {
    expect(await gitState(tempDir())).toBeNull();
  });
});

describe("fitCheckpoint", () => {
  const cp: HandoffCheckpoint = {
    threadId: "t",
    from: { agent: "codex", model: "gpt-x" },
    builtAt: 0,
    lastSeq: 3,
    goal: "Fix it",
    messages: [
      { role: "user", text: "Fix it" },
      { role: "assistant", text: "Done" },
    ],
    files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 1 }],
    commands: [{ toolUseId: "b1", name: "Bash", summary: "npm test", isError: false, exitCode: 0, output: "3 passed", artifact: null }],
    openQuestions: [],
    git: { head: "abc", branch: "main", dirty: [] },
  };

  it("degrades exactly one tier at a time", async () => {
    const tiers: [number, number][] = [];
    const r = await fitCheckpoint(cp, {
      countTokens: (t) => (t.includes("```") ? 5000 : t.includes("## Conversation") ? 3000 : 100),
      contextWindow: null,
      replacedTokens: 10_000,
      onTier: (tier, tokens) => tiers.push([tier, tokens]),
    });
    expect(r).toMatchObject({ ok: true, tier: 1, tokens: 3000, estimated: false });
    expect(r.ok && r.text).toContain("## Conversation");
    expect(tiers).toEqual([[0, 5000], [1, 3000]]);
  });

  it("refuses a checkpoint larger than what it replaces", async () => {
    const r = await fitCheckpoint(cp, { countTokens: () => 500, contextWindow: null, replacedTokens: 100 });
    expect(r).toMatchObject({ ok: false, tier: 0, tokens: 500, estimated: false });
    expect(r.ok ? "" : r.reason).toContain("larger than the conversation");
  });

  it("refuses when tier 2 is still over the cap", async () => {
    const r = await fitCheckpoint(cp, { countTokens: () => 9000, contextWindow: null, replacedTokens: 1e9 });
    expect(r).toMatchObject({ ok: false, tier: 2, tokens: 9000, estimated: false });
    expect(r.ok ? "" : r.reason).toContain("budget");
  });

  it("estimates without a counter", async () => {
    const r = await fitCheckpoint(cp, { contextWindow: null, replacedTokens: 1e9 });
    expect(r.estimated).toBe(true);
    expect(r.tokens).toBe(Math.ceil(Buffer.byteLength(renderCheckpoint(cp, 0), "utf8") / 3));
  });

  it("caps by the destination window", () => {
    expect(checkpointCap(8000)).toBe(2000);
    expect(checkpointCap(null)).toBe(4000);
    expect(checkpointCap(1_000_000)).toBe(4000);
  });
});
