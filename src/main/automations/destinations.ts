// Where a finished run's result goes: the Message Center, one row per key.

import type { DeliveryPayload, Destination } from "./io";

/**
 * Publish into the Message Center: `publish` broadcasts a row into the thread.
 * The key is remembered in-process so a retry within the same session is a
 * no-op; check() can only confirm what this session delivered, so an earlier
 * session's row reads "missing" — re-showing it is harmless, the row lives on.
 */
export function messageCenterDestination(publish: (p: DeliveryPayload) => void): Destination {
  const delivered = new Set<string>();
  return {
    id: "message-center",
    async publish(p) {
      if (!delivered.has(p.key)) {
        publish(p);
        delivered.add(p.key);
      }
      return p.key;
    },
    async check(key) {
      return delivered.has(key) ? "confirmed" : "missing";
    },
  };
}
