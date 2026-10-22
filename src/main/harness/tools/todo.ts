// The TodoWrite tool: the model's short task list for multi-step work. It is a
// plan for the thread rather than a file or shell tool, so its access is "other".

import { normalizePlan } from "../../../shared/plan";
import type { PlanEntry } from "../../../shared/types";
import { ToolError, type NativeTool } from "./types";

/** Validate the raw `todos` argument and convert it to plan entries; throws ToolError on bad input. */
export function todosOf(args: Record<string, unknown>): PlanEntry[] {
  const raw = args.todos;
  if (!Array.isArray(raw)) throw new ToolError('Argument "todos" must be an array of { content, status }.');
  let inProgress = 0;
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ToolError(`Todo ${index + 1} must be an object.`);
    const rec = item as Record<string, unknown>;
    if (typeof rec.content !== "string" || !rec.content.trim()) throw new ToolError(`Todo ${index + 1} needs a non-empty "content" string.`);
    const status = rec.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new ToolError(`Todo ${index + 1} "status" must be "pending", "in_progress", or "completed".`);
    }
    if (status === "in_progress") inProgress++;
  });
  if (inProgress > 1) throw new ToolError("Only one todo may be in_progress at a time.");
  // Strict above so the model learns the shape; the stored list is the shared canonical one.
  return normalizePlan(raw) ?? [];
}

/**
 * What a todowrite call tells the model: the counts, and while parts are open a reminder to
 * keep the list current (fresh in context right when it matters; without it models write the
 * list once and never come back to it).
 */
export function todoResult(todos: PlanEntry[]): string {
  const count = (s: PlanEntry["status"]) => todos.filter((t) => t.status === s).length;
  const open = count("completed") < todos.length;
  return `${todos.length} todos: ${count("in_progress")} in progress, ${count("completed")} completed, ${count("pending")} pending.${open ? " Update this list as each part finishes, and before your final reply." : ""}`;
}

/** The in-progress item's content, else the count; tolerates raw args for the permission card. */
function summarizeTodos(raw: unknown): string {
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      if (rec.status === "in_progress" && typeof rec.content === "string") return rec.content;
    }
  }
  return `${list.length} todos`;
}

/** The model-facing task-list tool: the whole list each call, one item in progress. */
export const todoTool: NativeTool = {
  name: "todowrite",
  displayName: "TodoWrite",
  // The trigger leads: models pick tools by their descriptions more than by system-prompt lines (live tests).
  description:
    "Call this first, before any other tool, for any request with 3+ parts (several files, or code plus tests or docs), then again each time a part finishes (it completed, the next in_progress) and once more before your final reply. Send the whole list each call; it replaces the last.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "A few words." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  access: "other",
  summarize(args) {
    return summarizeTodos(args.todos);
  },
  async run(args) {
    const todos = todosOf(args);
    const active = todos.find((t) => t.status === "in_progress");
    return {
      text: todoResult(todos),
      display: { summary: active ? active.content : `${todos.length} todos` },
    };
  },
};
