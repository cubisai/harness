import type { PermissionMode } from "../shared/types";
import { SDK_MODE } from "./agents/claude";
import { codexPolicy } from "./agents/codex";
import { pickPermission, type ToolKind } from "./agents/acp/driver";

/** Every ACP tool kind, so the permission table can list which ones run without asking. */
const ACP_KINDS: ToolKind[] = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"];

const MODES: PermissionMode[] = ["ask", "auto-edit", "plan", "full"];

/**
 * A pattern as it is compared: trimmed, with typographic quotes straightened
 * and any run of whitespace outside quoted spans collapsed to one space.
 */
export function canonicalPattern(pattern: string): string {
  const straight = pattern
    .trim()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
  // Odd indices of the split are the quoted spans; their whitespace is kept.
  return straight
    .split(/('[^']*'|"[^"]*")/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\s+/g, " ")))
    .join("");
}

function key(agentId: string, toolName: string, pattern: string): string {
  return JSON.stringify([agentId, toolName, canonicalPattern(pattern)]);
}

/**
 * The user's in-memory "always allow" answers. An allow-always never crosses
 * agents, because each agent's own "always" differs: Claude writes a settings
 * rule; Codex acceptForSession lasts one session; ACP allow_always lives in
 * the agent process; OpenCode's always is per session with tool-proposed
 * patterns.
 */
export class Approvals {
  private readonly allowed = new Map<string, "allow-always">();

  remember(agentId: string, toolName: string, pattern: string): void {
    this.allowed.set(key(agentId, toolName, pattern), "allow-always");
  }

  get(agentId: string, toolName: string, pattern: string): "allow-always" | undefined {
    return this.allowed.get(key(agentId, toolName, pattern));
  }
}

/** What each permission mode means for every driver, side by side. */
export function permissionTable(): Record<PermissionMode, { claude: string; codex: { approvalPolicy: string; sandbox: string }; acp: ToolKind[] }> {
  const table = {} as Record<PermissionMode, { claude: string; codex: { approvalPolicy: string; sandbox: string }; acp: ToolKind[] }>;
  for (const mode of MODES) {
    table[mode] = {
      claude: mode === "plan" ? "Read-only; edits wait for your plan approval" : SDK_MODE[mode]!,
      codex: codexPolicy(mode),
      acp: ACP_KINDS.filter((kind) => pickPermission(mode, kind) === "allow").sort(),
    };
  }
  return table;
}
