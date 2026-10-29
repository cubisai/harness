import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ThreadEvent } from "../../shared/types";
import { EventRow } from "./components/ThreadView";

type ResultEvent = Extract<ThreadEvent, { kind: "tool-result" }>;

/**
 * `--smoke` only: render stored events as the thread would, into a detached
 * element, and hand back the markup, so the packaged build's rows can be
 * compared across adapters.
 */
export function renderEventsForSmoke(events: ThreadEvent[]): string {
  const results = new Map<string, ResultEvent>();
  for (const e of events) if (e.kind === "tool-result") results.set(e.toolUseId, e);
  const host = document.createElement("div");
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <>
        {events.map((event, i) => (
          <EventRow key={i} stored={{ seq: i + 1, event, createdAt: 0 }} results={results} running={false} />
        ))}
      </>,
    ),
  );
  const html = host.innerHTML;
  root.unmount();
  return html;
}
