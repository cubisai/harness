// Which calls run, ask or are refused, per permission mode. Read-only work never
// asks; edits ask in "ask" mode and outside the thread's folder; shell asks
// unless the mode is "full"; plan mode is read-only. A web fetch asks unless the
// mode is "full", in plan mode too: it reads, but a URL can carry data out.

import type { PermissionMode } from "../../shared/types";
import type { ToolAccess } from "./tools/types";

export type Verdict = "allow" | "ask" | "deny";

export function decide(mode: PermissionMode, access: ToolAccess, outside = false): Verdict {
  if (access === "read" || access === "other") return "allow";
  switch (mode) {
    case "full":
      return "allow";
    case "plan":
      return access === "web" ? "ask" : "deny";
    case "auto-edit":
      return access === "edit" && !outside ? "allow" : "ask";
    case "ask":
      return "ask";
  }
}

/** What the model reads when a call is refused. */
export function refusal(mode: PermissionMode, verdict: "deny" | "denied-by-user"): string {
  if (verdict === "denied-by-user") return "The user denied this call. Don't retry it, and don't get the same result another way; tell them it was blocked, or continue with the rest.";
  return mode === "plan" ? "Plan mode is read-only: investigate and propose a plan instead of changing files or running commands." : "This call isn't allowed in the current mode.";
}
