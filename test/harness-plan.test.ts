import { describe, expect, it } from "vitest";
import type { PermissionMode, PlanDecision } from "../src/shared/types";
import { createProposePlanTool, PLAN_MODE_NOTE, PROPOSE_PLAN_TOOL } from "../src/main/harness/plan";

const call = { id: "c1", signal: new AbortController().signal, onOutput: () => {} };

function make(opts: { mode?: PermissionMode; decide?: (plan: string) => Promise<PlanDecision>; signal?: AbortSignal } = {}) {
  const approved: ("auto-edit" | "ask")[] = [];
  const decided: string[] = [];
  const tool = createProposePlanTool({
    mode: () => opts.mode ?? "plan",
    decide: async (plan) => (decided.push(plan), await (opts.decide?.(plan) ?? "auto")),
    signal: opts.signal ?? new AbortController().signal,
    onApproved: (m) => approved.push(m),
  });
  return { tool, approved, decided };
}

describe("propose_plan", () => {
  it("declares the tool and the mode note", () => {
    const { tool } = make();
    expect(PROPOSE_PLAN_TOOL).toBe("propose_plan");
    expect(tool.definition.name).toBe(PROPOSE_PLAN_TOOL);
    expect(tool.displayName).toBe("Plan");
    expect(tool.access).toBe("read");
    expect(tool.definition.parameters).toEqual({ type: "object", properties: { plan: { type: "string", description: "The plan in Markdown" } }, required: ["plan"] });
    expect(PLAN_MODE_NOTE).toContain("Plan mode is on");
    expect(PLAN_MODE_NOTE).toContain("only asks a question, answer it (using a matching skill if one applies) without calling propose_plan");
  });

  it("summarizes with the plan's first line", () => {
    const { tool } = make();
    expect(tool.summarize({ plan: "## Plan\n1. step" })).toBe("## Plan");
    expect(tool.summarize({ plan: "  " })).toBe("Plan");
  });

  it("turns on automatic edits when the user chooses auto", async () => {
    const { tool, approved, decided } = make({ decide: async () => "auto" });
    const r = await tool.run({ plan: "## Plan\n1. step" }, call);
    expect(r).toEqual({ text: "The user approved the plan and turned on automatic edits. Implement it now, step by step, then verify." });
    expect(approved).toEqual(["auto-edit"]);
    expect(decided).toEqual(["## Plan\n1. step"]);
  });

  it("turns on per-call approvals when the user chooses manual", async () => {
    const { tool, approved } = make({ decide: async () => "manual" });
    const r = await tool.run({ plan: "do it" }, call);
    expect(r).toEqual({ text: "The user approved the plan; each edit and command will ask for approval. Implement it now, step by step, then verify." });
    expect(approved).toEqual(["ask"]);
  });

  it("asks for a revision with the user's feedback when they keep planning", async () => {
    const { tool, approved } = make({ decide: async () => ({ keep: "  add tests  " }) });
    const r = await tool.run({ plan: "do it" }, call);
    expect(r.text).toBe("The user wants to keep planning: add tests Revise the plan and call propose_plan again.");
    expect(approved).toEqual([]);
  });

  it("asks for a revision without feedback when they keep planning silently", async () => {
    const { tool } = make({ decide: async () => ({ keep: "" }) });
    const r = await tool.run({ plan: "do it" }, call);
    expect(r.text).toBe("The user wants to keep planning. Revise the plan and call propose_plan again.");
  });

  it("refuses an empty plan", async () => {
    const { tool, decided } = make();
    const r = await tool.run({ plan: "   " }, call);
    expect(r).toEqual({ text: "Give the plan text.", isError: true });
    expect(decided).toEqual([]);
  });

  it("refuses when plan mode is off", async () => {
    const { tool, decided } = make({ mode: "ask" });
    const r = await tool.run({ plan: "do it" }, call);
    expect(r).toEqual({ text: "Plan mode is off; carry on with the task.", isError: true });
    expect(decided).toEqual([]);
  });

  it("reports a Stop while the card was up as an interruption", async () => {
    const c = new AbortController();
    const { tool, approved } = make({ signal: c.signal, decide: async () => (c.abort(), "auto") });
    const r = await tool.run({ plan: "do it" }, call);
    expect(r).toEqual({ text: "Interrupted by the user.", isError: true });
    expect(approved).toEqual([]);
  });
});
