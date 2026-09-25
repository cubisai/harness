import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Provenance, ThreadEvent, Usage } from "../src/shared/types";
import { Store } from "../src/main/db";
import { closeAfter, tempDir } from "./helpers";

function storeWithThread(): { store: Store; threadId: string } {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const project = store.addProject("/tmp/events/project");
  const thread = store.createThread(project.id, "claude", "claude-opus-5", "ask");
  return { store, threadId: thread.id };
}

/**
 * Live deltas are not persistable. Never called; if `appendEvent` ever accepts
 * a `LiveDelta`, tsc reports an unused `@ts-expect-error` and typecheck fails.
 */
function liveDeltasAreNotPersistable(store: Store, threadId: string): void {
  // @ts-expect-error live deltas are not persistable
  store.appendEvent(threadId, { kind: "text-delta", itemId: "i", text: "x" });
}

const USAGE: Usage = {
  inputTokens: 100,
  outputTokens: 20,
  reasoningTokens: null,
  cacheReadTokens: 800,
  cacheWriteTokens: 100,
  cacheTtl: "5m",
  hitRate: 0.8,
  miss: false,
  provenance: "reported",
};

describe("events", () => {
  it("round-trips every terminal kind, including a 2 KB payload", () => {
    const { store, threadId } = storeWithThread();
    const payload = "x".repeat(2048);
    const events: ThreadEvent[] = [
      { kind: "user", text: "hi", skill: "implement" },
      { kind: "assistant-text", text: "hello" },
      { kind: "thinking", text: "hmm", signature: "sig-1", opaque: true },
      { kind: "tool-use", toolUseId: "u1", name: "Write", summary: "wrote a.ts", payload },
      { kind: "tool-result", toolUseId: "u1", isError: false, summary: "ok", payload: { path: "a.ts", lines: 3 } },
      { kind: "turn-end", costUsd: 0.1, inputTokens: 100, outputTokens: 20, durationMs: 1000, usage: USAGE },
      { kind: "error", message: "boom" },
      { kind: "notice", text: "note" },
      { kind: "turn-start", turnId: "turn-1", agent: "claude", model: "claude-opus-5" },
      { kind: "plan", entries: [{ content: "do the thing", status: "pending", priority: "high" }] },
      { kind: "compaction", trigger: "auto", preTokens: 1000, postTokens: 400 },
    ];
    for (const event of events) store.appendEvent(threadId, event);

    const back = store.listEvents(threadId).map((e) => e.event);
    expect(back).toEqual(events);

    const tool = back.find((e) => e.kind === "tool-use");
    if (tool?.kind !== "tool-use") throw new Error("missing tool-use event");
    expect(tool.payload).toBe(payload);
  });

  it("returns the provenance it was given, and null when omitted", () => {
    const { store, threadId } = storeWithThread();
    const provenance: Provenance = { agent: "claude", model: "claude-opus-5", provider: null, instanceId: "inst-1" };
    expect(store.appendEvent(threadId, { kind: "user", text: "hi" }, provenance).provenance).toEqual(provenance);
    expect(store.appendEvent(threadId, { kind: "notice", text: "n" }).provenance).toBeNull();
  });
});
