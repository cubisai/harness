import { describe, expect, it } from "vitest";
import { lastAgentLine, previewLine } from "../src/renderer/src/prompt-bar";
import { ESCAPE_OWNERS } from "../src/renderer/src/escape";
import { emptyLive } from "../src/renderer/src/live";
import type { StoredEvent, ThreadEvent } from "../src/shared/types";

const ev = (seq: number, event: ThreadEvent): StoredEvent => ({ seq, event, createdAt: seq });

describe("design prompt bar preview", () => {
  it("shows the last non-empty line without Markdown marks", () => {
    expect(previewLine("Built the page.\n\n## **Next**: try `More styles`\n")).toBe("Next: try More styles");
    expect(previewLine("- See [the board](board.html) for every page")).toBe("See the board for every page");
    expect(previewLine("   \n")).toBe("");
  });

  it("caps a long line", () => {
    const line = previewLine("x".repeat(500));
    expect(line.length).toBe(160);
    expect(line.endsWith("…")).toBe(true);
  });

  it("prefers the streaming text, then the last top-level reply", () => {
    const events = [ev(1, { kind: "assistant-text", text: "First reply" }), ev(2, { kind: "assistant-text", text: "A subagent's note", parentId: "a1" }), ev(3, { kind: "user", text: "hi" })];
    expect(lastAgentLine(events, undefined)).toBe("First reply");
    const live = { ...emptyLive(), items: [{ key: "text:i1", channel: "text" as const, text: "Writing the", pending: " hero", opaque: false }] };
    expect(lastAgentLine(events, live)).toBe("Writing the hero");
    expect(lastAgentLine([], emptyLive())).toBe("");
  });

  it("lets an open transcript drawer own Escape, but not a closed one", () => {
    expect(ESCAPE_OWNERS.split(",").map((s) => s.trim())).toContain(".design-drawer:not([hidden])");
  });
});
