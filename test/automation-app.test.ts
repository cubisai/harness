import { describe, expect, it } from "vitest";
import { sendAndWait, sourcesForTemplate } from "../src/main/automations/app";
import type { StoredEvent, ThreadEvent } from "../src/shared/types";

const ev = (seq: number, event: ThreadEvent): StoredEvent => ({ seq, event, createdAt: seq });

/** A fake Service whose thread stays busy for `busyPolls` checks after send returns (a check fix round). */
function fake(events: StoredEvent[], busyPolls = 0) {
  let polls = 0;
  return {
    service: { send: async () => {}, isRunning: () => polls++ < busyPolls },
    store: { listEvents: () => events },
    polls: () => polls,
  };
}

describe("sendAndWait", () => {
  it("returns the last answer after the user's message, once the thread stays idle", async () => {
    const f = fake([ev(1, { kind: "user", text: "old" }), ev(2, { kind: "assistant-text", text: "stale" }), ev(3, { kind: "user", text: "go" }), ev(4, { kind: "assistant-text", text: "first" }), ev(5, { kind: "assistant-text", text: "final" })], 3);
    await expect(sendAndWait(f.service as never, f.store as never, "t", "go", 2)).resolves.toEqual({ text: "final" });
    expect(f.polls()).toBeGreaterThanOrEqual(5);
  });

  it("rejects when the turn ended on an error with no answer", async () => {
    const f = fake([ev(1, { kind: "user", text: "go" }), ev(2, { kind: "error", message: "provider down" })]);
    await expect(sendAndWait(f.service as never, f.store as never, "t", "go", 2)).rejects.toThrow("provider down");
  });
});

describe("sourcesForTemplate", () => {
  it("reads git only for the project brief", () => {
    expect(sourcesForTemplate("project-brief")).toEqual(["git"]);
    expect(sourcesForTemplate("repo-health")).toEqual([]);
  });
});
