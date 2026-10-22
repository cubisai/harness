import { describe, expect, it } from "vitest";
import { runMetrics, todoOk, toolClass, type BenchEvent } from "../bench/lib/metrics";
import { cells, flags, summarize, type Cell } from "../bench/lib/summary";
import type { RunResult } from "../bench/lib/types";

const use = (name: string, id = name, parentId?: string): BenchEvent => ({ kind: "tool-use", toolUseId: id, name, summary: name, ...(parentId ? { parentId } : {}) });
const result = (id: string, isError = false): BenchEvent => ({ kind: "tool-result", toolUseId: id, isError, summary: "" });
const plan = (...status: ("pending" | "in_progress" | "completed")[]): BenchEvent => ({ kind: "plan", entries: status.map((s, i) => ({ content: `part ${i}`, status: s })) });
const end = (o: Partial<Extract<BenchEvent, { kind: "turn-end" }>> = {}): BenchEvent => ({ kind: "turn-end", costUsd: 0.01, inputTokens: 100, outputTokens: 50, durationMs: 20_000, ...o });

describe("toolClass", () => {
  it("maps every agent's names onto one set", () => {
    expect(["Read", "read", "Grep", "glob", "Search"].map(toolClass)).toEqual(["look", "look", "look", "look", "look"]);
    expect(["Run", "Bash", "bash", "shell"].map(toolClass)).toEqual(["shell", "shell", "shell", "shell"]);
    expect(["Edit", "write", "apply_patch"].map(toolClass)).toEqual(["edit", "edit", "edit"]);
    expect(toolClass("run_code")).toBe("code");
    expect(toolClass("update_plan")).toBe("todo");
    expect(toolClass("browser_open")).toBe("other");
  });
});

describe("runMetrics", () => {
  it("todo listed before the first edit and closed", () => {
    const m = runMetrics([plan("in_progress", "pending"), use("Read"), use("Edit"), plan("completed", "in_progress"), plan("completed", "completed"), end()]);
    expect(m.todo).toEqual({ updates: 3, parts: 2, beforeFirstEdit: true, allCompleted: true });
    expect(todoOk(m, "before-edit")).toBe(true);
    expect(todoOk(m, "none")).toBe(false);
  });

  it("a list after the first edit, or left open, fails before-edit", () => {
    const late = runMetrics([use("Edit"), plan("completed"), end()]);
    expect(late.todo.beforeFirstEdit).toBe(false);
    expect(todoOk(late, "before-edit")).toBe(false);
    const open = runMetrics([plan("pending"), use("Edit"), end()]);
    expect(open.todo.allCompleted).toBe(false);
    expect(todoOk(open, "before-edit")).toBe(false);
  });

  it("no list: none holds, null fields", () => {
    const m = runMetrics([use("Edit"), end()]);
    expect(m.todo).toEqual({ updates: 0, parts: 0, beforeFirstEdit: null, allCompleted: null });
    expect(todoOk(m, "none")).toBe(true);
    expect(todoOk(m, undefined)).toBeNull();
  });

  it("counts top-level tools only, and failed run_code scripts", () => {
    const m = runMetrics([use("run_code", "a"), result("a", true), use("run_code", "b"), result("b"), use("Read", "c"), use("Bash", "d"), use("Read", "e", "agent-1"), use("todowrite", "f"), end()]);
    expect(m.tools).toMatchObject({ total: 4, runCode: 2, runCodeFailed: 1, look: 1, shell: 1, edit: 0 });
    expect(m.tools.byName).toEqual({ run_code: 2, Read: 1, Bash: 1, todowrite: 1 });
  });

  it("sums top-level turn-ends; cost is null when any is unknown", () => {
    const sub = { ...end({ inputTokens: 999 }), parentId: "agent-1" } as BenchEvent;
    const m = runMetrics([end({ usage: { cacheReadTokens: 1000, cacheWriteTokens: 10, reasoningTokens: 5 } as never, steps: 3 }), sub, end({ costUsd: null })]);
    expect(m.tokens).toEqual({ input: 200, output: 100, cacheRead: 1000, cacheWrite: 10, reasoning: 5 });
    expect(m.durationMs).toBe(40_000);
    expect(m.costUsd).toBeNull();
    expect(m.steps).toBe(3);
  });

  it("finds skill sentinels anywhere, collects errors and the last answer", () => {
    const m = runMetrics(
      [use("Skill", "s"), { kind: "tool-result", toolUseId: "s", isError: false, summary: "", payload: { text: "body Reference: SENT-1" } }, { kind: "error", message: "429 rate limit" }, { kind: "assistant-text", text: "first" }, { kind: "assistant-text", text: "final" }, end()],
      new Map([["SENT-1", "changelog-entry"], ["SENT-2", "other"]]),
    );
    expect(m.skills).toEqual(["changelog-entry"]);
    expect(m.errors).toEqual(["429 rate limit"]);
    expect(m.answer).toBe("final");
  });
});

const run = (o: { task?: string; agent?: string; pass?: boolean; time?: number; trial?: number; todo?: boolean | null; date?: string }): RunResult => ({
  date: o.date ?? "2026-10-22",
  startedAt: "",
  task: o.task ?? "build-cli",
  agent: o.agent ?? "claude-sonnet",
  model: "sonnet",
  trial: o.trial ?? 1,
  harness: { commit: "abcdef1234", dirty: false, versions: { claude: "2.1.307" } },
  threadId: "t",
  status: o.pass === false ? "failed" : "passed",
  pass: o.pass ?? true,
  graders: o.pass === false ? [{ type: "command", pass: false, required: true, weight: 1, why: "node bench-check.mjs failed" }] : [],
  checks: { todo: o.todo === undefined ? true : o.todo, runCode: null, skills: null },
  metrics: { ...runMetrics([end({ durationMs: o.time ?? 60_000 })]) },
});

describe("summary", () => {
  it("folds trials into medians", () => {
    const c = cells([run({ time: 10_000 }), run({ time: 50_000, trial: 2, pass: false }), run({ time: 30_000, trial: 3, todo: false })]).get("build-cli|claude-sonnet|sonnet")!;
    expect(c).toMatchObject({ trials: 3, passes: 2, checksOk: 2, timeMs: 30_000 });
  });

  it("flags a verdict flip against the previous day", () => {
    const prev = cells([run({})]).get("build-cli|claude-sonnet|sonnet")!;
    const now = cells([run({ pass: false })]).get("build-cli|claude-sonnet|sonnet")!;
    expect(flags(now, [prev])).toEqual(["verdict pass → fail (0/1)"]);
  });

  it("flags a metric only outside the recent band, and only with enough days", () => {
    const day = (time: number): Cell => cells([run({ time })]).get("build-cli|claude-sonnet|sonnet")!;
    expect(flags(day(200_000), [day(60_000), day(70_000)])).toEqual([]);
    expect(flags(day(75_000), [day(60_000), day(70_000), day(65_000)])).toEqual([]);
    expect(flags(day(200_000), [day(60_000), day(70_000), day(65_000)])).toEqual(["time 200 s is outside the last 3 days (60 s–70 s)"]);
  });

  it("renders deltas, flags and failures", () => {
    const md = summarize({ date: "2026-10-22", runs: [run({ time: 90_000 }), run({ task: "read-heavy", pass: false })] }, [
      { date: "2026-10-21", runs: [run({ time: 60_000, date: "2026-10-21" }), run({ task: "read-heavy", date: "2026-10-21" })] },
    ]);
    expect(md).toContain("# Bench 2026-10-22");
    expect(md).toContain("Harness abcdef1 · claude 2.1.307");
    expect(md).toContain("90 s (+50%)");
    expect(md).toContain("- **read-heavy · claude-sonnet**: verdict pass → fail (0/1)");
    expect(md).toContain("- read-heavy · claude-sonnet t1: failed: node bench-check.mjs failed");
  });
});
