// The "task" tool: the main agent hands a self-contained research question to a
// read-only explore subagent, which runs its own small loop over read, glob and
// grep and reports back. Its events re-enter the thread under one Agent row.

import type { ThreadEvent } from "../../shared/types";
import { runLoop, type LoopTool } from "./loop";
import type { Route, streamLlm } from "./llm/client";
import type { LlmMessage, LlmRequest, LlmUsage } from "./llm/types";
import type { ToolResult } from "./tools/types";

export const TASK_TOOL = "task";
export const SUBAGENT_MAX_STEPS = 30;
export const SUBAGENT_RESULT_CHARS = 20_000;

/** The explore subagent's whole system prompt; it gets one task and reports back. */
export const EXPLORE_PROMPT = `You are a read-only exploration subagent. Another agent hands you one self-contained question; you investigate the code and report what you find.

How to work:
- Use read, glob and grep only. You cannot edit files or run commands, and you cannot ask anyone anything: when something is missing, say so in your report instead of asking.
- Investigate efficiently: make independent read-only calls in the same step, since they run together, and stop as soon as the question is answered.
- Ground every claim in code you actually read, with a path:line reference.

Report:
- Findings first, each one brief and referenced as path:line.
- Then open questions: what you could not determine, and what would resolve it.`;

interface TaskToolOptions {
  route: Route;
  request: Omit<LlmRequest, "messages" | "tools" | "system">;
  /** The caller passes only read-only tools; anything else is filtered out here. */
  tools(): LoopTool[];
  cwd: string;
  emit(e: ThreadEvent): void;
  /** The subagent's live text, reasoning and tool output, streamed under its Agent row (never stored). */
  live?: {
    text(text: string, itemId: string, parentId: string): void;
    reasoning(itemId: string, text: string, parentId: string): void;
    toolOutput(toolUseId: string, text: string, parentId: string): void;
  };
  onUsage(u: LlmUsage): void;
  stream?: typeof streamLlm;
}

/** The text parts of the last assistant message, trimmed; "" when it has none. */
function lastAssistantText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    return m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim();
  }
  return "";
}

/** The subagent's report, cut to a bounded size so it can't flood the parent. */
function boundReport(text: string): string {
  return text.length > SUBAGENT_RESULT_CHARS ? text.slice(0, SUBAGENT_RESULT_CHARS) + "\n…[report cut]" : text;
}

/**
 * The tool the main agent calls to start an explore subagent. Several calls in
 * one step run together as read-only calls; each runs its own loop and returns
 * one report, with every child event carried on the parent's thread under this
 * call's Agent row.
 */
export function createTaskTool(opts: TaskToolOptions): LoopTool {
  return {
    definition: {
      name: TASK_TOOL,
      description:
        "Start a read-only explore subagent for a self-contained research question (where is X, how does Y work, find all Z). It can read, glob and grep but not edit or run commands, and it doesn't see this conversation, so write a complete prompt. Several task calls in one step run in parallel. Returns the subagent's report.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "3-5 word label" },
          prompt: { type: "string", description: "The full task for the subagent" },
        },
        required: ["description", "prompt"],
      },
    },
    displayName: "Agent",
    access: "read",
    summarize: (args) => (typeof args.description === "string" && args.description.trim() ? args.description : "Explore"),
    inputPayload: (args) => ({ prompt: args.prompt, subagent_type: "explore" }),
    run: async (args, call): Promise<ToolResult> => {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) return { text: "The task tool needs a prompt.", isError: true };

      const tools = opts.tools().filter((t) => t.access === "read" && t.definition.name !== TASK_TOOL);
      const messages: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: prompt }] }];
      // The child's streamed usage isn't shown live; it's still worth reporting
      // if the loop dies before it returns.
      let seenUsage: LlmUsage | null = null;
      try {
        const result = await runLoop({
          route: opts.route,
          request: { ...opts.request, system: [EXPLORE_PROMPT, `Working folder: ${opts.cwd}`] },
          messages,
          tools,
          signal: call.signal,
          turnId: `${call.id}-sub`,
          maxSteps: SUBAGENT_MAX_STEPS,
          authorize: async () => ({ ok: true }),
          emit: {
            event: (e) => opts.emit({ ...e, parentId: call.id }),
            textDelta: (text, itemId) => opts.live?.text(text, itemId, call.id),
            reasoningDelta: (itemId, text) => opts.live?.reasoning(itemId, text, call.id),
            // A child's tool input isn't shown live; its tool row lands whole.
            toolInputDelta: () => {},
            toolOutputDelta: (toolUseId, text) => opts.live?.toolOutput(toolUseId, text, call.id),
            usage: (u) => {
              seenUsage = u;
            },
          },
          onMessage: () => {},
          ...(opts.stream ? { stream: opts.stream } : {}),
        });
        opts.onUsage(result.usage);
        if (result.stop === "stopped") return { text: "Interrupted by the user.", isError: true };
        let text = lastAssistantText(messages) || "The subagent finished without a report.";
        if (result.stop === "max-steps") text = `(Stopped at the step limit.) ${text}`;
        return { text: boundReport(text) };
      } catch (err) {
        if (seenUsage) opts.onUsage(seenUsage);
        return { text: `The subagent failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
