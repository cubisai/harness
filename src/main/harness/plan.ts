// Plan mode for the native agent: the propose_plan tool the model calls once it
// has investigated, and the system-prompt note that explains the mode. The
// user's decision switches the rest of the turn to auto-edit or ask, or asks
// for a revised plan.

import type { PermissionMode, PlanDecision } from "../../shared/types";
import type { LoopTool } from "./loop";

export const PROPOSE_PLAN_TOOL = "propose_plan";

/** The system-prompt part that turns plan mode on; it goes last, after the environment. */
export const PLAN_MODE_NOTE =
  "Plan mode is on: you can read and search but not edit files or run commands. Investigate what's needed, then call propose_plan once with a concrete Markdown plan: the goal, the files to change and how, and how you'll verify it. Don't ask for approval in text; the propose_plan call is the approval request. If the user asks you to keep planning, revise and call propose_plan again.";

/** The propose_plan tool: presenting a plan is the approval request. */
export function createProposePlanTool(opts: {
  mode(): PermissionMode;
  decide(plan: string): Promise<PlanDecision>;
  signal: AbortSignal;
  onApproved(mode: "auto-edit" | "ask"): void;
}): LoopTool {
  return {
    definition: {
      name: PROPOSE_PLAN_TOOL,
      description:
        "Present the plan you're proposing and wait for the user's decision. Use it once you've investigated and know what you'd change; don't ask for approval in text. If the user asks you to keep planning, revise the plan and call it again.",
      parameters: {
        type: "object",
        properties: { plan: { type: "string", description: "The plan in Markdown" } },
        required: ["plan"],
      },
    },
    displayName: "Plan",
    access: "read",
    summarize: (args) => {
      const first = String(args.plan ?? "").trim().split("\n")[0]?.trim() ?? "";
      return first || "Plan";
    },
    run: async (args) => {
      if (opts.mode() !== "plan") return { text: "Plan mode is off; carry on with the task.", isError: true };
      const plan = typeof args.plan === "string" ? args.plan : "";
      if (!plan.trim()) return { text: "Give the plan text.", isError: true };
      const d = await opts.decide(plan);
      if (opts.signal.aborted) return { text: "Interrupted by the user.", isError: true };
      if (d === "auto") {
        opts.onApproved("auto-edit");
        return { text: "The user approved the plan and turned on automatic edits. Implement it now, step by step, then verify." };
      }
      if (d === "manual") {
        opts.onApproved("ask");
        return { text: "The user approved the plan; each edit and command will ask for approval. Implement it now, step by step, then verify." };
      }
      const feedback = d.keep.trim();
      return { text: `The user wants to keep planning${feedback ? `: ${feedback}` : "."} Revise the plan and call propose_plan again.` };
    },
  };
}
