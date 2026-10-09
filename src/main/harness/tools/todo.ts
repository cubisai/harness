// The TodoWrite tool: the model's short task list for multi-step work. It is a
// plan for the thread rather than a file or shell tool, so its access is "other".

import type { PlanEntry } from "../../../shared/types";
import { ToolError, type NativeTool } from "./types";

/** Validate the raw `todos` argument and convert it to plan entries; throws ToolError on bad input. */
export function todosOf(args: Record<string, unknown>): PlanEntry[] {
  const raw = args.todos;
  if (!Array.isArray(raw)) throw new ToolError('Argument "todos" must be an array of { content, status, priority? }.');
  const todos: PlanEntry[] = [];
  let inProgress = 0;
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ToolError(`Todo ${index + 1} must be an object.`);
    const rec = item as Record<string, unknown>;
    const content = rec.content;
    if (typeof content !== "string" || !content.trim()) throw new ToolError(`Todo ${index + 1} needs a non-empty "content" string.`);
    const status = rec.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new ToolError(`Todo ${index + 1} "status" must be "pending", "in_progress", or "completed".`);
    }
    const priority = rec.priority;
    if (priority !== undefined && priority !== "high" && priority !== "medium" && priority !== "low") {
      throw new ToolError(`Todo ${index + 1} "priority" must be "high", "medium", or "low".`);
    }
    if (status === "in_progress") inProgress++;
    todos.push(priority === undefined ? { content, status } : { content, status, priority });
  });
  if (inProgress > 1) throw new ToolError("Only one todo may be in_progress at a time.");
  return todos;
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
  description:
    "Keep a short task list for multi-step work so progress stays visible. Send the whole list every time, not just the changed items: it replaces the previous list. Mark exactly one item in_progress while working on it, and completed as soon as it is done.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete task list, in order.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "The task, in a few words." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            priority: { type: "string", enum: ["high", "medium", "low"] },
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
    const inProgress = todos.filter((t) => t.status === "in_progress").length;
    const done = todos.filter((t) => t.status === "completed").length;
    const pending = todos.filter((t) => t.status === "pending").length;
    const active = todos.find((t) => t.status === "in_progress");
    return {
      text: `${todos.length} todos: ${inProgress} in progress, ${done} completed, ${pending} pending.`,
      display: { summary: active ? active.content : `${todos.length} todos`, result: { todos } },
    };
  },
};
