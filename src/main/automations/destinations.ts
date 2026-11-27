// Where a finished run's result goes: the Message Center, one row per key.

import type { DeliveryPayload, Destination } from "./io";
import type { AutomationStore } from "./store";

/**
 * A confirmed receipt is the Message Center delivery. Window notifications
 * happen after commit; receipt lookup also works in a fresh process.
 */
export function messageCenterDestination(store: AutomationStore, notify: (p: DeliveryPayload) => void): Destination {
  return {
    id: "message-center",
    repeatable: true,
    afterCommit: notify,
    async publish(p) {
      if (store.delivery(p.key)?.state !== "confirmed") {
        store.atomic(() => {
          store.deliveryIntent(p.key, p.runId, "message-center");
          store.confirmDelivery(p.key, p.key);
        });
        notify(p);
      }
      return p.key;
    },
    async check(key) {
      return store.delivery(key)?.state === "confirmed" ? "confirmed" : "missing";
    },
  };
}
