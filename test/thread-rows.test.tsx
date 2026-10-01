import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReasoningBlock } from "../src/renderer/src/components/ReasoningBlock";
import { EventRow, ThreadView } from "../src/renderer/src/components/ThreadView";
import { useStore } from "../src/renderer/src/store";
import type { StoredEvent } from "../src/shared/types";

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

  it("labels a user message's skill with a leading $", () => {
    const html = renderToStaticMarkup(<EventRow stored={{ seq: 1, createdAt: 0, event: { kind: "user", text: "go", skill: "implement" } }} results={new Map()} running={false} />);
    expect(html).toContain(">$implement</span>");
  });
});

describe("ReasoningBlock stays open", () => {
  it("is open for text reasoning, live or finished, and closed for encrypted reasoning", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { ReasoningBlock } = await import("../src/renderer/src/components/ReasoningBlock");
    const html = (props: { text: string; opaque: boolean; live: boolean }) =>
      renderToStaticMarkup(createElement(ReasoningBlock, { ...props, newest: false, tokens: null }));
    expect(html({ text: "step one", opaque: false, live: false })).toMatch(/<details[^>]*open/);
    expect(html({ text: "step one", opaque: false, live: true })).toMatch(/<details[^>]*open/);
    expect(html({ text: "", opaque: true, live: false })).not.toMatch(/<details[^>]*open/);
  });
});

describe("subagent steps", () => {
  const agent: StoredEvent = { seq: 1, createdAt: 0, event: { kind: "tool-use", toolUseId: "tu-agent", name: "Agent", summary: "Find the bug · Explore", payload: { prompt: "go", subagent_type: "Explore" } } };
  const childTool: StoredEvent = { seq: 2, createdAt: 0, event: { kind: "tool-use", toolUseId: "tu-child", name: "Read", summary: "calc.py", parentId: "tu-agent" } };
  const childText: StoredEvent = { seq: 3, createdAt: 0, event: { kind: "assistant-text", text: "Found the bug", parentId: "tu-agent" } };

  it("keeps a subagent's steps off the top level and nests them under its Agent row", () => {
    // Server rendering reads zustand's initial-state snapshot; seed that object
    // so the components see the thread.
    const state = useStore.getInitialState();
    const savedEvents = state.events;
    const savedDisclosures = state.disclosures;
    try {
      state.events = { t1: [agent, childTool, childText] };
      // A finished run of tool calls folds into "Worked for …"; nothing of it shows until opened.
      state.disclosures = {};
      const folded = renderToStaticMarkup(<ThreadView threadId="t1" />);
      expect(folded).toMatch(/>Worked( for [^<]+)?</);
      expect(folded).toContain("1 other step");
      expect(folded).not.toContain("Found the bug");
      state.disclosures = { t1: { [`work-${agent.seq}`]: true } };
      const closed = renderToStaticMarkup(<ThreadView threadId="t1" />);
      expect(closed).toContain("Agent");
      // The child's own text row is not at the top level; the collapsed Agent
      // row summarises the latest step instead.
      expect(closed).not.toContain("Found the bug");
      expect(closed).toContain("1 step · Read calc.py");

      state.disclosures = { t1: { [`work-${agent.seq}`]: true, "tu-agent": true } };
      const open = renderToStaticMarkup(<ThreadView threadId="t1" />);
      expect(open).toContain("Steps");
      expect(open).toContain("Found the bug");
      expect(open).toContain("calc.py");
    } finally {
      state.events = savedEvents;
      state.disclosures = savedDisclosures;
    }
  });
});
