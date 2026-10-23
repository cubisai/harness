import type { StoredEvent } from "../../shared/types";
import { visibleItems, type LiveThread } from "./live";

/** The longest preview the prompt bar's handle shows; it ellipsizes in CSS well before this. */
const PREVIEW_MAX = 160;

/** One line of agent text for the prompt bar's handle: its last non-empty line, without Markdown marks. */
export function previewLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = (lines[lines.length - 1] ?? "")
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)+/, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return last.length > PREVIEW_MAX ? `${last.slice(0, PREVIEW_MAX - 1)}…` : last;
}

/**
 * What the design prompt bar previews while the transcript is closed: the agent's latest top-level text, the streaming
 * one while a turn writes, else the last stored reply. Subagents' text is left out (it isn't the agent talking to you).
 */
export function lastAgentLine(events: readonly StoredEvent[] | undefined, live: LiveThread | undefined): string {
  const streaming = live ? visibleItems(live, "text") : [];
  const tail = streaming[streaming.length - 1];
  if (tail) return previewLine(tail.text + tail.pending);
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events![i]!.event;
    if (e.kind === "assistant-text" && !e.parentId && e.text.trim()) return previewLine(e.text);
  }
  return "";
}
