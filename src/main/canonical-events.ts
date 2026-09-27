/**
 * The render-parity contract (Phase 7 T7.12): one event set every adapter
 * must produce from its own native input, as the thread shows it. The unit
 * tests run it through all four drivers; the packaged smoke runs Claude's
 * adapter in-process and renders the result in the real window.
 */
import type { ThreadEvent } from "../shared/types";

export const CANONICAL = [
  { kind: "assistant-text", text: "I'll run the tests." },
  { kind: "tool-use", name: "Run", summary: "npm test" },
  { kind: "tool-result", summary: "3 passed" },
  { kind: "tool-use", name: "Edit", summary: "a.txt" },
  { kind: "tool-result", summary: "+1 −1" },
  { kind: "assistant-text", text: "Done." },
] as const;

/** The events the canonical set is about: messages and tool rows (no turn bookkeeping, thinking, or notices). */
export function visible(events: ThreadEvent[]): ThreadEvent[] {
  return events.filter((e) => e.kind === "assistant-text" || e.kind === "tool-use" || e.kind === "tool-result");
}

/** The fields the canonical expectation pins, per event. */
export function shape(e: ThreadEvent): Record<string, string> {
  if (e.kind === "assistant-text") return { kind: e.kind, text: e.text };
  if (e.kind === "tool-use") return { kind: e.kind, name: e.name, summary: e.summary };
  if (e.kind === "tool-result") return { kind: e.kind, summary: e.summary };
  return { kind: e.kind };
}

/**
 * The canonical set as stored events, shaped the way the Codex adapter emits
 * them: the reference another adapter's rows must render identically to.
 */
export function referenceEvents(): ThreadEvent[] {
  const diff = [{ path: "a.txt", unified: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+uno\n" }];
  return [
    { kind: "assistant-text", text: "I'll run the tests.", itemId: "m1" },
    { kind: "tool-use", toolUseId: "c1", name: "Run", summary: "npm test", payload: { command: "npm test" } },
    { kind: "tool-result", toolUseId: "c1", isError: false, summary: "3 passed", payload: { exitCode: 0, output: "3 passed" } },
    { kind: "tool-use", toolUseId: "f1", name: "Edit", summary: "a.txt", payload: { changes: [{ path: "a.txt", kind: "update", diff: diff[0]!.unified }] } },
    { kind: "tool-result", toolUseId: "f1", isError: false, summary: "+1 −1", payload: { diff } },
    { kind: "assistant-text", text: "Done.", itemId: "m2" },
  ];
}

/** The canonical set as Claude Agent SDK messages (assistant turns and tool results). */
export function claudeCanonicalMessages(): unknown[] {
  const assistant = (id: string, content: unknown[]) => ({ type: "assistant", parent_tool_use_id: null, message: { id, model: "claude-x", content } });
  const user = (content: unknown[]) => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content } });
  return [
    assistant("m1", [
      { type: "text", text: "I'll run the tests." },
      { type: "tool_use", id: "c1", name: "Bash", input: { command: "npm test" } },
    ]),
    user([{ type: "tool_result", tool_use_id: "c1", content: "3 passed" }]),
    assistant("m2", [{ type: "tool_use", id: "f1", name: "Edit", input: { file_path: "a.txt", old_string: "one\n", new_string: "uno\n" } }]),
    user([{ type: "tool_result", tool_use_id: "f1", content: "The file a.txt has been updated." }]),
    assistant("m3", [{ type: "text", text: "Done." }]),
  ];
}
