import { describe, expect, it } from "vitest";
import { rootTurnEnd, spansOf, timeSplit, type TimedEvent } from "../src/shared/run-trace";
import type { ThreadEvent } from "../src/shared/types";

const at = (t: number, event: ThreadEvent): TimedEvent => ({ t, event });
const end = (inputTokens: number, parentId?: string): ThreadEvent => ({ kind: "turn-end", costUsd: null, inputTokens, outputTokens: 1, durationMs: 1, ...(parentId ? { parentId } : {}) });

describe("run trace", () => {
  it("pairs tool calls with results, marks subagent calls as child spans and leaves unfinished ones open", () => {
    const spans = spansOf([
      at(0, { kind: "tool-use", toolUseId: "a", name: "Read", summary: "" }),
      at(5, { kind: "tool-use", toolUseId: "b", name: "Agent", summary: "" }),
      at(7, { kind: "tool-use", toolUseId: "c", name: "Grep", summary: "", parentId: "b" }),
      at(10, { kind: "tool-result", toolUseId: "a", isError: false, summary: "" }),
      at(12, { kind: "tool-result", toolUseId: "c", isError: true, summary: "" }),
      at(20, { kind: "compaction", trigger: "auto", preTokens: 10, postTokens: 5 }),
    ]);
    expect(spans.map((s) => [s.kind, s.id, s.start, s.end])).toEqual([
      ["tool", "a", 0, 10],
      ["child", "b", 5, null],
      ["tool", "c", 7, 12],
      ["compaction", "compaction-3", 20, 20],
    ]);
    expect(spans[2]).toMatchObject({ parentId: "b", isError: true });
  });

  it("counts overlapping top-level tool time once and ignores child-internal calls", () => {
    const spans = spansOf([
      at(0, { kind: "tool-use", toolUseId: "a", name: "Read", summary: "" }),
      at(2, { kind: "tool-use", toolUseId: "b", name: "Read", summary: "" }),
      at(2, { kind: "tool-use", toolUseId: "x", name: "Read", summary: "", parentId: "zz" }),
      at(6, { kind: "tool-result", toolUseId: "a", isError: false, summary: "" }),
      at(8, { kind: "tool-result", toolUseId: "b", isError: false, summary: "" }),
      at(9, { kind: "tool-result", toolUseId: "x", isError: false, summary: "" }),
      at(20, { kind: "tool-use", toolUseId: "c", name: "Bash", summary: "" }),
      at(25, { kind: "tool-result", toolUseId: "c", isError: false, summary: "" }),
    ]);
    expect(timeSplit(spans, 40)).toEqual({ toolMs: 13, otherMs: 27 });
  });

  it("takes the turn's own turn-end, not a member's", () => {
    expect(rootTurnEnd([end(100), end(5, "agent-1")])?.inputTokens).toBe(100);
    expect(rootTurnEnd([end(5, "agent-1")])).toBeUndefined();
  });
});
