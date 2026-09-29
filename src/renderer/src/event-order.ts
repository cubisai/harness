/**
 * How stored events are laid out in the thread view.
 *
 * The store keeps events in arrival order, so a notice the service writes right
 * after a user message ("Now talking to X…", a model-switch or memory-scope
 * notice, before the turn starts) lands *below* that message. Visually it belongs
 * above the bubble it explains, so move each contiguous run of notices that
 * directly follows a user event to just before that event.
 *
 * Pure and order-preserving otherwise: only those notice runs move.
 */
export function displayOrder<T extends { event: { kind: string } }>(events: T[]): T[] {
  const out: T[] = [];
  let i = 0;
  while (i < events.length) {
    const current = events[i]!;
    if (current.event.kind === "user") {
      // The contiguous run of notices directly after this user event (a
      // non-notice event ends the run) is written *for* it: show it above.
      let end = i + 1;
      while (end < events.length && events[end]!.event.kind === "notice") end++;
      for (let n = i + 1; n < end; n++) out.push(events[n]!);
      out.push(current);
      i = end;
      continue;
    }
    out.push(current);
    i++;
  }
  return out;
}
