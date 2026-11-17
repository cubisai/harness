import { useStore } from "../store";

/**
 * Send a UI block's answer (a tapped choice, a submitted form) as the user's
 * next message in the block's own thread (`threadId`; absent = the open one):
 * right away when idle, else queued for the next turn, as the composer does.
 * Resolves true once the message was sent or queued, false when there is no
 * such thread or sending failed (the store shows why).
 */
export async function sendUiReply(text: string, threadId?: string): Promise<boolean> {
  const s = useStore.getState();
  const id = threadId ?? s.selectedThreadId;
  if (!id || !text.trim()) return false;
  // The block's thread may have been deleted while it was on screen (its transcript is gone then).
  if (threadId && !s.events[threadId]) return false;
  if (s.running[id]) {
    s.enqueue(id, text);
    return true;
  }
  return s.send(text, undefined, id);
}
