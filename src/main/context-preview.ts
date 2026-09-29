import type { ContextPreview, McpServerEntry } from "../shared/types";
import type { HarnessTool } from "./agents/types";

/**
 * The harness-side context a thread starts with: the guide files, the harness
 * tools' schemas, and the user's enabled MCP servers. Tokens are estimated at
 * ~4 characters per token, like the first-turn breakdown the drivers report.
 */
export function buildContextPreview(input: {
  guideParts: { source: "bundled" | "user" | "project"; path: string; text: string }[];
  tools: HarnessTool[];
  mcpServers: McpServerEntry[];
}): ContextPreview {
  const tools = input.tools
    .map((t) => {
      let serialized: string;
      try {
        serialized = JSON.stringify({ name: t.name, description: t.description, schema: t.input });
      } catch {
        // A schema that won't stringify is rare; the names and descriptions still explain the cost.
        serialized = JSON.stringify({ name: t.name, description: t.description });
      }
      return { name: t.name, tokens: Math.ceil(serialized.length / 4) };
    })
    .sort((a, b) => b.tokens - a.tokens);
  return {
    guide: input.guideParts.map((p) => ({ source: p.source, path: p.path, tokens: Math.ceil(p.text.length / 4) })),
    tools,
    mcpServers: input.mcpServers.filter((s) => s.enabled === true).map((s) => s.name),
    memoryIndex: null,
  };
}
