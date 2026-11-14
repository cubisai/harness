import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { canonicalTool, clipSummary } from "../src/shared/tools";
import { diffSummary, parseUnifiedDiff, unifiedDiff } from "../src/shared/diff";
import { handleMessage, newTurnState } from "../src/main/agents/claude";
import { resultPayloadFor, toolFor } from "../src/main/agents/codex";
import { harnessTool, kindLabel } from "../src/main/agents/acp/driver";
import type { TurnInput } from "../src/main/agents/types";
import type { ThreadEvent } from "../src/shared/types";

describe("canonicalTool", () => {
  it("maps every agent's tool names onto one concept each", () => {
    const table: [string, string][] = [
      ["Bash", "Run"],
      ["Write", "Edit"],
      ["MultiEdit", "Edit"],
      ["Grep", "Search"],
      ["mcp__cubiq__browser_click", "browser_click"],
      ["mcp__unskilled__browser_click", "browser_click"],
      ["mcp__docs__whoami", "docs · whoami"],
      ["Unknown", "Unknown"],
    ];
    for (const [name, want] of table) expect(canonicalTool(name)).toBe(want);
  });
});

describe("one concept through three adapters", () => {
  it("Claude, Codex, and ACP all read Run / npm test", () => {
    const events: ThreadEvent[] = [];
    const input = { onEvent: (e: ThreadEvent) => events.push(e) } as unknown as TurnInput;
    handleMessage(
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "m1", model: "claude-x", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
      } as unknown as SDKMessage,
      input,
      newTurnState(),
    );
    const claude = events.find((e) => e.kind === "tool-use");
    expect(claude).toMatchObject({ kind: "tool-use", name: "Run", summary: "npm test" });

    const codex = toolFor({ type: "commandExecution", id: "c1", command: "npm test", status: "completed" });
    expect(codex).toMatchObject({ name: "Run", summary: "npm test" });

    expect(kindLabel("execute")).toBe("Run");
    expect(clipSummary("npm test")).toBe("npm test");
  });
});

describe("one edit through two adapters", () => {
  it("a Codex fileChange and an ACP diff normalise to the same ToolDiff", () => {
    const path = "src/a.ts";
    const oldText = "const a = 1;\nconst b = 2;\n";
    const newText = "const a = 1;\nconst b = 3;\n";

    const codexDiff = [{ path, unified: unifiedDiff(path, oldText, newText) }];
    const acpDiff = [{ path, unified: unifiedDiff(path, oldText, newText) }];
    expect(acpDiff).toEqual(codexDiff);

    const parsed = parseUnifiedDiff(codexDiff[0]!.unified);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ path, additions: 1, deletions: 1 });
    expect(parsed[0]!.hunks[0]!.lines.map((l) => [l.kind, l.text])).toEqual([
      ["context", "const a = 1;"],
      ["del", "const b = 2;"],
      ["add", "const b = 3;"],
    ]);
    expect(parseUnifiedDiff(acpDiff[0]!.unified)).toEqual(parsed);
  });
});

describe("a Codex fileChange that adds or deletes a whole file", () => {
  const changeOf = (kind: string, diff: string) => resultPayloadFor({ type: "fileChange", id: "f", status: "completed", changes: [{ path: "docs/handoff.md", kind: { type: kind }, diff }] } as never) as { diff: { path: string; unified: string }[] };
  it("counts an added file's lines as additions, a markdown dash included", () => {
    const out = changeOf("add", "---\nname: x\n---\n# Handoff\n\n- one item\n");
    expect(diffSummary(out.diff)).toBe(diffSummary([{ path: "docs/handoff.md", unified: unifiedDiff("docs/handoff.md", "", "---\nname: x\n---\n# Handoff\n\n- one item\n") }]));
    expect(parseUnifiedDiff(out.diff[0]!.unified)[0]).toMatchObject({ additions: 6, deletions: 0 });
  });
  it("counts a deleted file's lines as deletions", () => {
    expect(parseUnifiedDiff(changeOf("delete", "a\nb\n").diff[0]!.unified)[0]).toMatchObject({ additions: 0, deletions: 2 });
  });
  it("counts an update that comes as bare hunks, with or without ---/+++ lines", () => {
    const hunks = "@@ -1,2 +1,2 @@\n a\n-b\n+c\n+d\n";
    expect(diffSummary(changeOf("update", hunks).diff)).toBe("+2 −1");
    expect(diffSummary(changeOf("update", `--- a/docs/handoff.md\n+++ b/docs/handoff.md\n${hunks}`).diff)).toBe("+2 −1");
    expect(parseUnifiedDiff(changeOf("update", hunks).diff[0]!.unified)[0]).toMatchObject({ path: "docs/handoff.md", additions: 2, deletions: 1 });
  });
  it("leaves an update's real diff alone", () => {
    const real = unifiedDiff("src/a.ts", "x\n", "y\n");
    expect(changeOf("update", real).diff[0]!.unified).toBe(real);
  });
});

describe("unifiedDiff round-trips through parseUnifiedDiff", () => {
  it("a new file parses as added", () => {
    const text = unifiedDiff("new.txt", "", "hello\nworld\n");
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "new.txt", status: "added", additions: 2, deletions: 0 });
  });

  it("a one-line change counts one addition and one deletion", () => {
    const text = unifiedDiff("a.ts", "one\ntwo\nthree\n", "one\ntwo!\nthree\n");
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "a.ts", status: "modified", additions: 1, deletions: 1 });
  });
});

describe("clipSummary", () => {
  it("cuts to 160 chars ending in … and collapses whitespace", () => {
    const long = "a".repeat(300);
    const clipped = clipSummary(long);
    expect(clipped.length).toBe(160);
    expect(clipped.endsWith("…")).toBe(true);

    expect(clipSummary("one\n  two\tthree")).toBe("one two three");
  });
});

describe("ACP rows for the harness's own tools", () => {
  it("names them like Claude's rows and summarises the main argument", () => {
    expect(harnessTool({ title: "cubiq_browser_open", kind: "other", rawInput: { url: "https://example.com" } })).toEqual({ name: "browser_open", summary: "https://example.com" });
    expect(harnessTool({ title: "mcp__cubiq__skill", rawInput: { name: "docx" } })).toEqual({ name: "skill", summary: "docx" });
    // Stored threads carry the old "unskilled" titles; they read the same.
    expect(harnessTool({ title: "unskilled_browser_open", kind: "other", rawInput: { url: "https://example.com" } })).toEqual({ name: "browser_open", summary: "https://example.com" });
    expect(harnessTool({ title: "unskilled_browser_logs", kind: null, rawInput: {} })).toEqual({ name: "browser_logs", summary: "" });
    expect(harnessTool({ title: "mcp__unskilled__skill", rawInput: { name: "docx" } })).toEqual({ name: "skill", summary: "docx" });
    expect(harnessTool({ title: "github_create_issue", kind: "other", rawInput: {} })).toBeNull();
    expect(harnessTool({ title: "cubiq_browser_open", kind: "execute", rawInput: {} })).toBeNull();
  });
});
