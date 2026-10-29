/**
 * The one todo-list shape every agent's plan becomes, whichever tool or
 * notification carried it (Claude's TodoWrite, Codex's turn/plan/updated,
 * OpenCode's todowrite or ACP plan update, the native todowrite tool).
 */

import type { PlanEntry } from "./types";

type Status = PlanEntry["status"];

/** An agent's own status word as one of ours, or null for a dropped item; unknown words count as pending. */
function statusOf(raw: unknown): Status | null {
  if (typeof raw !== "string") return "pending";
  switch (raw.replace(/[\s_-]/g, "").toLowerCase()) {
    case "inprogress":
    case "active":
    case "running":
      return "in_progress";
    case "completed":
    case "complete":
    case "done":
      return "completed";
    // Dropped work isn't done: showing it ticked off would overstate progress.
    case "cancelled":
    case "canceled":
    case "skipped":
      return null;
    default:
      return "pending";
  }
}

/**
 * A raw list of todo items as canonical plan entries: `{ content, status }`
 * only, content trimmed, cancelled items left out, at most one in_progress
 * (later ones fall back to pending). Items read their text from `content`, else `step` (Codex), else
 * `title`. Null when `raw` isn't a list or an item has no text, so the caller
 * can treat the call as an ordinary tool.
 */
export function normalizePlan(raw: unknown): PlanEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: PlanEntry[] = [];
  let active = false;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    const text = [rec.content, rec.step, rec.title].find((v) => typeof v === "string");
    if (typeof text !== "string" || !text.trim()) return null;
    let status = statusOf(rec.status);
    if (status === null) continue;
    if (status === "in_progress") {
      if (active) status = "pending";
      active = true;
    }
    entries.push({ content: text.trim(), status });
  }
  return entries;
}

/** Whether two plans list the same items with the same statuses. */
export function samePlan(a: PlanEntry[], b: PlanEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.content === b[i]!.content && e.status === b[i]!.status);
}
