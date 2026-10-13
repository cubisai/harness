// Anthropic's newer models bind each signed thinking block to the exact prefix
// it was produced after: the system prompt, the tool list and every earlier
// message. Replaying a block after any of those changed returns a 400 ("bound
// to a different conversation"). Dropping blocks is allowed as long as the ones
// kept are an unbroken run from the start, so whenever the harness rewrites
// history (pruning, compaction) or the prefix changes (memory, plan note, date),
// it strips the replay data from that point on. The reasoning text stays for
// display; only what would go back on the wire is dropped, and never restored.

import { createHash } from "node:crypto";
import { stableStringify } from "../../cache-policy";
import type { LlmMessage, ToolDefinition } from "../llm/types";

/** The protocol whose thinking blocks are prefix-bound. */
const BOUND = "anthropic-messages";

/**
 * Drop Anthropic replay data from every reasoning part in messages at index
 * `from` and later. Returns the same array when nothing changed.
 */
export function unbindThinking(messages: LlmMessage[], from = 0): LlmMessage[] {
  let changed = false;
  const out = messages.map((m, i): LlmMessage => {
    if (i < from || m.role !== "assistant") return m;
    if (!m.content.some((p) => p.type === "reasoning" && p.replay?.protocol === BOUND)) return m;
    changed = true;
    return {
      role: "assistant",
      content: m.content.map((p) => {
        if (p.type !== "reasoning" || p.replay?.protocol !== BOUND) return p;
        const { replay: _replay, ...rest } = p;
        return rest;
      }),
    };
  });
  return changed ? out : messages;
}

/** A fingerprint of the part of the prefix that comes before any message: system and tools. */
export function prefixKey(system: readonly string[], tools: readonly ToolDefinition[]): string {
  return createHash("sha256").update(stableStringify({ system, tools })).digest("hex");
}
