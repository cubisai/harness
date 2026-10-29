import { describe, expect, it } from "vitest";
import { formatDuration, memberRuns, memberTotals, runLine, type MemberRun } from "../src/shared/team-runs";
import type { RunUsage, StoredEvent, ThreadEvent } from "../src/shared/types";

const at = (createdAt: number, event: ThreadEvent): StoredEvent => ({ seq: createdAt, event, createdAt });
/** An `Agent` handoff to a member: summary ends in ` · <id>`. */
const handoff = (toolUseId: string, id: string): ThreadEvent => ({ kind: "tool-use", toolUseId, name: "Agent", summary: `Take this step · ${id}` });
const result = (toolUseId: string, opts: { isError?: boolean; summary?: string; runUsage?: RunUsage } = {}): ThreadEvent => ({
  kind: "tool-result",
  toolUseId,
  isError: opts.isError ?? false,
  summary: opts.summary ?? "done",
  ...(opts.runUsage ? { runUsage: opts.runUsage } : {}),
});
const run = (partial: Partial<MemberRun>): MemberRun => ({
  memberId: "analyst",
  toolUseId: "t1",
  status: "done",
  startedAt: 0,
  endedAt: 4200,
  durationMs: 4200,
  summary: "",
  usage: null,
  ...partial,
});

describe("memberRuns", () => {
  it("reads a member's runs in event order: done, failed, stopped and running", () => {
    const runs = memberRuns(
      [
        at(1000, handoff("t1", "analyst")),
        at(1500, result("t1", { summary: "analysis done" })),
        at(2000, handoff("t2", "writer")),
        at(2300, result("t2", { isError: true, summary: "boom" })),
        at(3000, handoff("t3", "analyst")),
        at(3100, { kind: "user", text: "stop" }),
        at(4000, handoff("t4", "writer")),
      ],
      ["analyst", "writer"],
    );
    expect(runs.map((r) => [r.memberId, r.status, r.startedAt, r.endedAt, r.durationMs])).toEqual([
      ["analyst", "done", 1000, 1500, 500],
      ["writer", "failed", 2000, 2300, 300],
      ["analyst", "stopped", 3000, 3100, 100],
      ["writer", "running", 4000, null, null],
    ]);
    expect(runs[0]!.summary).toBe("analysis done");
    expect(runs[2]!.summary).toBe("");
  });

  it("stops an open run on a root turn-end or an error", () => {
    expect(
      memberRuns([at(1000, handoff("t1", "analyst")), at(1200, { kind: "turn-end", costUsd: null, inputTokens: 0, outputTokens: 0, durationMs: 0 })], ["analyst"])[0],
    ).toMatchObject({ status: "stopped", endedAt: 1200, durationMs: 200 });
    expect(memberRuns([at(1000, handoff("t1", "analyst")), at(1300, { kind: "error", message: "boom" })], ["analyst"])[0]).toMatchObject({ status: "stopped", endedAt: 1300 });
  });

  it("carries runUsage from the tool-result, and null without one", () => {
    const usage: RunUsage = { inputTokens: 12000, outputTokens: 300, costUsd: 0.0123 };
    expect(memberRuns([at(1000, handoff("t1", "analyst")), at(1500, result("t1", { runUsage: usage }))], ["analyst"])[0]!.usage).toEqual(usage);
    expect(memberRuns([at(1000, handoff("t1", "analyst")), at(1500, result("t1"))], ["analyst"])[0]!.usage).toBeNull();
  });

  it("doesn't let a member's own child events close its run", () => {
    const runs = memberRuns(
      [
        at(1000, handoff("t1", "analyst")),
        at(1200, { kind: "turn-end", costUsd: null, inputTokens: 1, outputTokens: 1, durationMs: 1, parentId: "t1" }),
        at(1400, { kind: "user", text: "child", parentId: "t1" }),
      ],
      ["analyst"],
    );
    expect(runs[0]!.status).toBe("running");
  });

  it("matches the exact id, not a suffix of another (a vs data)", () => {
    const runs = memberRuns(
      [
        at(1000, { kind: "tool-use", toolUseId: "t1", name: "Agent", summary: "check this · data" }),
        at(1500, result("t1")),
        at(2000, { kind: "tool-use", toolUseId: "t2", name: "Agent", summary: "check that · a" }),
      ],
      ["a", "data"],
    );
    expect(runs.map((r) => r.memberId)).toEqual(["data", "a"]);
  });
});

describe("memberTotals", () => {
  it("sums a member's finished runs and counts the unpriced ones", () => {
    const runs = memberRuns(
      [
        at(1000, handoff("t1", "analyst")),
        at(1500, result("t1", { runUsage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.01 } })),
        at(2000, handoff("t2", "analyst")),
        at(2800, result("t2", { isError: true, summary: "boom", runUsage: { inputTokens: 2000, outputTokens: 100, costUsd: null } })),
        at(3000, handoff("t3", "analyst")),
      ],
      ["analyst"],
    );
    expect(memberTotals(runs, "analyst")).toEqual({ runs: 2, failed: 1, durationMs: 1300, inputTokens: 3000, outputTokens: 600, costUsd: 0.01, unpriced: 1 });
    expect(memberTotals(runs, "writer")).toEqual({ runs: 0, failed: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: null, unpriced: 0 });
  });
});

describe("formatDuration and runLine", () => {
  it("formats durations exactly", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(4200)).toBe("4.2 s");
    expect(formatDuration(65000)).toBe("1 min 5 s");
  });

  it("writes one line per run", () => {
    expect(runLine(run({}))).toBe("done · 4.2 s");
    expect(runLine(run({ usage: { inputTokens: 12000, outputTokens: 300, costUsd: 0.0123 } }))).toBe("done · 4.2 s · 12.3k tokens · $0.0123");
    expect(runLine(run({ usage: { inputTokens: 200, outputTokens: 45, costUsd: null } }))).toBe("done · 4.2 s · 245 tokens");
    expect(runLine(run({ status: "failed", endedAt: 850, durationMs: 850 }))).toBe("failed · 850 ms");
    expect(runLine(run({ status: "stopped", endedAt: 100, durationMs: 100 }))).toBe("stopped · 100 ms");
    expect(runLine(run({ status: "running", endedAt: null, durationMs: null }))).toBe("working");
  });
});
