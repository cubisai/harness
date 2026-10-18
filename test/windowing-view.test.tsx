import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadView } from "../src/renderer/src/components/ThreadView";
import { useStore } from "../src/renderer/src/store";
import type { StoredEvent, ThreadEvent } from "../src/shared/types";

/** Server rendering reads zustand's initial snapshot; seed it and restore it after. */
function withEvents(events: StoredEvent[], fn: (html: string) => void): void {
  const state = useStore.getInitialState();
  const saved = state.events;
  state.events = { t: events };
  try {
    fn(renderToStaticMarkup(<ThreadView threadId="t" />));
  } finally {
    state.events = saved;
  }
}

const user = (seq: number): StoredEvent => ({ seq, createdAt: 0, event: { kind: "user", text: `m${seq}` } });

/** N user messages plus one closing turn: N + 2 segments. */
function longThread(n: number): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (let i = 0; i < n; i++) events.push(user(i + 1));
  const answer: ThreadEvent = { kind: "assistant-text", text: "answer" };
  const end: ThreadEvent = { kind: "turn-end", costUsd: null, inputTokens: 1, outputTokens: 1, durationMs: 1 };
  events.push({ seq: n + 1, createdAt: 0, event: answer });
  events.push({ seq: n + 2, createdAt: 0, event: end });
  return events;
}

describe("ThreadView windowing", () => {
  it("renders every segment, with no wrappers or spacers, below the threshold", () => {
    withEvents([user(1), user(2), user(3)], (html) => {
      expect(html).not.toContain("data-seg");
      expect(html).not.toContain('style="height:');
      expect(html.match(/class="msg-user"/g) ?? []).toHaveLength(3);
    });
  });

  it("mounts a window with spacers at/above the threshold, keeping the last turn", () => {
    withEvents(longThread(260), (html) => {
      const mounted = html.match(/data-seg=/g) ?? [];
      expect(mounted.length).toBeGreaterThan(0);
      expect(mounted.length).toBeLessThan(250);
      // The last turn's final segment (the turn-end, seq 262) is always mounted.
      expect(html).toContain('data-seg="e262"');
      expect(html).toContain('style="height:');
    });
  });
});
