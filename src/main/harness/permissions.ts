// Which calls run, ask or are refused, per permission mode. Read-only work never
// asks; edits ask in "ask" mode and outside the thread's folder; shell asks
// unless the mode is "full"; plan mode is read-only.

import type { PermissionMode } from "../../shared/types";
import type { ToolAccess } from "./tools/types";

export type Verdict = "allow" | "ask" | "deny";

export function decide(mode: PermissionMode, access: ToolAccess, outside = false): Verdict {
  if (access === "read" || access === "other") return "allow";
  switch (mode) {
    case "full":
      return "allow";
    case "plan":
      return "deny";
    case "auto-edit":
      return access === "edit" && !outside ? "allow" : "ask";
    case "ask":
      return "ask";
  }
}

/** What the model reads when a call is refused. */
export function refusal(mode: PermissionMode, verdict: "deny" | "denied-by-user"): string {
  if (verdict === "denied-by-user") return "The user denied this call. Don't retry it; ask them or take another approach.";
  return mode === "plan" ? "Plan mode is read-only: investigate and propose a plan instead of changing files or running commands." : "This call isn't allowed in the current mode.";
}
