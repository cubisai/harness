import { useEffect, useState } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import type { StoredEvent } from "../../../shared/types";

/** Claude Code's spinner glyphs, cycled while a turn runs. */
export const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

const VERBS = ["Thinking", "Working", "Pondering", "Crafting", "Cooking", "Brewing", "Musing", "Tinkering", "Computing", "Noodling", "Forging", "Weaving"];

/** A verb that stays the same for a turn: picked from the turn's start time. */
export function verbFor(startedAt: number): string {
  return VERBS[Math.floor(startedAt / 1000) % VERBS.length]!;
}

/** "42s", "3m 04s". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function tokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/** What the agent is doing right now, for the orb and the verb beside it. */
export type Activity = "thinking" | "editing" | "searching" | "reading" | "running" | "tool" | "writing" | "connecting" | "idle";

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|fileChange)$/i;
const SEARCH_TOOLS = /^(WebSearch|WebFetch|Search|web_search|browser_.*)$/i;
const READ_TOOLS = /^(Grep|Glob|Read|LS|list_files)$/i;
const RUN_TOOLS = /^(Bash|Run|Shell|exec)$/i;

/**
 * The activity a turn is in, read from its events and live streams. First match
 * wins: the newest top-level tool call still waiting on a result, else text,
 * else reasoning, else a turn that never started.
 */
export function activityOf(turnEvents: StoredEvent[], live: { textStreaming: boolean; reasoningStreaming: boolean }): Activity {
  const answered = new Set<string>();
  for (const e of turnEvents) if (e.event.kind === "tool-result") answered.add(e.event.toolUseId);
  for (let i = turnEvents.length - 1; i >= 0; i--) {
    const e = turnEvents[i]!.event;
    if (e.kind !== "tool-use" || e.parentId || answered.has(e.toolUseId)) continue;
    if (EDIT_TOOLS.test(e.name)) return "editing";
    if (SEARCH_TOOLS.test(e.name)) return "searching";
    if (READ_TOOLS.test(e.name)) return "reading";
    if (RUN_TOOLS.test(e.name)) return "running";
    return "tool";
  }
  if (live.textStreaming) return "writing";
  if (live.reasoningStreaming) return "thinking";
  if (!turnEvents.some((e) => e.event.kind === "turn-start")) return "connecting";
  return "idle";
}

/** The orb state and verb for an activity; idle keeps the turn's fallback verb. */
function orbFor(activity: Activity, startedAt: number): { state: OrbState; verb: string } {
  switch (activity) {
    case "thinking": return { state: "solving", verb: "Thinking" };
    case "editing": return { state: "shaping", verb: "Editing" };
    case "searching": return { state: "searching", verb: "Searching" };
    case "reading": return { state: "searching", verb: "Reading" };
    case "running": return { state: "working", verb: "Running" };
    case "tool": return { state: "working", verb: "Working" };
    case "writing": return { state: "composing", verb: "Writing" };
    case "connecting": return { state: "connecting", verb: "Connecting" };
    case "idle": return { state: "weaving", verb: verbFor(startedAt) };
  }
}

/**
 * The line under a running turn, in Claude Code's style: a thinking orb that
 * follows the agent's activity, a verb, how long it has run, the tokens it has
 * produced so far, and how to stop.
 */
export function WaitingLine({ startedAt, outputTokens, now: fixedNow, activity = "idle" }: { startedAt: number; outputTokens: number | null; now?: number; activity?: Activity }) {
  const [now, setNow] = useState(() => fixedNow ?? Date.now());
  const [reducedMotion] = useState(() => (typeof window === "undefined" ? false : Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)));
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [fixedNow]);

  const { state, verb } = orbFor(activity, startedAt);
  const facts = [elapsed(now - startedAt), ...(outputTokens ? [`↓ ${tokens(outputTokens)} tokens`] : []), "esc to interrupt"];
  return (
    <div className="waiting-line" role="status" aria-live="polite">
      <ThinkingOrb state={state} size={20} className="waiting-orb" aria-hidden paused={reducedMotion} />
      <span className="waiting-verb">{verb}…</span>
      <span className="waiting-facts">({facts.join(" · ")})</span>
    </div>
  );
}
