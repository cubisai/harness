import type { AgentCapabilities, SkillOrigin, SkillsDelivery } from "../../shared/types";
import { PLUGIN_NAME } from "../skills/plugin";

/**
 * The declared-safe capability set for an agent we know nothing about:
 * ask-mode permissions, a warn-only guard, and no harness MCP tools. Half-
 * wiring an unknown agent is worse than degrading it, so every boolean is
 * off until the driver or the protocol says otherwise.
 */
export const SAFE_DEFAULTS: AgentCapabilities = Object.freeze({
  mcpStdio: false,
  mcpHttp: false,
  preToolGuard: false,
  resume: false,
  fork: false,
  revert: false,
  compaction: false,
  perMessageModel: false,
  vision: false,
  webSearch: false,
  planMode: false,
  interrupt: false,
  liveReasoning: false,
  seeding: "first-message" as const,
  seedNoReply: false,
  skillsDelivery: Object.freeze({ mode: "none" as const }),
  permissionGranularity: "modeOnly" as const,
  guardEnforcement: Object.freeze({ ask: "warnOnly" as const, "auto-edit": "warnOnly" as const, full: "warnOnly" as const }),
  sandbox: "none" as const,
});

/** A copy of `base` with `patch` applied; nested objects are copied, never shared. */
export function withCapabilities(base: AgentCapabilities, patch: Partial<AgentCapabilities>): AgentCapabilities {
  return {
    ...base,
    ...patch,
    skillsDelivery: patch.skillsDelivery ? { ...patch.skillsDelivery } : { ...base.skillsDelivery },
    guardEnforcement: patch.guardEnforcement ? { ...patch.guardEnforcement } : { ...base.guardEnforcement },
  };
}

/** Why a skills delivery mode can't reach an agent automatically, or null when it can. */
export function skillDeliveryGap(d: SkillsDelivery): string | null {
  if (d.mode === "none") return "This agent has no way to load the app's model-invoked skills.";
  return null;
}

/**
 * The ACP driver's capabilities before `initialize` runs: preset metadata,
 * plus an envDir delivery when the agent reads skills from a directory
 * variable. The initialize result then overrides the protocol bits.
 */
export function acpCapabilities(config: { skillsDirEnv?: string; capabilities?: Partial<AgentCapabilities> }): AgentCapabilities {
  return withCapabilities(SAFE_DEFAULTS, {
    ...(config.skillsDirEnv ? { skillsDelivery: { mode: "envDir" as const, prefix: "", reads: ["project", "shared"] } } : {}),
    ...config.capabilities,
  });
}

/**
 * Claude through the Agent SDK. Claude Code's loop and tools; its PreToolUse
 * hook runs even under bypassPermissions, so the git guardrail blocks in
 * every mode. perMessageModel: { resume, model } (spike S1).
 */
export const CLAUDE_CAPABILITIES: AgentCapabilities = Object.freeze({
  mcpStdio: true,
  mcpHttp: true,
  preToolGuard: true,
  resume: true,
  fork: true,
  revert: false,
  compaction: true,
  perMessageModel: true,
  vision: true,
  webSearch: true,
  planMode: true,
  interrupt: true,
  liveReasoning: true,
  seeding: "first-message" as const,
  seedNoReply: false,
  skillsDelivery: Object.freeze({ mode: "plugin" as const, prefix: `${PLUGIN_NAME}:`, reads: [] }),
  permissionGranularity: "perCommand" as const,
  guardEnforcement: Object.freeze({ ask: "block" as const, "auto-edit": "block" as const, full: "block" as const }),
  sandbox: "none" as const,
});

/**
 * Codex through `codex app-server`. No plan mode or session fork; its
 * workspace-write sandbox is on except in Full mode, where the guard can
 * only warn (approvalPolicy "never" bypasses it). perMessageModel:
 * turn/start model switches in place (spike S4).
 */
export const CODEX_CAPABILITIES: AgentCapabilities = Object.freeze({
  mcpStdio: true,
  mcpHttp: true,
  preToolGuard: true,
  resume: true,
  fork: false,
  revert: false,
  compaction: true,
  perMessageModel: true,
  vision: true,
  webSearch: true,
  planMode: false,
  interrupt: true,
  liveReasoning: true,
  seeding: "inject-items" as const,
  seedNoReply: false,
  skillsDelivery: Object.freeze({ mode: "extraRoots" as const, prefix: "", reads: ["project", "shared"] as SkillOrigin[] }),
  permissionGranularity: "perCommand" as const,
  guardEnforcement: Object.freeze({ ask: "block" as const, "auto-edit": "block" as const, full: "warnOnly" as const }),
  sandbox: "workspace" as const,
});
