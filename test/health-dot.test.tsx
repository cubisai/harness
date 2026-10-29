import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HealthDot } from "../src/renderer/src/components/ThreadView";
import { segmentEvents } from "../src/renderer/src/turns";

describe("HealthDot", () => {
  it("shows the health as a class and lists why in its label", () => {
    const html = renderToStaticMarkup(
      <HealthDot score={{ threadId: "t", userSeq: 1, health: "fail", signals: [{ kind: "correction", level: "fail", detail: 'You corrected it: "no"' }] }} />,
    );
    expect(html).toContain('class="health-dot fail"');
    expect(html).toContain("Something went wrong. You corrected it: &quot;no&quot;");
  });

  it("is keyed by the user message that started the turn", () => {
    const at = (seq: number, event: object) => ({ seq, createdAt: seq, provenance: null, event }) as never;
    const segs = segmentEvents([at(4, { kind: "user", text: "go" }), at(5, { kind: "turn-end", costUsd: null, inputTokens: 1, outputTokens: 1, durationMs: 1 })], false);
    expect(segs.at(-1)).toMatchObject({ kind: "turn-end", userSeq: 4 });
  });
});
