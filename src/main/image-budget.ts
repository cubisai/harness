/**
 * A tool's `takeImage` (design, browser and document tools share one per thread): `limitOf` gives a thread's per-session image limit (its agent's
 * `sessionImageLimit`, null for none). A new session starts again at zero; the first turn's count carries into the
 * session it creates.
 */
export function imageBudget(limitOf: (threadId: string) => { limit: number | null; sessionId: string | null } | null): (threadId: string) => boolean {
  const sent = new Map<string, { session: string | null; count: number }>();
  return (threadId) => {
    const t = limitOf(threadId);
    if (!t || t.limit === null) return true;
    const seen = sent.get(threadId);
    const count = seen && (seen.session === t.sessionId || seen.session === null) ? seen.count : 0;
    if (count >= t.limit) {
      sent.set(threadId, { session: t.sessionId, count });
      return false;
    }
    sent.set(threadId, { session: t.sessionId, count: count + 1 });
    return true;
  };
}

/** What a screenshot tool says instead of the image once the conversation holds as many as its model takes. */
export const imageBudgetNote = (instead: string): string =>
  ` No image this time: this conversation already carries as many images as its model takes in one request. ${instead} instead, and say in your reply what you couldn't look at.`;
