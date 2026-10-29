import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { handBack, relative, SubagentCard } from "../src/renderer/src/components/SubagentCard";
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

  it("peeks at a running subagent's last steps and newest note, Claude Code style", () => {
    const html = render({ running: true });
    expect(html).toContain("1 tool use");
    expect(html).toContain('class="subagent-peek"');
    expect(html).toContain('<span class="name">Read</span><span class="summary">src/a.ts</span>');
    // Its newest note came after the last tool call: it shows as the "now" line.
    expect(html).toContain('<div class="peek-now">found 3</div>');
    // Prompt and report stay out of the one-line view.
    expect(html).not.toContain("Prompt");
  });

  it("folds older steps into +N more while running", () => {
    const many: StoredEvent[] = Array.from({ length: 5 }, (_, i) => ({ seq: 10 + i, createdAt: 0, event: { kind: "tool-use", toolUseId: `g${i}`, name: "Grep", summary: `p${i}`, parentId: "a1" } }));
    const html = renderToStaticMarkup(<SubagentCard tool={agent} children={many} running open={false} onToggle={() => {}} />);
    expect(html).toContain("+2 more tool uses");
    expect(html).not.toContain(">p1<");
    expect(html).toContain(">p4<");
  });

  it("reads Done · N tool uses · time once finished, with no peek", () => {
    const timed = children.map((c, i) => ({ ...c, createdAt: 1_000 + i * 4_000 }));
    const html = renderToStaticMarkup(
      <SubagentCard tool={agent} result={{ kind: "tool-result", toolUseId: "a1", isError: false, summary: "x", payload: "found 3 callers" }} children={timed} running={false} open={false} startedAt={1_000} onToggle={() => {}} />,
    );
    expect(html).toContain("Done · 1 tool use · 12s");
    expect(html).not.toContain("subagent-peek");
  });

  it("names files relative to the thread folder in the peek, on macOS and Windows paths", () => {
    expect(relative("ls -la /work/app/src and /work/app/README.md", "/work/app")).toBe("ls -la src and README.md");
    expect(relative("C:\\work\\app\\src\\a.ts", "C:\\work\\app")).toBe("src\\a.ts");
    expect(relative("C:\\work\\app\\src\\a.ts", "C:/work/app")).toBe("src\\a.ts");
    expect(relative("/elsewhere/a.ts", "/work/app")).toBe("/elsewhere/a.ts");
  });

  it("shows only the report from Claude Code's hand-back wrapper", () => {
    const wrapped = "[Subagent hand-back] The text below is the final report. The report follows:\n  line one\n    indented";
    expect(handBack(wrapped)).toBe("line one\n  indented");
    expect(handBack("plain report")).toBe("plain report");
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

  it("shows a team member's row as the member: portrait, name and profession", () => {
    const team = { id: "rt", kind: "team", name: "Research", profession: "Lead", members: [{ id: "deep-researcher", name: "Dana Reed", profession: "Deep Researcher" }] } as never;
    {
      const tool: ToolUse = { ...agent, summary: "CSV history facts · deep-researcher", payload: { prompt: "p", subagent_type: "deep-researcher" } };
      const html = renderToStaticMarkup(<SubagentCard tool={tool} running={false} open={false} team={team} onToggle={() => {}} />);
      expect(html).toContain('class="subagent-avatar');
      expect(html).toContain('<span class="name">Dana Reed</span>');
      expect(html).toContain("CSV history facts · ");
      expect(html).toContain('<span class="subagent-type">Deep Researcher</span>');
      // A row whose type isn't a member stays a plain Agent row.
      const other = renderToStaticMarkup(<SubagentCard tool={agent} running={false} open={false} team={team} onToggle={() => {}} />);
      expect(other).toContain('<span class="name">Agent</span>');
    }
  });
});

describe("SubagentCard without a prompt", () => {
  it("leaves out the Prompt fold when the engine sent no prompt (Codex subAgentActivity)", () => {
    const tool: ToolUse = { kind: "tool-use", toolUseId: "c1", name: "Agent", summary: "history_a", payload: { prompt: "", subagent_type: "history_a" } };
    const html = renderToStaticMarkup(<SubagentCard tool={tool} running={false} open onToggle={() => {}} />);
    expect(html).not.toContain("<summary>Prompt</summary>");
  });
});
