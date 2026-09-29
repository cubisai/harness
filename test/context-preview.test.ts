import { describe, expect, it } from "vitest";
import { buildContextPreview } from "../src/main/context-preview";
import type { HarnessTool } from "../src/main/agents/types";
import type { McpServerEntry } from "../src/shared/types";

function tool(name: string, description: string, input: HarnessTool["input"] = {}): HarnessTool {
  return { name, description, input, autoAllow: false, run: async () => ({ text: "" }) };
}

function server(name: string, enabled: boolean): McpServerEntry {
  return { name, enabled, spec: { type: "stdio", command: "npx" } };
}

describe("buildContextPreview", () => {
  it("estimates guide tokens at ~4 characters per token", () => {
    const preview = buildContextPreview({
      guideParts: [{ source: "bundled", path: "/app/HARNESS.md", text: "x".repeat(40) }],
      tools: [],
      mcpServers: [],
    });
    expect(preview.guide).toEqual([{ source: "bundled", path: "/app/HARNESS.md", tokens: 10 }]);
    // No memory index in the harness yet.
    expect(preview.memoryIndex).toBeNull();
  });

  it("sorts harness tools by token count descending", () => {
    const preview = buildContextPreview({
      guideParts: [],
      tools: [tool("small", "s"), tool("big", "x".repeat(4000))],
      mcpServers: [],
    });
    expect(preview.tools.map((t) => t.name)).toEqual(["big", "small"]);
    expect(preview.tools[0]!.tokens).toBeGreaterThan(preview.tools[1]!.tokens);
  });

  it("keeps only the enabled MCP servers", () => {
    const preview = buildContextPreview({
      guideParts: [],
      tools: [],
      mcpServers: [server("on", true), server("off", false)],
    });
    expect(preview.mcpServers).toEqual(["on"]);
  });

  it("carries the memory index through, null when absent", () => {
    const preview = buildContextPreview({ guideParts: [], tools: [], mcpServers: [], memoryIndex: { lines: 3, tokens: 12 } });
    expect(preview.memoryIndex).toEqual({ lines: 3, tokens: 12 });
    expect(buildContextPreview({ guideParts: [], tools: [], mcpServers: [] }).memoryIndex).toBeNull();
  });
});
