import { useStore } from "../store";

/**
 * Send a UI block's answer (a tapped choice, a submitted form) as the user's
 * next message in the open thread: right away when idle, else queued for the
 * next turn, as the composer does. Returns false when there is no thread.
 */
export function sendUiReply(text: string): boolean {
  const s = useStore.getState();
  const id = s.selectedThreadId;
  if (!id || !text.trim()) return false;
  if (s.running[id]) s.enqueue(id, text);
  else void s.send(text);
  return true;
}
