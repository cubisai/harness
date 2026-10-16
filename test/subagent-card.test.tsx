import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SubagentCard } from "../src/renderer/src/components/SubagentCard";
import { ToolRow } from "../src/renderer/src/components/ThreadView";
import { appendDelta, emptyLive, flushPending } from "../src/renderer/src/live";
import type { StoredEvent, ThreadEvent } from "../src/shared/types";

type ToolUse = Extract<ThreadEvent, { kind: "tool-use" }>;
type ToolResult = Extract<ThreadEvent, { kind: "tool-result" }>;

const agent: ToolUse = { kind: "tool-use", toolUseId: "a1", name: "Agent", summary: "Find callers", payload: { prompt: "find", subagent_type: "Explore" } };
const children: StoredEvent[] = [
  { seq: 2, createdAt: 0, event: { kind: "thinking", text: "checking imports", parentId: "a1" } },
  { seq: 3, createdAt: 0, event: { kind: "tool-use", toolUseId: "r1", name: "Read", summary: "src/a.ts", payload: { file_path: "src/a.ts" }, parentId: "a1" } },
  { seq: 4, createdAt: 0, event: { kind: "tool-result", toolUseId: "r1", isError: false, summary: "src/a.ts", payload: "export const a = 1;", parentId: "a1" } },
  { seq: 5, createdAt: 0, event: { kind: "assistant-text", text: "found 3", parentId: "a1" } },
];

/** Render the Agent row the way ThreadView does: result + the child steps that hang off it. */
function render(over: { result?: ToolResult; running?: boolean; open?: boolean }): string {
  const results = new Map<string, ToolResult>();
  for (const c of children) if (c.event.kind === "tool-result") results.set(c.event.toolUseId, c.event);
  return renderToStaticMarkup(
    <SubagentCard tool={agent} result={over.result} children={children} results={results} running={over.running ?? false} open={over.open ?? false} onToggle={() => {}} />,
  );
}

describe("SubagentCard", () => {
  it("shows the steps, prompt and output when open", () => {
    const html = render({ open: true, result: { kind: "tool-result", toolUseId: "a1", isError: false, summary: "3 callers", payload: "found 3 callers" } });
    expect(html).toContain("subagent-card");
    expect(html).toContain("Steps");
    expect(html).toContain("checking imports");
    expect(html).toContain("found 3");
    expect(html).toContain("Explore");
  });

  it("summarises a running subagent by its step count", () => {
    expect(render({ running: true })).toContain("1 step");
  });

  it("marks the newest drawn step while running, skipping tool results", () => {
    const html = render({ open: true, running: true });
    expect(html).toContain('<div class="tool-step newest"><div class="tool-step-text"><p>found 3</p>');
    expect(html.match(/newest/g)?.length).toBe(1);
  });

  it("streams the subagent's live text inside its card while it runs", () => {
    let live = appendDelta(emptyLive(), { kind: "text-delta", itemId: "x", text: "still writing", parentId: "a1" });
    live = flushPending(appendDelta(live, { kind: "text-delta", itemId: "y", text: "someone else", parentId: "other" }));
    // Reduced motion shows streaming text whole instead of revealing it frame by frame.
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    try {
      const html = renderToStaticMarkup(<SubagentCard tool={agent} children={children} running open threadId="t1" live={live} onToggle={() => {}} />);
      expect(html).toContain("still writing");
      expect(html).not.toContain("someone else");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the error dot for a failed subagent", () => {
    const html = render({ open: true, result: { kind: "tool-result", toolUseId: "a1", isError: true, summary: "boom", payload: "boom" } });
    expect(html).toContain('class="dot error"');
  });

  it("renders a non-Agent tool row as a plain row, not a subagent card", () => {
    const read: ToolUse = { kind: "tool-use", toolUseId: "r9", name: "Read", summary: "src/a.ts", payload: { file_path: "src/a.ts" } };
    const html = renderToStaticMarkup(<ToolRow tool={read} running={false} open onToggle={() => {}} />);
    expect(html).toContain("tool-row");
    expect(html).not.toContain("subagent-card");
  });
});
