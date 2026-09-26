import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReasoningBlock } from "../src/renderer/src/components/ReasoningBlock";
import { EventRow } from "../src/renderer/src/components/ThreadView";

describe("thread rows", () => {
  it("renders a compaction divider with formatted token counts", () => {
    const html = renderToStaticMarkup(
      <EventRow stored={{ seq: 1, createdAt: 0, event: { kind: "compaction", trigger: "auto", preTokens: 12400, postTokens: 4100 } }} results={new Map()} running={false} />,
    );
    expect(html).toContain("Context compacted");
    expect(html).toContain("12k");
  });

  it("renders every plan step", () => {
    const entries = [
      { content: "Read code", status: "completed" as const },
      { content: "Fix bug", status: "in_progress" as const },
      { content: "Test", status: "pending" as const },
    ];
    const html = renderToStaticMarkup(<EventRow stored={{ seq: 1, createdAt: 0, event: { kind: "plan", entries } }} results={new Map()} running={false} />);
    expect(html).toContain("Read code");
    expect(html).toContain("Fix bug");
    expect(html).toContain("Test");
  });

  it("labels a stored opaque block as encrypted, with no live text", () => {
    const html = renderToStaticMarkup(<ReasoningBlock text="" opaque live={false} newest={false} tokens={null} />);
    expect(html).toContain("Reasoning (encrypted)");
    expect(html).not.toContain("Thinking…");
  });

  it("streams plain reasoning text", () => {
    const html = renderToStaticMarkup(<ReasoningBlock text="abc" opaque={false} live newest tokens={null} />);
    expect(html).toContain("abc");
    expect(html).toContain("Thinking…");
  });

  it("shows a token count for live opaque reasoning", () => {
    const html = renderToStaticMarkup(<ReasoningBlock text="" opaque live newest tokens={1500} />);
    expect(html).toContain("1.5k tokens");
  });
});
