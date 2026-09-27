import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AcpAgentConfig } from "./acp/driver";

/** The drivers the app ships: agents.json can't replace them. */
export const BUILT_IN_AGENT_IDS = new Set(["claude", "codex"]);

/**
 * ACP agents the app knows how to start. A preset shows up only when its
 * command is installed; anything in agents.json always shows up.
 */
export const ACP_PRESETS: AcpAgentConfig[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    command: "dsh",
    args: ["--profile", "acp"],
    // deepseek-harness loads extra skills from this directory
    // (packages/skill/skill-filesystem: DSH_BUNDLED_SKILL_DIR).
    skillsDirEnv: "DSH_BUNDLED_SKILL_DIR",
    capabilities: { mcpStdio: true, interrupt: true, perMessageModel: true },
    keyVar: "DEEPSEEK_API_KEY",
    install: "npm install -g @deepseek-ai/dsh",
    homepage: "https://github.com/deepseek-ai/deepseek-harness",
  },
  {
    // Antigravity (agy) has no native ACP mode; agy-acp adapts it. The
    // adapter finds an installed agy binary (AGY_BIN overrides). Skills
    // come from .agents/skills like the other non-DeepSeek ACP agents.
    id: "antigravity",
    label: "Antigravity",
    command: "agy-acp",
    args: [],
    capabilities: { mcpStdio: true, interrupt: true, perMessageModel: false, skillsDelivery: { mode: "tool", prefix: "", reads: ["project", "shared"] } },
    // Its provider setting is unverified (spike S6).
    providerEnvOnly: true,
    // Third-party access breaches Antigravity's terms (ToS section 6): hidden until
    // Settings records an acknowledgement, and never offered a BYOK provider.
    optIn: true,
    unsupported: "Gemini-compatible endpoints only",
    install: "npm install -g agy-acp",
    homepage: "https://github.com/shindgew/agy-acp",
  },
  {
    // Reads skills from .opencode/skills, .claude/skills, and .agents/skills.
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    args: ["acp"],
    capabilities: { mcpStdio: true, interrupt: true, perMessageModel: true, permissionGranularity: "perTool", skillsDelivery: { mode: "tool", prefix: "", reads: ["project", "shared"] } },
    injector: "opencode",
    guardPlugin: "opencode",
    install: "npm install -g opencode-ai",
    homepage: "https://opencode.ai/docs/acp/",
  },
  {
    id: "cursor",
    label: "Cursor",
    command: "cursor-agent",
    args: ["acp"],
    capabilities: { mcpStdio: true, interrupt: true, perMessageModel: true, skillsDelivery: { mode: "tool", prefix: "", reads: ["project", "shared"] } },
    install: "curl https://cursor.com/install -fsS | bash",
    homepage: "https://cursor.com/cli",
  },
];

/** True when `command` resolves on PATH (with PATHEXT on Windows), or is an existing path. */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, command + ext), platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

function isConfig(v: unknown): v is AcpAgentConfig {
  const c = v as AcpAgentConfig;
  return Boolean(c && typeof c.id === "string" && typeof c.label === "string" && typeof c.command === "string" && Array.isArray(c.args));
}

/**
 * Installed presets, then the user's own agents from agents.json:
 *   { "agents": [{ "id": "qwen", "label": "Qwen Code", "command": "qwen", "args": ["--acp"] }] }
 * A user entry with a preset's id replaces the preset. An opt-in preset, and
 * any user entry replacing it, stays out until `optedIn`.
 */
export function loadAcpAgents(
  configFile: string,
  isInstalled: (cmd: string) => boolean = (c) => onPath(c),
  { optedIn = false }: { optedIn?: boolean } = {},
): {
  agents: AcpAgentConfig[];
  /** agents.json's valid entries, installed or not. */
  custom: AcpAgentConfig[];
  problems: string[];
} {
  const problems: string[] = [];
  let custom: AcpAgentConfig[] = [];
  if (existsSync(configFile)) {
    try {
      const raw = JSON.parse(readFileSync(configFile, "utf-8")) as { agents?: unknown[] };
      const parsed = (raw.agents ?? []).filter((a): a is AcpAgentConfig => {
        if (isConfig(a)) return true;
        problems.push(`agents.json: skipped an entry without id, label, command, and args`);
        return false;
      });
      // agents.json declares no capabilities: a user entry gets SAFE_DEFAULTS
      // (and only skillsDirEnv upgrades it to envDir), so it can never claim
      // support the driver hasn't verified. Injector/guard metadata is preset-only.
      custom = parsed.map(
        ({ capabilities: _ignored, injector: _injector, guardPlugin: _guardPlugin, keyVar: _keyVar, providerEnvOnly: _providerEnvOnly, optIn: _optIn, unsupported: _unsupported, ...rest }) =>
          rest,
      );
    } catch (err) {
      problems.push(`agents.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const customIds = new Set(custom.map((a) => a.id));
  const gated = new Set(optedIn ? [] : ACP_PRESETS.filter((p) => p.optIn).map((p) => p.id));
  const presets = ACP_PRESETS.filter((p) => !customIds.has(p.id) && !gated.has(p.id) && isInstalled(p.command));
  return { agents: [...presets, ...custom.filter((a) => !BUILT_IN_AGENT_IDS.has(a.id) && !gated.has(a.id))], custom, problems };
}
