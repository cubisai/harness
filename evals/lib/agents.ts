// The agents an eval can run, built the way the app builds them (index.ts)
// minus Electron: the same guide, guard and drivers. Claude and Codex use the
// user's own logins; third-party models go through native or OpenCode only.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createAcpDriver } from "../../src/main/agents/acp/driver";
import { createClaudeDriver } from "../../src/main/agents/claude";
import { createCodexDriver } from "../../src/main/agents/codex";
import { ACP_PRESETS } from "../../src/main/agents/registry";
import type { AgentDriver } from "../../src/main/agents/types";
import { BUILT_IN_GUARD } from "../../src/main/guard";
import type { InjectionPlan } from "../../src/main/inject";
import { createGuide } from "../../src/main/guide";
import { createProviderDriver } from "../../src/main/harness/driver";
import type { HarnessProtocol } from "../../src/main/harness/llm/types";
import { SessionStore } from "../../src/main/harness/session";
import { discoverSkills } from "../../src/main/skills/discover";
import { skillTool } from "../../src/main/skills/tool";
import type { Provider } from "../../src/shared/types";

export type AgentId = "native" | "claude" | "codex" | "opencode";
export const AGENTS: AgentId[] = ["native", "claude", "codex", "opencode"];

export const PRESETS: Record<string, { envVar: string; baseURL: string; protocol: HarnessProtocol; model: string }> = {
  th: { envVar: "TOKENHARBOR_API_KEY", baseURL: "https://tokenharbor.ai/v1", protocol: "anthropic-messages", model: "claude-haiku-5.5" },
  pgs: { envVar: "PGS_API_KEY", baseURL: "https://api.pgsgrove.com/v1", protocol: "openai-chat", model: "deepseek-v4.1-flash" },
};

export interface AgentSetup {
  driver(cwd: string): AgentDriver;
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

export function setupAgent(agent: AgentId, o: { root: string; scratch: string; provider?: string; model?: string }): AgentSetup {
  const guide = createGuide({ bundled: join(o.root, "resources", "CUBIQ.md"), global: join(o.scratch, "no-user-guide.md") });
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
    return {
      driver: () =>
        createProviderDriver("eval", {
          provider: () => provider,
          secret: () => key,
          secretHeaders: () => ({}),
          sessions: new SessionStore(join(o.scratch, "sessions")),
          outputDir: join(o.scratch, "out"),
          guardScript: BUILT_IN_GUARD,
          guide: forCwd,
          memory: () => null,
          mcpTools: () => [],
          skills: (dir) => {
            const found = discoverSkills({ origin: "project", dir: join(dir, ".agents", "skills") });
            return found.length ? skillTool(() => found) : null;
          },
        }),
      model,
      label: model,
      protocol: preset.protocol,
      skillDirs: [".agents/skills"],
      hashPaths: ["src/main/harness", "src/main/skills", ...shared],
      version: "",
      fidelity: "full: thread events plus the model-visible session messages (tool calls and results); system prompt and tool schemas not stored",
      sessionFile: (id) => join(o.scratch, "sessions", `${id}.jsonl`),
      dispose: () => {},
    };
  }

  const drivers: AgentDriver[] = [];
  const keep = (d: AgentDriver) => (drivers.push(d), d);
  const base = { model: o.model ?? "", protocol: agent, version: "", fidelity: `thread events only: ${agent}'s own prompt, tool schemas and internal loop are not visible to CubiQ`, dispose: () => drivers.forEach((d) => d.dispose?.()) };

  if (agent === "claude") {
    // Haiku keeps subscription use low; Claude Code reads .claude/skills itself.
    const model = o.model ?? "haiku";
    return {
      ...base,
      driver: () => keep(createClaudeDriver({ guide: forCwd, guardScript: BUILT_IN_GUARD, pluginDir: () => null })),
      model,
      label: `claude/${model}`,
      skillDirs: [".claude/skills"],
      hashPaths: ["src/main/agents/claude.ts", "src/main/agents/summarize.ts", ...shared],
      version: cliVersion("claude"),
    };
  }
  if (agent === "codex") {
    const model = o.model ?? "default";
    return {
      ...base,
      driver: () => keep(createCodexDriver({ command: "codex", args: ["app-server"], clientVersion: "eval", guardScript: BUILT_IN_GUARD, guide: forCwd })),
      model,
      label: `codex/${model}`,
      skillDirs: [".agents/skills"],
      hashPaths: ["src/main/agents/codex.ts", "src/main/agents/rpc.ts", "src/main/agents/summarize.ts", ...shared],
      version: cliVersion("codex"),
    };
  }
  const config = ACP_PRESETS.find((p) => p.id === "opencode")!;
  // "default" = OpenCode's own configured model (the app's "Agent default").
  // With --provider, an OpenAI-compatible preset is added as an `eval` provider
  // through OPENCODE_CONFIG_CONTENT; the key stays an {env:} reference.
  let model = o.model ?? "default";
  let injection: (() => InjectionPlan) | undefined;
  if (o.provider) {
    const preset = PRESETS[o.provider];
    if (!preset || preset.protocol !== "openai-chat") throw new Error(`--agent opencode --provider must be one of ${Object.entries(PRESETS).filter(([, p]) => p.protocol === "openai-chat").map(([id]) => id).join(", ")}`);
    if (!process.env[preset.envVar]) throw new Error(`${preset.envVar} is not set (run with bun --env-file=.env)`);
    const id = o.model ?? preset.model;
    model = `eval/${id}`;
    const content = JSON.stringify({
      model,
      provider: { eval: { npm: "@ai-sdk/openai-compatible", name: "eval", options: { baseURL: preset.baseURL, apiKey: `{env:${preset.envVar}}` }, models: { [id]: { name: id, tool_call: true } } } },
    });
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    injection = () => ({ env: { ...env, OPENCODE_CONFIG_CONTENT: content }, byok: true });
  }
  return {
    ...base,
    driver: () => keep(createAcpDriver(config, { clientVersion: "eval", guardScript: BUILT_IN_GUARD, guide: forCwd, injection })),
    model,
    label: `opencode/${model}`,
    skillDirs: [".agents/skills"],
    hashPaths: ["src/main/agents/acp", "src/main/agents/rpc.ts", "src/main/agents/summarize.ts", ...shared],
    version: cliVersion("opencode"),
  };
}
