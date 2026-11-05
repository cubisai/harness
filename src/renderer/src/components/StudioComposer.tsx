import { useMemo, type Ref } from "react";
import { ChevronUp, Mic } from "lucide-react";
import { IconChat } from "../icons";
import { lastAgentLine } from "../prompt-bar";
import { useStore } from "../store";
import { dockedPlan, todoProgress } from "../todo";
import { useDismissedPlans } from "./TodoDock";

const EMPTY: never[] = [];
const MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
/** Dictation is the system's own: this says how to start it and puts the caret where it will type. */
export const DICTATION_HINT = MAC ? "Dictate: press Fn twice (macOS dictation)" : "Dictate: press Win+H (Windows voice typing)";

/** What the running line says: `Designing hero · 2/3 · Esc to stop`, with whichever parts are known. */
export function statusText(current: string | null, line: string, progress: { done: number; total: number } | null): string {
  const parts = [current?.trim() || line.trim() || "Working…"];
  if (progress && progress.total > 0) parts.push(`${progress.done}/${progress.total}`);
  parts.push("Esc to stop");
  return parts.join(" · ");
}

/** Why the last turn failed, if it did. A newer turn clears it. With the chat closed this is the only place it can show. */
export function lastTurnError(events: readonly { event: { kind: string; message?: unknown } }[] | undefined): string | null {
  const list = events ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]!.event;
    if (e.kind === "turn-start") return null;
    if (e.kind === "error" && typeof e.message === "string") return e.message;
  }
  return null;
}

/** The one line on the Composer's lip: the running turn, or why the last one failed. Otherwise nothing. */
export function ComposerLip({ threadId }: { threadId: string }) {
  const running = useStore((s) => Boolean(s.running[threadId]));
  const line = useStore((s) => lastAgentLine(s.events[threadId], s.live[threadId]));
  const events = useStore((s) => s.events[threadId]) ?? EMPTY;
  const dismissed = useDismissedPlans((s) => s.seqs[threadId]);
  const plan = useMemo(() => dockedPlan(events, dismissed), [events, dismissed]);
  if (!running) {
    const failed = lastTurnError(events);
    if (!failed) return null;
    return (
      <div className="composer-lip error" role="alert">
        <span className="composer-lip-text" title={failed}>
          {failed}
        </span>
      </div>
    );
  }
  const progress = plan ? todoProgress(plan.entries) : null;
  return (
    <div className="composer-lip" role="status">
      <span className="thread-dot running" aria-hidden />
      <span className="composer-lip-text">{statusText(progress?.current ?? null, line, progress)}</span>
    </div>
  );
}

/** How many replies the agent has given in this thread: the Chat chip's count. */
export function replyCount(events: readonly { event: { kind: string; parentId?: string | null } }[] | undefined): number {
  return (events ?? []).filter((e) => e.event.kind === "assistant-text" && !e.event.parentId).length;
}

/** The Composer's own way to the transcript, and dictation. */
export function StudioActions({ buttonRef, threadId, open, onToggle }: { buttonRef: Ref<HTMLButtonElement>; threadId: string; open: boolean; onToggle: () => void }) {
  const count = useStore((s) => replyCount(s.events[threadId]));
  return (
    <>
      <button
        className="icon-button"
        aria-label="Dictate"
        title={DICTATION_HINT}
        onClick={(e) => e.currentTarget.closest(".composer")?.querySelector("textarea")?.focus()}
      >
        <Mic size={16} strokeWidth={1.75} aria-hidden />
      </button>
      <button ref={buttonRef} className="chip-button studio-chat-chip" aria-expanded={open} aria-controls="design-drawer" title={open ? "Hide the chat (Esc)" : "Show the chat"} onClick={onToggle}>
        <IconChat />
        <span className="studio-chat-label">Chat{count > 0 ? ` (${count})` : ""}</span>
        <ChevronUp size={14} strokeWidth={2} className={`design-drawer-chev${open ? " open" : ""}`} aria-hidden />
      </button>
    </>
  );
}
