import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/main/db";
import { buildCheckpoint, checkpointCap, checkpointGit, codexSeedItems, estimateTokens, exportThread, fitCheckpoint, importThread, injectWithLedger, itemFingerprint, bloatSignal, replacedTokens, renderCheckpoint, THREAD_EXPORT_VERSION } from "../src/main/handoff";
import { gitState, workingTreeDiff } from "../src/main/git";
import { normalizeUsage } from "../src/main/usage";
import type { AgentCapabilities, HandoffCheckpoint, StoredEvent, ThreadEvent } from "../src/shared/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import type { AgentDriver, SessionSeed, TurnInput } from "../src/main/agents/types";
import { Service } from "../src/main/service";
import { catalog, closeAfter, tempDir } from "./helpers";

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

  it("keeps a subagent's inner events out of the messages and commands", async () => {
    const dir = tempDir();
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");

    const store = open();
    const project = store.addProject(dir);
    const t = store.createThread(project.id, "claude", "m", "ask");
    const provenance = { agent: "claude", model: "m", provider: null, instanceId: null };
    store.appendEvent(t.id, { kind: "user", text: "find the bug" });
    store.appendEvent(t.id, { kind: "tool-use", toolUseId: "a1", name: "Agent", summary: "Explore" }, provenance);
    store.appendEvent(t.id, { kind: "assistant-text", text: "SUBAGENT-REASONING", parentId: "a1" }, provenance);
    store.appendEvent(t.id, { kind: "tool-use", toolUseId: "g1", name: "Search", summary: "foo", parentId: "a1" }, provenance);
    store.appendEvent(t.id, { kind: "tool-result", toolUseId: "g1", isError: false, summary: "ok", payload: "SUBAGENT-OUTPUT", parentId: "a1" }, provenance);
    store.appendEvent(t.id, { kind: "assistant-text", text: "Top-level answer" }, provenance);

    const cp = await buildCheckpoint(store, t.id);
    expect(cp.messages).toEqual([
      { role: "user", text: "find the bug" },
      { role: "assistant", text: "Top-level answer" },
    ]);
    expect(cp.commands.map((c) => c.toolUseId)).toEqual(["a1"]);
    expect(JSON.stringify(cp.commands)).not.toContain("SUBAGENT-OUTPUT");
  }, 20_000);

  it("carries inline UI blocks as one-line summaries, not their bodies", async () => {
    const store = open();
    const project = store.addProject(tempDir());
    const t = store.createThread(project.id, "claude", "m", "ask");
    store.appendEvent(t.id, { kind: "user", text: "compare plans" });
    store.appendEvent(t.id, { kind: "assistant-text", text: "Here:\n```ui:compare\n# Plans\nPlan | Price\nFree | 0\nPro | 20\n```\nWhich one?" });
    const cp = await buildCheckpoint(store, t.id);
    expect(cp.messages[1]).toEqual({ role: "assistant", text: 'Here:\n[ui:compare "Plans", 2 items]\nWhich one?' });
    expect(cp.openQuestions).toEqual(['Here:\n[ui:compare "Plans", 2 items]\nWhich one?']);
  });
});

describe("checkpointGit", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

  function repo(): { dir: string; file: string } {
    const dir = tempDir();
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    return { dir, file: join(dir, "app.ts") };
  }

  it("points a nameless ref at HEAD when the worktree is clean", async () => {
    const { dir } = repo();
    expect(await checkpointGit(dir, 7)).toEqual({ ok: true, ref: "harness-handoff/7" });
    expect(git(dir, "rev-parse", "harness-handoff/7").trim()).toBe(git(dir, "rev-parse", "HEAD").trim());
  });

  it("refuses a dirty worktree without creating a ref", async () => {
    const { dir, file } = repo();
    writeFileSync(file, "export const a = 2;\n");
    const result = await checkpointGit(dir, 8);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ kind: "dirty" });
    expect(result.ok ? "" : result.reason).toContain("app.ts");
    expect(result.ok ? "" : result.reason).toContain("Commit or stash");
    const ref = spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/harness-handoff/8"], { cwd: dir });
    expect(ref.status).not.toBe(0);
  });

  it("reports no-repo outside a repository", async () => {
    const result = await checkpointGit(tempDir(), 1);
    expect(result).toMatchObject({ ok: false, kind: "no-repo" });
  });
});

describe("bloatSignal", () => {
  it("reads cache reads against the last turn before the switch as reuse", () => {
    const pre = normalizeUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 10_000 });
    const post = normalizeUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 9800 });
    expect(bloatSignal(pre, post)).toMatchObject({ kind: "reused", tokens: 9800 });
  });

  it("reads a cache write after the switch as a re-seed", () => {
    const post = normalizeUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 4000 });
    const signal = bloatSignal(null, post);
    expect(signal).toMatchObject({ kind: "reseeded", tokens: 4100 });
    expect(signal?.text).toContain("4.1k tokens");
  });

  it("reads a reported input as a re-seed when nothing was cached", () => {
    const post = normalizeUsage({ inputTokens: 7100, outputTokens: 14, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(bloatSignal(null, post)).toMatchObject({ kind: "reseeded", tokens: 7100 });
  });

  it("reports nothing when the turn used no tokens at all", () => {
    const post = normalizeUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(bloatSignal(null, post)).toBeNull();
  });

  it("names switching back when the switch was a return", () => {
    const post = normalizeUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(bloatSignal(null, post, "back")?.text).toContain("switching back");
  });

  it("reports unavailable when the agent doesn't report cache use", () => {
    const post = normalizeUsage({ inputTokens: 100, outputTokens: 10 });
    expect(bloatSignal(null, post)).toMatchObject({ kind: "unavailable", tokens: null });
  });
});

describe("replacedTokens", () => {
  function stored(seq: number, event: StoredEvent["event"]): StoredEvent {
    return { seq, event, createdAt: 0 };
  }

  it("uses the newest turn-end's whole processed input", () => {
    const events = [
      stored(1, { kind: "user", text: "hi" }),
      stored(2, { kind: "turn-end", costUsd: null, inputTokens: 100, outputTokens: 5, durationMs: 1, usage: normalizeUsage({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 20 }) }),
      stored(3, { kind: "user", text: "again" }),
      stored(4, { kind: "turn-end", costUsd: null, inputTokens: 200, outputTokens: 5, durationMs: 1, usage: normalizeUsage({ inputTokens: 200, outputTokens: 5, cacheReadTokens: 300, cacheWriteTokens: 40 }) }),
    ];
    expect(replacedTokens(events)).toBe(200 + 300 + 40);
  });

  it("estimates the visible conversation without a turn-end", () => {
    const events = [stored(1, { kind: "user", text: "hello" }), stored(2, { kind: "assistant-text", text: "world" })];
    expect(replacedTokens(events)).toBe(estimateTokens("hello\nworld"));
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

  it("measures the command items against the budget when they travel as items", async () => {
    const big: HandoffCheckpoint = { ...cp, commands: [{ toolUseId: "b1", name: "Bash", summary: "npm test", isError: false, exitCode: 0, output: "x".repeat(20_000), artifact: null }] };
    const r = await fitCheckpoint(big, { contextWindow: null, replacedTokens: 1_000_000, commandsAsItems: true });
    expect(r.ok).toBe(true);
    expect(r.tier).toBeGreaterThanOrEqual(1);
  });
});

describe("codexSeedItems", () => {
  it("carries the rendered text and each command's call id, never reasoning", () => {
    const cp: HandoffCheckpoint = {
      threadId: "t",
      from: null,
      builtAt: 0,
      lastSeq: 3,
      goal: "",
      messages: [],
      files: [],
      commands: [{ toolUseId: "b1", name: "Bash", summary: "npm test", isError: false, exitCode: 0, output: "3 passed", artifact: null }],
      openQuestions: [],
      git: null,
    };
    const items = codexSeedItems(cp, "# Handoff") as { type: string; call_id?: string }[];
    expect(items[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "# Handoff" }] });
    expect(items[1]).toMatchObject({ type: "function_call", call_id: "b1", name: "Bash" });
    expect(items[2]).toMatchObject({ type: "function_call_output", call_id: "b1", output: "3 passed" });
    expect(items.some((i) => i.type === "reasoning")).toBe(false);
  });

  const cp: HandoffCheckpoint = {
    threadId: "t",
    from: null,
    builtAt: 0,
    lastSeq: 3,
    goal: "",
    messages: [],
    files: [],
    commands: [{ toolUseId: "b1", name: "Bash", summary: "npm test", isError: false, exitCode: 0, output: "3 passed", artifact: null }],
    openQuestions: [],
    git: null,
  };

  it("shortens each pair to the outcome line at tier 1", () => {
    const items = codexSeedItems(cp, "# Handoff", 1) as { type: string; call_id?: string; output?: string }[];
    expect(items[2]).toMatchObject({ type: "function_call_output", call_id: "b1", output: "exit 0" });
    expect(items[2]!.output).not.toContain("3 passed");
  });

  it("carries only the text message at tier 2", () => {
    const items = codexSeedItems(cp, "# Handoff", 2);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "# Handoff" }] });
  });

  it("omits the rendered Commands run section when the commands travel as items", () => {
    expect(renderCheckpoint(cp, 0)).toContain("## Commands run");
    expect(renderCheckpoint(cp, 0, { commandsAsItems: true })).not.toContain("## Commands run");
  });
});

describe("injection ledger", () => {
  const protocol = "codex/inject_items";
  const target = { threadId: "t1", provider: "codex", sessionId: "thr-1", checkpointId: "cp-1" };
  const items = [
    { type: "message", role: "user", content: "a" },
    { type: "function_call_output", call_id: "c1", output: "ok" },
  ];

  it("injects each item once and skips it on a second run", async () => {
    const store = open();
    const send = vi.fn(async () => {});
    expect(await injectWithLedger(store, target, items, protocol, send)).toEqual({ sent: 2, skipped: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(items);

    expect(await injectWithLedger(store, target, items, protocol, send)).toEqual({ sent: 0, skipped: 2 });
    expect(send).toHaveBeenCalledTimes(1);
    const rows = store.ledgerRows(target);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.state)).toEqual(["injected", "injected"]);
  });

  it("rolls intent rows forward after a crash before injected", async () => {
    const store = open();
    for (const item of items) store.recordIntent(target, itemFingerprint(item, protocol));
    const send = vi.fn(async () => {});
    expect(await injectWithLedger(store, target, items, protocol, send)).toEqual({ sent: 2, skipped: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(items);
    const rows = store.ledgerRows(target);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.state)).toEqual(["injected", "injected"]);
  });

  it("retries failed rows", async () => {
    const store = open();
    const failing = vi.fn(async () => {
      throw new Error("lost the connection");
    });
    await expect(injectWithLedger(store, target, items, protocol, failing)).rejects.toThrow("lost the connection");
    expect(store.ledgerRows(target).map((r) => r.state)).toEqual(["failed", "failed"]);

    const working = vi.fn(async () => {});
    expect(await injectWithLedger(store, target, items, protocol, working)).toEqual({ sent: 2, skipped: 0 });
    expect(working).toHaveBeenCalledTimes(1);
    expect(store.ledgerRows(target).map((r) => r.state)).toEqual(["injected", "injected"]);
  });

  it("fingerprints by protocol id and ignores key order", () => {
    const item = { a: 1, b: 2 };
    expect(itemFingerprint(item, "codex/inject_items")).not.toBe(itemFingerprint(item, "claude/inject_items"));
    expect(itemFingerprint({ a: 1, b: 2 }, protocol)).toBe(itemFingerprint({ b: 2, a: 1 }, protocol));
  });

  it("does not skip a different target session", async () => {
    const store = open();
    const send = vi.fn(async () => {});
    await injectWithLedger(store, target, items, protocol, send);
    const other = { ...target, sessionId: "thr-2" };
    expect(await injectWithLedger(store, other, items, protocol, send)).toEqual({ sent: 2, skipped: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

// T6.13: the cross-phase invariants a handoff must keep, end to end through the Service.
describe("handoff invariants", () => {
  type Script = (input: TurnInput) => Promise<void>;
  const fakeAgent = (id: string, script: Script, caps: Partial<AgentCapabilities> = {}, seed?: AgentDriver["seed"]): AgentDriver => ({
    id,
    label: id,
    defaultModel: `${id}-1`,
    capabilities: { ...SAFE_DEFAULTS, ...caps },
    skillsDelivery: { mode: "none" },
    skillCallPrefix: "",
    models: () => [{ id: `${id}-1`, label: id }],
    runTurn: script,
    seed,
  });
  const cleanRepo = () => {
    const dir = tempDir();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.ts"), "1\n");
    git("add", ".");
    git("commit", "-qm", "init");
    return dir;
  };
  const big = normalizeUsage({ inputTokens: 50_000, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });

  /** Codex ran a side-effecting command; the thread is then handed to an inject-items target. */
  async function handedOff() {
    const ran: string[] = [];
    const injected: unknown[][] = [];
    const codex = fakeAgent("codex", async (input) => {
      input.onSession("thr-1");
      input.onEvent({ kind: "tool-use", toolUseId: "call-rm", name: "Run", summary: "rm -rf build", payload: { command: "rm -rf build" } });
      input.onEvent({ kind: "tool-result", toolUseId: "call-rm", isError: false, summary: "removed", payload: { exitCode: 0, output: "removed build/" } });
      input.onEvent({ kind: "assistant-text", text: "Cleaned the build folder." });
      input.onEvent({ kind: "turn-end", costUsd: null, inputTokens: 50_000, outputTokens: 5, durationMs: 1, usage: big });
    });
    const target = fakeAgent(
      "target",
      async (input) => {
        ran.push(input.prompt);
      },
      { seeding: "inject-items" },
      async (req) => {
        req.onSession("tgt-1");
        const { sent } = await req.inject("tgt-1", async (items) => {
          injected.push(items);
        });
        return { mode: "seeded", sessionId: "tgt-1", sent };
      },
    );
    const store = open();
    const service = new Service(store, () => catalog(), [codex, target], () => {});
    const project = store.addProject(cleanRepo());
    const thread = service.createThread(project.id, "codex");
    await service.send({ threadId: thread.id, text: "Clean the build" });
    const res = await service.switchAgent(thread.id, "target", "handoff");
    return { store, service, thread, res, ran, injected };
  }

  it("1: carries a side-effecting command as its recorded result and never runs it again", async () => {
    const { res, ran, injected } = await handedOff();
    expect(res.ok).toBe(true);
    expect(ran).toEqual([]); // the target ran no turn, so nothing could re-invoke the tool
    const items = injected.flat() as { type: string; call_id?: string; output?: string }[];
    const call = items.find((i) => i.type === "function_call" && i.call_id === "call-rm");
    const output = items.find((i) => i.type === "function_call_output" && i.call_id === "call-rm");
    expect(call).toBeDefined();
    expect(output?.output).toContain("removed build/"); // a completed call: nothing pending to execute
    expect(JSON.stringify(items)).toContain("do not run them again");
  });

  it("2: every handoff event and the injected history name the agent they came from", async () => {
    const { store, thread, injected } = await handedOff();
    const handoffs = store.listEvents(thread.id).filter((e) => e.event.kind === "handoff");
    expect(handoffs.length).toBeGreaterThan(0);
    for (const e of handoffs) expect(e.provenance?.agent).toBeTruthy();
    const message = (injected.flat() as { type: string; content?: { text: string }[] }[]).find((i) => i.type === "message");
    expect(message?.content?.[0]?.text).toMatch(/^# Handoff from codex \(codex-1\)/);
  });

  it("3: Codex, then another agent, then Codex keeps the Codex cursor", async () => {
    const { service, store, thread } = await handedOff();
    expect(store.getThread(thread.id).bindings["codex:default"]!.resumeCursor).toBe("thr-1");
    const back = await service.switchAgent(thread.id, "codex", "back");
    expect(back).toMatchObject({ ok: true, thread: { agent: "codex", sessionId: "thr-1" } });
    expect(store.getThread(thread.id).bindings["target:default"]!.resumeCursor).toBe("tgt-1");
  });

  it("4 and 5: the same checkpoint injects once, and a mid-injection throw rolls forward without duplicating", async () => {
    const store = open();
    const cp: HandoffCheckpoint = {
      threadId: "t",
      from: { agent: "codex", model: "gpt-x" },
      builtAt: 0,
      lastSeq: 9,
      goal: "g",
      messages: [],
      files: [],
      commands: [{ toolUseId: "c1", name: "Run", summary: "npm test", isError: false, exitCode: 0, output: "ok", artifact: null }],
      openQuestions: [],
      git: null,
    };
    const items = codexSeedItems(cp, renderCheckpoint(cp, 0));
    const target = { threadId: "t", provider: "codex", sessionId: "thr-2", checkpointId: "cp-9" };
    const delivered: unknown[] = [];
    let fail = true;
    const send = async (xs: unknown[]) => {
      if (fail) {
        fail = false;
        throw new Error("socket closed");
      }
      delivered.push(...xs);
    };
    await expect(injectWithLedger(store, target, items, "codex/inject_items", send)).rejects.toThrow("socket closed");
    expect(await injectWithLedger(store, target, items, "codex/inject_items", send)).toEqual({ sent: items.length, skipped: 0 });
    expect(await injectWithLedger(store, target, items, "codex/inject_items", send)).toEqual({ sent: 0, skipped: items.length });
    expect(delivered).toEqual(items); // each item exactly once
    expect(store.ledgerRows(target).map((r) => r.state)).toEqual(items.map(() => "injected"));
  });

  it("6: export then import restores the bindings and the events", async () => {
    const { store, thread } = await handedOff();
    const before = store.getThread(thread.id);
    const events = store.listEvents(thread.id);
    const restored = importThread(store, before.projectId, JSON.parse(JSON.stringify(exportThread(store, thread.id))));
    expect(restored.bindings).toEqual(before.bindings);
    expect(store.listEvents(restored.id).map((e) => [e.seq, e.event.kind, e.provenance?.agent ?? null])).toEqual(
      events.map((e) => [e.seq, e.event.kind, e.provenance?.agent ?? null]),
    );
  });

  describe("rehydrate a lost session", () => {
    const lost = "No conversation found with session ID: s-1";
    const noticeTexts = (store: Store, threadId: string) =>
      store.listEvents(threadId).filter((e) => e.event.kind === "notice").map((e) => (e.event as Extract<ThreadEvent, { kind: "notice" }>).text);
    /** A first turn that remembers a secret word, then a second turn the script drives. */
    const remembered = async (input: TurnInput) => {
      input.onSession("s-1");
      input.onEvent({ kind: "assistant-text", text: "Remembered: the secret word is kiwi." });
      input.onEvent({ kind: "turn-end", costUsd: null, inputTokens: 50_000, outputTokens: 5, durationMs: 1, usage: big });
    };

    it("seeds a first-message agent from the thread's own log", async () => {
      const store = open();
      let turn = 0;
      let seed: SessionSeed | null = null;
      let clearedDuring: string | null | undefined;
      const agent = fakeAgent("claude", async (input) => {
        turn++;
        if (turn === 1) return remembered(input);
        if (input.sessionId === "s-1") {
          seed = await input.onSessionLost!(lost);
          clearedDuring = store.getThread(input.threadId).sessionId;
        }
      });
      const service = new Service(store, () => catalog(), [agent], () => {});
      const project = store.addProject(cleanRepo());
      const thread = service.createThread(project.id, "claude");
      await service.send({ threadId: thread.id, text: "Remember the secret word is kiwi." });
      await service.send({ threadId: thread.id, text: "What was the secret word?" });

      expect(seed).toMatchObject({ promptPrefix: expect.stringContaining("Remember the secret word is kiwi.") });
      expect(seed).toMatchObject({ promptPrefix: expect.stringContaining("kiwi") });
      expect(seed).not.toMatchObject({ promptPrefix: expect.stringContaining("What was the secret word?") });
      expect(clearedDuring).toBeNull();
      const texts = noticeTexts(store, thread.id);
      expect(texts.some((t) => t.includes("couldn't reopen its earlier session (No conversation found"))).toBe(true);
      expect(texts.some((t) => t.includes("Continued in a new one"))).toBe(true);
    });

    it("returns null the second time in the same turn (the ledger never sends it twice)", async () => {
      const store = open();
      let turn = 0;
      const seeds: (SessionSeed | null)[] = [];
      const agent = fakeAgent("claude", async (input) => {
        turn++;
        if (turn === 1) return remembered(input);
        seeds.push(await input.onSessionLost!(lost));
        seeds.push(await input.onSessionLost!(lost));
      });
      const service = new Service(store, () => catalog(), [agent], () => {});
      const project = store.addProject(cleanRepo());
      const thread = service.createThread(project.id, "claude");
      await service.send({ threadId: thread.id, text: "Remember the secret word is kiwi." });
      await service.send({ threadId: thread.id, text: "What was the secret word?" });

      expect(seeds).toHaveLength(2);
      expect(seeds[0]).not.toBeNull();
      expect(seeds[1]).toBeNull();
    });

    it("hands an inject-items agent the history items", async () => {
      const store = open();
      const injected: unknown[][] = [];
      let turn = 0;
      const agent = fakeAgent(
        "codex",
        async (input) => {
          turn++;
          if (turn === 1) return remembered(input);
          if (input.sessionId === "s-1") {
            const seed = await input.onSessionLost!(lost);
            if (seed && "inject" in seed) await seed.inject("thr-new", async (items) => { injected.push(items); });
          }
        },
        { seeding: "inject-items" },
        async (req) => {
          req.onSession("tgt-1");
          return { mode: "seeded", sessionId: "tgt-1", sent: 0 };
        },
      );
      const service = new Service(store, () => catalog(), [agent], () => {});
      const project = store.addProject(cleanRepo());
      const thread = service.createThread(project.id, "codex");
      await service.send({ threadId: thread.id, text: "Remember the secret word is kiwi." });
      await service.send({ threadId: thread.id, text: "What was the secret word?" });

      expect(injected).toHaveLength(1);
      const items = injected[0] as { type: string; content?: { text: string }[] }[];
      const message = items.find((i) => i.type === "message");
      expect(message?.content?.[0]?.text).toContain("Remembered: the secret word is kiwi.");
    });

    it("starts with nothing when the thread has no earlier messages", async () => {
      const store = open();
      let called = false;
      let seed: SessionSeed | null = { promptPrefix: "sentinel" };
      const agent = fakeAgent("claude", async (input) => {
        called = true;
        seed = await input.onSessionLost!("gone");
      });
      const service = new Service(store, () => catalog(), [agent], () => {});
      const project = store.addProject(cleanRepo());
      const thread = service.createThread(project.id, "claude");
      await service.send({ threadId: thread.id, text: "first" });

      expect(called).toBe(true);
      expect(seed).toBeNull();
      expect(noticeTexts(store, thread.id).some((t) => t.includes("This is a new one."))).toBe(true);
    });
  });
});

describe("replacedTokens with failed turns", () => {
  it("ignores a turn-end that reported zero usage", () => {
    const zero = normalizeUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const events: StoredEvent[] = [
      { seq: 1, createdAt: 0, event: { kind: "user", text: "Reply with exactly OK" } },
      { seq: 2, createdAt: 0, event: { kind: "turn-end", costUsd: null, inputTokens: 0, outputTokens: 0, durationMs: 1, usage: zero } },
    ];
    expect(replacedTokens(events)).toBe(estimateTokens("Reply with exactly OK"));
  });
});
