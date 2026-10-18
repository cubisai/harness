// Shrinks the context window by clearing the text of old tool results, which
// are usually the biggest and least reusable part of a long transcript. The
// newest results are protected so the model can still see what it just ran.
// Clearing a result rewrites history, so any signed thinking after the first
// cleared message can't be replayed any more (see binding.ts).

import type { LlmMessage, ToolResult } from "../llm/types";
import { savedOutputOf } from "../tools/bound";
import { unbindThinking } from "./binding";
import { estimateMessage, estimateText } from "./estimate";

export const PRUNED_MARKER = "[Old tool output cleared to save context. Run the tool again if you need it.]";
/** Opening of the marker left when the full output is on disk; the path follows. */
export const PRUNED_MARKER_SAVED = "[Old tool output cleared to save context. The full output is in";
export const PROTECT_TOKENS = 40_000;
export const MIN_SAVING = 20_000;

/** True when text is a pruned marker, with or without a saved-output path. */
export function isPruned(text: string): boolean {
  return text === PRUNED_MARKER || text.startsWith(PRUNED_MARKER_SAVED);
}

/**
 * Token budgets for pruning against a model's context window: a fixed share for
 * the protected tail and the minimum worth freeing, bounded so a large window
 * keeps today's constants and an unknown one (0) uses them outright.
 */
export function retentionFor(contextSize: number): { protect: number; minSaving: number } {
  if (contextSize <= 0) return { protect: PROTECT_TOKENS, minSaving: MIN_SAVING };
  const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
  return { protect: clamp(Math.round(contextSize * 0.2), 8_000, PROTECT_TOKENS), minSaving: clamp(Math.round(contextSize * 0.1), 4_000, MIN_SAVING) };
}

export interface PruneOptions {
  /** Token budget of recent messages that are never touched. */
  protect?: number;
  /** Do nothing unless at least this many tokens would be freed. */
  minSaving?: number;
  /** Return true to keep a result the caller still needs. */
  keep?: (r: ToolResult) => boolean;
  /** Called for a result with no saved path; returns where its full text was written, or null. */
  save?: (r: ToolResult) => string | null;
}

/** The marker left where a result's text was, naming where the full output is. */
const savedMarker = (path: string): string => `${PRUNED_MARKER_SAVED} ${path} (Read it with offset/limit, or Grep it).]`;

export function pruneToolOutputs(
  messages: LlmMessage[],
  opts?: PruneOptions,
): { messages: LlmMessage[]; saved: number; pruned: number } {
  const protect = opts?.protect ?? PROTECT_TOKENS;
  const minSaving = opts?.minSaving ?? MIN_SAVING;
  const keep = opts?.keep;
  const save = opts?.save;

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
      if (isPruned(r.text) || r.name === "skill" || keep?.(r)) continue;
      // Estimate the replacement without writing anything: an existing saved
      // path is known exactly, a would-be save is guessed at the marker's own
      // length, and with no save option the plain marker is the replacement.
      const ref = savedOutputOf(r.text);
      const replacement = ref !== null ? estimateText(savedMarker(ref)) : save ? estimateText(PRUNED_MARKER_SAVED) : estimateText(PRUNED_MARKER);
      const saving = estimateText(r.text) - replacement + (r.imagePng ? 1000 : 0);
      // A result no longer than the marker would free nothing, so it is never a
      // candidate and never counted toward the saving.
      if (saving <= 0) continue;
      candidates.push({ message: i, result: j, saving });
    }
  }

  let estimated = 0;
  for (const c of candidates) estimated += c.saving;
  if (estimated < minSaving) return { messages, saved: 0, pruned: 0 };

  // Past the minimum, write each result's full text and settle on its exact
  // marker. A result whose text already names a file is left with that path and
  // never hits save().
  const byMessage = new Map<number, Set<number>>();
  const replacements = new Map<string, string>();
  let saved = 0;
  for (const c of candidates) {
    let set = byMessage.get(c.message);
    if (!set) byMessage.set(c.message, (set = new Set()));
    set.add(c.result);
    const r = (messages[c.message] as Extract<LlmMessage, { role: "tool" }>).results[c.result]!;
    const path = savedOutputOf(r.text) ?? save?.(r) ?? null;
    const text = path !== null ? savedMarker(path) : PRUNED_MARKER;
    replacements.set(`${c.message}:${c.result}`, text);
    saved += estimateText(r.text) - estimateText(text) + (r.imagePng ? 1000 : 0);
  }

  const out = messages.map((m, i): LlmMessage => {
    const set = byMessage.get(i);
    if (!set || m.role !== "tool") return m;
    return {
      role: "tool",
      results: m.results.map((r, j) => {
        if (!set.has(j)) return r;
        const { imagePng: _png, ...rest } = r;
        return { ...rest, text: replacements.get(`${i}:${j}`)! };
      }),
    };
  });

  const first = Math.min(...byMessage.keys());
  return { messages: unbindThinking(out, first), saved, pruned: candidates.length };
}
