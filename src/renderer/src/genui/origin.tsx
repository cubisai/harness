import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { StoredEvent } from "../../../shared/types";

/**
 * Where a reply's tap-to-reply blocks belong: their thread, and the user
 * message that followed the reply (null while none has). A block whose reply
 * was already answered stays used after it remounts (scrolling, switching
 * threads, a restart): the answer comes from the stored transcript, not from
 * component state.
 */
export interface UiOrigin {
  threadId: string;
  answer: string | null;
}

type Answers = { threadId: string; after: (seq: number) => string | null };

const AnswersContext = createContext<Answers | null>(null);
const OriginContext = createContext<UiOrigin | null>(null);

/** Gives the transcript's replies their thread and the user messages after them. */
export function UiAnswersProvider({ threadId, events, children }: { threadId: string; events: StoredEvent[]; children: ReactNode }) {
  const value = useMemo<Answers>(() => {
    const users: { seq: number; text: string }[] = [];
    for (const e of events) if (e.event.kind === "user") users.push({ seq: e.seq, text: e.event.text });
    users.sort((a, b) => a.seq - b.seq);
    return {
      threadId,
      after: (seq) => {
        // The first user message after `seq` (binary search: transcripts are long).
        let lo = 0;
        let hi = users.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (users[mid]!.seq > seq) hi = mid;
          else lo = mid + 1;
        }
        return users[lo]?.text ?? null;
      },
    };
  }, [threadId, events]);
  return <AnswersContext.Provider value={value}>{children}</AnswersContext.Provider>;
}

/** Marks the reply stored at `seq` as the origin of the blocks inside it. */
export function UiOriginProvider({ seq, children }: { seq: number; children: ReactNode }) {
  const answers = useContext(AnswersContext);
  const threadId = answers?.threadId ?? null;
  const answer = answers ? answers.after(seq) : null;
  const value = useMemo<UiOrigin | null>(() => (threadId ? { threadId, answer } : null), [threadId, answer]);
  return <OriginContext.Provider value={value}>{children}</OriginContext.Provider>;
}

/** The reply's origin, or null outside a transcript (previews, subagent cards). */
export const useUiOrigin = (): UiOrigin | null => useContext(OriginContext);
