import { describe, expect, it } from "vitest";
import { buildContextPreview } from "../src/main/context-preview";
import type { HarnessTool } from "../src/main/agents/types";

function tool(name: string, description: string, input: HarnessTool["input"] = {}): HarnessTool {
  return { name, description, input, autoAllow: false, run: async () => ({ text: "" }) };
}

type Listed = { ok: boolean; tools: { name: string; description: string; inputSchema: unknown }[]; error?: string };

function mcpRow(name: string, listed: Listed | null, deferred = false): { name: string; listed: Listed | null; deferred: boolean } {
  return { name, listed, deferred };
}

const listedTool = (name: string, description: string, inputSchema: unknown = { type: "object" }) => ({ name, description, inputSchema });

describe("buildContextPreview", () => {
  it("estimates guide tokens at ~4 characters per token", () => {
    const preview = buildContextPreview({
      guideParts: [{ source: "bundled", path: "/app/HARNESS.md", text: "x".repeat(40) }],
      tools: [],
      mcp: [],
    });
    expect(preview.guide).toEqual([{ source: "bundled", path: "/app/HARNESS.md", tokens: 10 }]);
    // No memory index in the harness yet.
    expect(preview.memoryIndex).toBeNull();
    // Outside a thread there is no skills listing.
    expect(preview.skills).toBeNull();
  });

  it("sorts harness tools by token count descending", () => {
    const preview = buildContextPreview({
      guideParts: [],
      tools: [tool("small", "s"), tool("big", "x".repeat(4000))],
      mcp: [],
    });
    expect(preview.tools.map((t) => t.name)).toEqual(["big", "small"]);
    expect(preview.tools[0]!.tokens).toBeGreaterThan(preview.tools[1]!.tokens);
  });

  describe("skills", () => {
    it("null outside a thread", () => {
      expect(buildContextPreview({ guideParts: [], tools: [], mcp: [], skills: null }).skills).toBeNull();
    });

    it('mode "none" delivers nothing, but keeps the count at zero', () => {
      const preview = buildContextPreview({ guideParts: [], tools: [], mcp: [], skills: { mode: "none", entries: [{ name: "a", description: "d" }] } });
      expect(preview.skills).toEqual({ mode: "none", count: 0, tokens: 0 });
    });

    it('mode "tool" prices the one skill tool plus the entries it does not list', () => {
      const t = tool("skill", "find one");
      const entries = [
        { name: "a", description: "d" },
        { name: "b", description: "e" },
      ];
      const preview = buildContextPreview({
        guideParts: [],
        tools: [t],
        mcp: [],
        // "a" is already in the tool's own list; "b" is the agent's own listing.
        skills: { mode: "tool", entries, tool: t, toolNames: ["a"] },
      });
      const own = Math.ceil("b: e".length / 4);
      expect(preview.skills).toEqual({ mode: "tool", count: 2, tokens: preview.tools[0]!.tokens + own });
    });

    it('mode "tool" without the tool still pays for the entries the agent lists itself', () => {
      const entries = [{ name: "a", description: "d" }];
      const preview = buildContextPreview({ guideParts: [], tools: [], mcp: [], skills: { mode: "tool", entries, toolNames: [] } });
      expect(preview.skills).toEqual({ mode: "tool", count: 1, tokens: Math.ceil("a: d".length / 4) });
    });

    it('modes the agent lists itself sum "name: description" over the entries', () => {
      const entries = [
        { name: "alpha", description: "does alpha" },
        { name: "beta", description: "does beta" },
      ];
      for (const mode of ["plugin", "extraRoots", "envDir"] as const) {
        const preview = buildContextPreview({ guideParts: [], tools: [], mcp: [], skills: { mode, entries } });
        const expected = entries.reduce((sum, e) => sum + Math.ceil(`${e.name}: ${e.description}`.length / 4), 0);
        expect(preview.skills).toEqual({ mode, count: 2, tokens: expected });
      }
    });
  });

  describe("MCP servers", () => {
    it("counts the tools and sums their schema cost", () => {
      const tools = [listedTool("a", "does a"), listedTool("b", "", {})];
      const preview = buildContextPreview({ guideParts: [], tools: [], mcp: [mcpRow("docs", { ok: true, tools })] });
      const tokens = tools.reduce((sum, t) => sum + Math.ceil(JSON.stringify(t).length / 4), 0);
      expect(preview.mcp).toEqual([{ name: "docs", tools: 2, tokens, deferred: false }]);
    });

    it("leaves count and tokens null until the server is listed", () => {
      const preview = buildContextPreview({ guideParts: [], tools: [], mcp: [mcpRow("docs", null, true)] });
      expect(preview.mcp).toEqual([{ name: "docs", tools: null, tokens: null, deferred: true }]);
    });

    it("carries the failure message, defaulting to failed", () => {
      const withError = buildContextPreview({ guideParts: [], tools: [], mcp: [mcpRow("a", { ok: false, tools: [], error: "No answer in 5 seconds." })] });
      expect(withError.mcp).toEqual([{ name: "a", tools: null, tokens: null, deferred: false, error: "No answer in 5 seconds." }]);
      const noError = buildContextPreview({ guideParts: [], tools: [], mcp: [mcpRow("b", { ok: false, tools: [] })] });
      expect(noError.mcp).toEqual([{ name: "b", tools: null, tokens: null, deferred: false, error: "failed" }]);
    });

    it("carries the deferred flag", () => {
      const preview = buildContextPreview({ guideParts: [], tools: [], mcp: [mcpRow("a", { ok: true, tools: [] }, true)] });
      expect(preview.mcp[0]!.deferred).toBe(true);
    });
  });

  it("carries the memory index through, null when absent", () => {
    const preview = buildContextPreview({ guideParts: [], tools: [], mcp: [], memoryIndex: { lines: 3, tokens: 12 } });
    expect(preview.memoryIndex).toEqual({ lines: 3, tokens: 12 });
    expect(buildContextPreview({ guideParts: [], tools: [], mcp: [] }).memoryIndex).toBeNull();
  });
});
