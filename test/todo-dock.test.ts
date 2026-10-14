import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../src/shared/types";
import { dockedPlan, todoProgress } from "../src/renderer/src/todo";

const ev = (seq: number, event: unknown) => ({ seq, event }) as unknown as StoredEvent;
const plan = (seq: number, ...status: string[]) => ev(seq, { kind: "plan", entries: status.map((s, i) => ({ content: `step ${i}`, status: s })) });
const user = (seq: number) => ev(seq, { kind: "user", text: "go" });

describe("todo dock", () => {
  it("shows only the latest plan of the thread", () => {
    const d = dockedPlan([user(1), plan(2, "in_progress", "pending"), plan(3, "completed", "in_progress")]);
    expect(d?.seq).toBe(3);
  });
  it("keeps an unfinished plan across a new user message, drops a finished old one", () => {
    expect(dockedPlan([user(1), plan(2, "completed", "pending"), user(3)])?.seq).toBe(2);
    expect(dockedPlan([user(1), plan(2, "completed", "completed"), user(3)])).toBeNull();
  });
  it("keeps a finished plan from the current turn so it can read All done", () => {
    expect(dockedPlan([user(1), plan(2, "completed", "completed")])?.seq).toBe(2);
  });
  it("ignores empty plans and sub-agent plans", () => {
    expect(dockedPlan([user(1), plan(2)])).toBeNull();
    expect(dockedPlan([user(1), ev(2, { kind: "plan", parentId: "x", entries: [{ content: "a", status: "pending" }] })])).toBeNull();
  });
  it("reports progress and the current step", () => {
    const d = dockedPlan([user(1), plan(2, "completed", "in_progress", "pending")])!;
    expect(todoProgress(d.entries)).toEqual({ done: 1, total: 3, current: "step 1" });
  });
});
