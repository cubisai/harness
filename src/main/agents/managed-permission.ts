import type { PluginRuleTarget } from "../../shared/plugin-parts";
import type { TurnInput } from "./types";
import type { McpServerEntry } from "../../shared/types";

type Input = Pick<TurnInput, "threadId" | "projectId" | "signal" | "tools" | "mcpServers" | "managedPermission">;

export function isMainMediatedServer(entry: McpServerEntry): boolean {
  if (entry.mainMediated !== true || entry.spec.type !== "http") return false;
  try {
    const url = new URL(entry.spec.url);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && /^\/mcp-up\/(?:managed|plugin)\/[a-f0-9]{48}$/.test(url.pathname);
  } catch { return false; }
}

/** Exact wire identities only. Never interpret a description/title substring,
 * native Bash/Run, or a model-provided "approved" field as a managed call. */
export function managedTarget(input: Pick<Input, "mcpServers">, server: string | undefined, name: string): PluginRuleTarget {
  if (!server || server === "cubiq" || (server === "unskilled" && !input.mcpServers.some((s) => s.name === server))) return { kind: "tool", name };
  return { kind: "connector", server, tool: name };
}

export function wireManagedTarget(input: Pick<Input, "mcpServers">, name: string): PluginRuleTarget | null {
  const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z_][A-Za-z0-9_.-]*)$/.exec(name);
  return match ? managedTarget(input, match[1]!, match[2]!) : null;
}

export function deferManagedPermission(input: Input, target: PluginRuleTarget, args?: Record<string, unknown>, requirement?: "ask"): boolean {
  if (input.signal.aborted) return false;
  if (input.managedPermission?.(target, args, requirement)) return true;
  // Standalone driver fixtures still use the actual main-created descriptors.
  // Raw external stdio/HTTP entries are not proof of a host execution gate.
  if (target.kind === "connector") return !input.managedPermission && !requirement && input.mcpServers.some((s) => s.name === target.server && s.enabled && isMainMediatedServer(s));
  const tool = input.tools.find((t) => t.name === target.name);
  if (!tool?.pluginRulesHandled) return false;
  return (!requirement && tool.autoAllow) || (tool.deferPermission?.(args, { threadId: input.threadId, projectId: input.projectId, signal: input.signal, ...(requirement ? { requireApproval: true } : {}) })
    // An actual PluginTools descriptor always asks inside its owner/queue gate.
    // Explicit native Ask still requires the production routing authority.
    ?? (!requirement && tool.name.startsWith("plugin_") && tool.pluginRulesHandled === true));
}
