// Shrinks the context window by clearing the text of old tool results, which
// are usually the biggest and least reusable part of a long transcript. The
// newest results are protected so the model can still see what it just ran.
// Clearing a result rewrites history, so any signed thinking after the first
// cleared message can't be replayed any more (see binding.ts).

import type { LlmMessage, ToolResult } from "../llm/types";
import { unbindThinking } from "./binding";
import { estimateMessage, estimateText } from "./estimate";

export const PRUNED_MARKER = "[Old tool output cleared to save context. Run the tool again if you need it.]";
export const PROTECT_TOKENS = 40_000;
export const MIN_SAVING = 20_000;

export interface PruneOptions {
  /** Token budget of recent messages that are never touched. */
  protect?: number;
  /** Do nothing unless at least this many tokens would be freed. */
  minSaving?: number;
  /** Return true to keep a result the caller still needs. */
  keep?: (r: ToolResult) => boolean;
}

export function pruneToolOutputs(
  messages: LlmMessage[],
  opts?: PruneOptions,
): { messages: LlmMessage[]; saved: number; pruned: number } {
  const protect = opts?.protect ?? PROTECT_TOKENS;
  const minSaving = opts?.minSaving ?? MIN_SAVING;
  const keep = opts?.keep;

  // The tool message the model just saw is never a candidate, even with no
  // protection budget.
  let newestTool = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "tool") {
      newestTool = i;
      break;
    }
  }

  // Walk newest to oldest. Everything while the running total is under the
  // protection budget is left alone; older tool results become candidates.
  const candidates: { message: number; result: number; saving: number }[] = [];
  let running = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const inProtect = running < protect;
    running += estimateMessage(m);
    if (inProtect || i === newestTool || m.role !== "tool") continue;
    for (let j = 0; j < m.results.length; j++) {
      const r = m.results[j]!;
      if (r.text === PRUNED_MARKER || r.name === "skill" || keep?.(r)) continue;
      const saving = estimateText(r.text) - estimateText(PRUNED_MARKER) + (r.imagePng ? 1000 : 0);
      // A result no longer than the marker would free nothing, so it is never a
      // candidate and never counted toward the saving.
      if (saving <= 0) continue;
      candidates.push({ message: i, result: j, saving });
    }
  }

  let saved = 0;
  for (const c of candidates) saved += c.saving;
  if (saved < minSaving) return { messages, saved: 0, pruned: 0 };

  const byMessage = new Map<number, Set<number>>();
  for (const c of candidates) {
    let set = byMessage.get(c.message);
    if (!set) byMessage.set(c.message, (set = new Set()));
    set.add(c.result);
  }

  const out = messages.map((m, i): LlmMessage => {
    const set = byMessage.get(i);
    if (!set || m.role !== "tool") return m;
    return {
      role: "tool",
      results: m.results.map((r, j) => {
        if (!set.has(j)) return r;
        const { imagePng: _png, ...rest } = r;
        return { ...rest, text: PRUNED_MARKER };
      }),
    };
  });

  const first = Math.min(...byMessage.keys());
  return { messages: unbindThinking(out, first), saved, pruned: candidates.length };
}
