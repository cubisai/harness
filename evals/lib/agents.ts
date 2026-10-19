// The agents an eval can run, built the way the app builds them (index.ts)
// minus Electron: the same guide, guard and drivers. Claude and Codex use the
// user's own logins; third-party models go through native or OpenCode only.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAcpDriver } from "../../src/main/agents/acp/driver";
import { createClaudeDriver } from "../../src/main/agents/claude";
import { createCodexDriver } from "../../src/main/agents/codex";
import { ACP_PRESETS } from "../../src/main/agents/registry";
import type { AgentDriver, HarnessTool } from "../../src/main/agents/types";
import { BUILT_IN_GUARD } from "../../src/main/guard";
import { ensureOpenCodeGuard, withOpenCodeGuard } from "../../src/main/inject/opencode-guard";
import { startToolServer, type ToolServer } from "../../src/main/mcp-http";
import { memoryPrompt } from "../../src/main/memory/index";
import type { InjectionPlan } from "../../src/main/inject";
import { createGuide } from "../../src/main/guide";
import { createProviderDriver } from "../../src/main/harness/driver";
import type { HarnessProtocol } from "../../src/main/harness/llm/types";
import { SessionStore } from "../../src/main/harness/session";
import { McpClientPool, routerTools } from "../../src/main/mcp/router";
import { McpToolsCache } from "../../src/main/mcp/servers";
import { discoverSkills } from "../../src/main/skills/discover";
import { skillTool } from "../../src/main/skills/tool";
import type { Provider } from "../../src/shared/types";
import type { Scenario } from "./types";

export type AgentId = "native" | "claude" | "codex" | "opencode";
export const AGENTS: AgentId[] = ["native", "claude", "codex", "opencode"];

export const PRESETS: Record<string, { envVar: string; baseURL: string; protocol: HarnessProtocol; model: string }> = {
  th: { envVar: "TOKENHARBOR_API_KEY", baseURL: "https://tokenharbor.ai/v1", protocol: "anthropic-messages", model: "claude-haiku-5.5" },
  pgs: { envVar: "PGS_API_KEY", baseURL: "https://api.pgsgrove.com/v1", protocol: "openai-chat", model: "deepseek-v4.1-flash" },
};

export interface AgentSetup {
  driver(cwd: string, scenario?: Scenario): AgentDriver;
  model: string;
  /** Names the run in reports, the cache key and the baseline: the bare model for native, "<agent>/<model>" otherwise. */
  label: string;
  protocol: string;
  /** Where the agent reads project skills, relative to the project. */
  skillDirs: string[];
  /** Source paths (repo-relative) whose changes invalidate cached results. */
  hashPaths: string[];
  /** The agent's CLI version, part of the cache key. */
  version: string;
  /** What a trace shows for this engine (manifest + trace files). */
  fidelity: string;
  /** The model-visible session log for a session id, when the engine keeps one CubiQ can read. */
  sessionFile?(sessionId: string): string | null;
  dispose(): void;
}

const cliVersion = (command: string): string => {
  try {
    return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 20_000, shell: process.platform === "win32" }).trim().split("\n")[0] ?? "";
  } catch {
    return "missing";
  }
};

/**
 * What the app gives a CLI engine besides its guide: the scenario's memory as
 * CubiQ's memory block, and the trial's harness tools (the browser's) over the
 * app's MCP tool server, which Codex and OpenCode call (Claude takes them
 * in-process). Trials run one at a time, so one server serves the current list.
 */
export function cliWiring(): {
  /** Points the server at this trial's tools; returns the driver's `memory` option. */
  forTrial(scenario?: Scenario): () => string | null;
  toolServer(): Promise<ToolServer>;
  close(): void;
} {
  let trialTools: HarnessTool[] = [];
  let server: Promise<ToolServer> | null = null;
  return {
    forTrial: (scenario) => {
      trialTools = scenario?.tools ?? [];
      const block = scenario?.memory ? memoryPrompt(scenario.memory) : null;
      return () => block;
    },
    toolServer: () => (server ??= startToolServer(() => trialTools)),
    close: () => void server?.then((s) => s.close()).catch(() => {}),
  };
}

/** The user's global OpenCode config (opencode.json[c] or config.json), or null when absent or unreadable. */
export function readUserOpenCodeConfig(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  const dir = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // jsonc: drop whole-line comments and trailing commas, then try once more.
      try {
        return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The only OpenCode config an eval trial sees: the user's providers and
 * default model (so their models resolve), never their agents, plugins, MCP
 * servers or permissions, which would make the run measure their setup
 * instead of CubiQ's (a user agent can delegate everything, or allow every
 * command). `extra` is a --provider preset's own provider and model.
 */
export function openCodeEvalConfig(user: Record<string, unknown> | null, extra?: { model: string; provider: Record<string, unknown> }): Record<string, unknown> {
  const userProviders = user?.provider && typeof user.provider === "object" ? (user.provider as Record<string, unknown>) : {};
  const model = extra?.model ?? (typeof user?.model === "string" ? user.model : undefined);
  return {
    $schema: "https://opencode.ai/config.json",
    provider: { ...userProviders, ...(extra?.provider ?? {}) },
    ...(model ? { model } : {}),
    ...(typeof user?.small_model === "string" ? { small_model: user.small_model } : {}),
  };
}

export function setupAgent(agent: AgentId, o: { root: string; scratch: string; provider?: string; model?: string; guide?: string }): AgentSetup {
  // --guide overrides the bundled project guide with a candidate's file.
  const guide = createGuide({ bundled: o.guide ?? join(o.root, "resources", "CUBIQ.md"), global: join(o.scratch, "no-user-guide.md") });
  const shared = ["src/main/guide.ts", "resources/CUBIQ.md", "src/main/guard.ts"];
  const forCwd = (cwd: string, design?: string) => guide.forCwd(cwd, design);

  if (agent === "native") {
    const preset = PRESETS[o.provider ?? "pgs"];
    if (!preset) throw new Error(`--provider must be one of ${Object.keys(PRESETS).join(", ")}`);
    const key = process.env[preset.envVar] ?? "";
    if (!key) throw new Error(`${preset.envVar} is not set (run with bun --env-file=.env)`);
    const model = o.model ?? preset.model;
    const provider: Provider = {
      id: "eval",
      label: "eval",
      wireProtocol: preset.protocol,
      baseURL: preset.baseURL,
      secret: { kind: "envRef", envVar: preset.envVar },
      models: [{ id: model, name: model, capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 200_000, maxOutput: 8_000 }],
    };
    const listings = new McpToolsCache();
    const pool = new McpClientPool();
    return {
      driver: (_cwd, scenario) =>
        createProviderDriver("eval", {
          provider: () => provider,
          secret: () => key,
          secretHeaders: () => ({}),
          sessions: new SessionStore(join(o.scratch, "sessions")),
          outputDir: join(o.scratch, "out"),
          guardScript: BUILT_IN_GUARD,
          guide: forCwd,
          memory: () => scenario?.memory ?? null,
          mcpTools: () => (scenario?.mcpServers.length ? routerTools({ servers: () => scenario.mcpServers, listings, pool }) : []),
          skills: (dir) => {
            const found = discoverSkills({ origin: "project", dir: join(dir, ".agents", "skills") });
            return found.length ? skillTool(() => found) : null;
          },
        }),
      model,
      label: model,
      protocol: preset.protocol,
      skillDirs: [".agents/skills"],
      hashPaths: ["src/main/harness", "src/main/mcp", "src/main/skills", ...shared],
      version: "",
      fidelity: "full: thread events plus the model-visible session messages (tool calls and results); system prompt and tool schemas not stored",
      sessionFile: (id) => join(o.scratch, "sessions", `${id}.jsonl`),
      dispose: () => {
        void pool.closeAll().catch(() => {});
      },
    };
  }

  const drivers: AgentDriver[] = [];
  const keep = (d: AgentDriver) => (drivers.push(d), d);
  // MCP servers reach CLI engines through TurnInput.mcpServers.
  const { forTrial, toolServer, close } = cliWiring();
  const dispose = () => {
    drivers.forEach((d) => d.dispose?.());
    close();
  };
  const cliShared = [...shared, "src/main/mcp-http.ts", "src/main/memory/index.ts"];
  const base = { model: o.model ?? "", protocol: agent, version: "", fidelity: `thread events only: ${agent}'s own prompt, tool schemas and internal loop are not visible to CubiQ`, dispose };

  if (agent === "claude") {
    // Haiku keeps subscription use low; Claude Code reads .claude/skills itself.
    const model = o.model ?? "haiku";
    return {
      ...base,
      driver: (_cwd, scenario) => keep(createClaudeDriver({ guide: forCwd, guardScript: BUILT_IN_GUARD, pluginDir: () => null, memory: forTrial(scenario) })),
      model,
      label: `claude/${model}`,
      skillDirs: [".claude/skills"],
      hashPaths: ["src/main/agents/claude.ts", "src/main/agents/summarize.ts", ...cliShared],
      version: cliVersion("claude"),
    };
  }
  if (agent === "codex") {
    const model = o.model ?? "default";
    return {
      ...base,
      driver: (_cwd, scenario) => keep(createCodexDriver({ command: "codex", args: ["app-server"], clientVersion: "eval", guardScript: BUILT_IN_GUARD, guide: forCwd, memory: forTrial(scenario), toolServer })),
      model,
      label: `codex/${model}`,
      skillDirs: [".agents/skills"],
      hashPaths: ["src/main/agents/codex.ts", "src/main/agents/rpc.ts", "src/main/agents/summarize.ts", ...cliShared],
      version: cliVersion("codex"),
    };
  }
  const config = ACP_PRESETS.find((p) => p.id === "opencode")!;
  // "default" = OpenCode's own configured model (the app's "Agent default").
  // With --provider, an OpenAI-compatible preset is added as an `eval` provider
  // through OPENCODE_CONFIG_CONTENT; the key stays an {env:} reference.
  let model = o.model ?? "default";
  let extra: { model: string; provider: Record<string, unknown> } | undefined;
  if (o.provider) {
    const preset = PRESETS[o.provider];
    if (!preset || preset.protocol !== "openai-chat") throw new Error(`--agent opencode --provider must be one of ${Object.entries(PRESETS).filter(([, p]) => p.protocol === "openai-chat").map(([id]) => id).join(", ")}`);
    if (!process.env[preset.envVar]) throw new Error(`${preset.envVar} is not set (run with bun --env-file=.env)`);
    const id = o.model ?? preset.model;
    model = `eval/${id}`;
    extra = { model, provider: { eval: { npm: "@ai-sdk/openai-compatible", name: "eval", options: { baseURL: preset.baseURL, apiKey: `{env:${preset.envVar}}` }, models: { [id]: { name: id, tool_call: true } } } } };
  }
  // A trial runs on an empty config folder (sign-ins in XDG_DATA_HOME stay), with the
  // CubiQ plugin the app loads: it asks the runner before every edit and command.
  const content = JSON.stringify(openCodeEvalConfig(readUserOpenCodeConfig(), extra));
  const configHome = join(o.scratch, "opencode-config");
  mkdirSync(configHome, { recursive: true });
  const pluginUrl = ensureOpenCodeGuard(join(o.scratch, "opencode"));
  const injection = (): InjectionPlan => {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    return withOpenCodeGuard({ env: { ...env, XDG_CONFIG_HOME: configHome, OPENCODE_CONFIG_CONTENT: content }, byok: Boolean(extra) }, { pluginUrl });
  };
  return {
    ...base,
    driver: (_cwd, scenario) => keep(createAcpDriver(config, { clientVersion: "eval", guardScript: BUILT_IN_GUARD, guide: forCwd, injection, memory: forTrial(scenario), toolServer })),
    model,
    label: `opencode/${model}`,
    skillDirs: [".agents/skills"],
    hashPaths: ["src/main/agents/acp", "src/main/agents/rpc.ts", "src/main/agents/summarize.ts", "src/main/inject/opencode-guard.ts", ...cliShared],
    version: cliVersion("opencode"),
  };
}
