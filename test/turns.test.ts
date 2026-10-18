import { describe, expect, it } from "vitest";
import { createSegmenter, segmentEvents, workDuration, workSummary } from "../src/renderer/src/turns";
import type { StoredEvent, ThreadEvent } from "../src/shared/types";

let seq = 0;
const at = (createdAt: number, event: ThreadEvent): StoredEvent => ({ seq: ++seq, createdAt, event });
const tool = (t: number, id: string, name: string, summary: string) => at(t, { kind: "tool-use", toolUseId: id, name, summary });
const result = (t: number, id: string, summary?: string) => at(t, { kind: "tool-result", toolUseId: id, isError: false, ...(summary ? { summary } : {}) } as ThreadEvent);
const text = (t: number, s: string) => at(t, { kind: "assistant-text", text: s });
const end = (t: number) => at(t, { kind: "turn-end", costUsd: null, inputTokens: 10, outputTokens: 5, durationMs: 1000 });

describe("segmentEvents", () => {
  const turn = () => [
    at(0, { kind: "user", text: "fix it" }),
    tool(1000, "a", "Read", "src/a.ts"),
    result(2000, "a"),
    text(3000, "Now the edit."),
    tool(4000, "b", "Edit", "src/a.ts"),
    result(5000, "b", "+3 −1"),
    tool(6000, "c", "Bash", "bun test"),
    result(9000, "c"),
    text(41_000, "Done."),
    end(42_000),
  ];

  it("folds a turn's tool calls, with the narration between them, into one finished run", () => {
    const segs = segmentEvents(turn(), false);
    expect(segs.map((s) => s.kind)).toEqual(["event", "work", "event", "turn-end"]);
    const work = segs[1] as Extract<(typeof segs)[number], { kind: "work" }>;
    expect(work.done).toBe(true);
    expect(work.items.map((e) => e.event.kind)).toEqual(["tool-use", "tool-result", "assistant-text", "tool-use", "tool-result", "tool-use", "tool-result"]);
    // From the first call to the answer that followed the last one.
    expect(work.endedAt - work.startedAt).toBe(40_000);
  });

  it("gives the turn-end the final answer, the prompt, and what the turn changed", () => {
    const last = segmentEvents(turn(), false).at(-1)!;
    expect(last).toMatchObject({ kind: "turn-end", answer: "Done.", prompt: { text: "fix it" }, changes: { files: ["src/a.ts"], additions: 3, deletions: 1 } });
  });

  it("leaves a run still in progress unfolded while the turn runs", () => {
    const events = turn().slice(0, 5);
    const segs = segmentEvents(events, true);
    expect(segs.at(-1)).toMatchObject({ kind: "work", done: false });
  });

  it("keeps thinking without tool calls as its own reasoning row", () => {
    const segs = segmentEvents([at(0, { kind: "user", text: "hi" }), at(1, { kind: "thinking", text: "hm" }), text(2, "hello"), end(3)], false);
    expect(segs.map((s) => (s.kind === "event" ? s.stored.event.kind : s.kind))).toEqual(["user", "thinking", "assistant-text", "turn-end"]);
  });

  it("leaves the line counts out when no edit reported a stat", () => {
    const segs = segmentEvents([at(0, { kind: "user", text: "q" }), tool(1, "e", "Write", "b.md"), result(2, "e", "Created"), text(3, "ok"), end(4)], false);
    expect(segs.at(-1)).toMatchObject({ kind: "turn-end", changes: { files: ["b.md"], additions: null, deletions: null } });
  });

  it("has no changes for a turn that edited nothing", () => {
    const segs = segmentEvents([at(0, { kind: "user", text: "q" }), text(1, "a"), end(2)], false);
    expect(segs.at(-1)).toMatchObject({ kind: "turn-end", changes: null, answer: "a" });
  });

  it("createSegmenter matches segmentEvents on the fixture turns", () => {
    const closed = turn();
    expect(createSegmenter()(closed, false)).toEqual(segmentEvents(closed, false));
    const open = turn().slice(0, 5);
    expect(createSegmenter()(open, true)).toEqual(segmentEvents(open, true));
  });
});

describe("workSummary", () => {
  it("counts reads, searches, edited files, commands and other steps", () => {
    const items = [tool(0, "1", "Read", "a"), tool(0, "2", "Read", "b"), tool(0, "3", "Grep", "x"), tool(0, "4", "Edit", "a"), tool(0, "5", "Write", "a"), tool(0, "6", "Bash", "ls"), tool(0, "7", "browser_open", "u")];
    expect(workSummary(items)).toBe("read 2 files · searched 1 time · edited 1 file · ran 1 command · 1 other step");
  });
});

describe("workDuration", () => {
  it("reads as seconds, then minutes, then hours", () => {
    expect(workDuration(41_400)).toBe("41s");
    expect(workDuration(125_000)).toBe("2m 05s");
    expect(workDuration(3_780_000)).toBe("1h 3m");
  });
});
