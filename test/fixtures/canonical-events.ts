import type { ThreadEvent } from "../../src/shared/types";

/**
 * The canonical event set every adapter must produce from its own native
 * input (the "canonical" scenarios in the mocks): what the thread shows.
 */
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
