import type { ContextPreview, SkillsDelivery } from "../shared/types";
import type { HarnessTool } from "./agents/types";

/** The same ~4-chars-per-token estimate the drivers report, for one tool's serialized schema. */
export function toolTokens(t: HarnessTool): number {
  let serialized: string;
  try {
    serialized = JSON.stringify({ name: t.name, description: t.description, schema: t.input });
  } catch {
    // A schema that won't stringify is rare; the names and descriptions still explain the cost.
    serialized = JSON.stringify({ name: t.name, description: t.description });
  }
  return Math.ceil(serialized.length / 4);
}

/** The skills listing input: the delivery mode, the agent's skills, and the tool "tool" mode adds. */
export interface SkillsInput {
  mode: SkillsDelivery["mode"];
  entries: { name: string; description: string }[];
  tool?: HarnessTool;
  /** Names the skill tool lists, so "tool" mode doesn't bill the agent for them a second time. */
  toolNames?: string[];
}

/** What the agent spends on its skills listing, or null outside a thread. */
export function skillsOf(skills: SkillsInput | null | undefined): ContextPreview["skills"] {
  if (!skills) return null;
  const { mode, entries, tool, toolNames } = skills;
  // "tool" delivers one skill tool that lists the harness/global skills itself,
  // but the agent reads the project's own skills natively and lists those too;
  // "none" delivers nothing.
  if (mode === "none") return { mode, count: 0, tokens: 0 };
  if (mode === "tool") {
    const listed = new Set(toolNames ?? []);
    const own = entries.reduce((sum, e) => (listed.has(e.name) ? sum : sum + Math.ceil(`${e.name}: ${e.description}`.length / 4)), 0);
    return { mode, count: entries.length, tokens: (tool ? toolTokens(tool) : 0) + own };
  }
  // The agent lists each skill as "name: description" in its own prompt.
  return { mode, count: entries.length, tokens: entries.reduce((sum, e) => sum + Math.ceil(`${e.name}: ${e.description}`.length / 4), 0) };
}

/** One MCP row: null until listed, the failure reason when listing failed, else count and schema cost. */
export function mcpRow(
  name: string,
  listed: { ok: boolean; tools: { name: string; description: string; inputSchema: unknown }[]; error?: string } | null,
  deferred: boolean,
): ContextPreview["mcp"][number] {
  if (!listed) return { name, tools: null, tokens: null, deferred };
  if (!listed.ok) return { name, tools: null, tokens: null, deferred, error: listed.error ?? "failed" };
  const tokens = listed.tools.reduce((sum, t) => sum + Math.ceil(JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length / 4), 0);
  return { name, tools: listed.tools.length, tokens, deferred };
}

/**
 * The harness-side context a thread starts with: the guide files, the harness
 * tools' schemas, the agent's skills listing, and the enabled MCP servers'
 * tool schemas. Tokens are estimated at ~4 characters per token, like the
 * first-turn breakdown the drivers report.
 */
export function buildContextPreview(input: {
  guideParts: { source: "bundled" | "user" | "project"; path: string; text: string }[];
  tools: HarnessTool[];
  mcp: { name: string; listed: { ok: boolean; tools: { name: string; description: string; inputSchema: unknown }[]; error?: string } | null; deferred: boolean }[];
  skills?: SkillsInput | null;
  memoryIndex?: { lines: number; tokens: number } | null;
}): ContextPreview {
  const tools = input.tools.map((t) => ({ name: t.name, tokens: toolTokens(t) })).sort((a, b) => b.tokens - a.tokens);
  return {
    guide: input.guideParts.map((p) => ({ source: p.source, path: p.path, tokens: Math.ceil(p.text.length / 4) })),
    tools,
    skills: skillsOf(input.skills),
    mcp: input.mcp.map((s) => mcpRow(s.name, s.listed, s.deferred)),
    memoryIndex: input.memoryIndex ?? null,
  };
}
