import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../src/shared/types";
import { dockedPlan, todoProgress } from "../src/renderer/src/todo";

const ev = (seq: number, event: unknown) => ({ seq, event }) as unknown as StoredEvent;
const plan = (seq: number, ...status: string[]) => ev(seq, { kind: "plan", entries: status.map((s, i) => ({ content: `step ${i}`, status: s })) });
const user = (seq: number) => ev(seq, { kind: "user", text: "go" });
const end = (seq: number) => ev(seq, { kind: "turn-end" });

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
  it("marks an unfinished list Paused once its turn has ended, and live again when the agent updates it", () => {
    expect(dockedPlan([user(1), plan(2, "completed", "pending")])?.paused).toBe(false);
    expect(dockedPlan([user(1), plan(2, "completed", "pending"), end(3)])?.paused).toBe(true);
    expect(dockedPlan([user(1), plan(2, "completed", "pending"), end(3), user(4)])?.paused).toBe(true);
    expect(dockedPlan([user(1), plan(2, "completed", "pending"), end(3), user(4), plan(5, "completed", "in_progress")])?.paused).toBe(false);
    // A finished list is never Paused.
    expect(dockedPlan([user(1), plan(2, "completed", "completed"), end(3)])?.paused).toBe(false);
  });
  it("docks no more once the user dismisses that list, until a new one arrives", () => {
    const events = [user(1), plan(2, "pending"), end(3)];
    expect(dockedPlan(events, 2)).toBeNull();
    expect(dockedPlan([...events, plan(4, "in_progress")], 2)?.seq).toBe(4);
  });
  it("reports progress and the current step", () => {
    const d = dockedPlan([user(1), plan(2, "completed", "in_progress", "pending")])!;
    expect(todoProgress(d.entries)).toEqual({ done: 1, total: 3, current: "step 1" });
  });
});
