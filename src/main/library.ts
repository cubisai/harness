import { join } from "node:path";
import type { AgentCatalogEntry, SkillDetail } from "../shared/types";
import type { AcpAgentConfig } from "./agents/acp/driver";
import { ACP_PRESETS } from "./agents/registry";
import { type Catalog, readSkillBody } from "./skills/catalog";
import { PLUGIN_NAME } from "./skills/plugin";

const INSTALL_PY = "install into the project (.agents/skills)";

/** How model-invoked skills reach an agent. */
export function skillRoute(agent: { id: string; kind: AgentCatalogEntry["kind"]; skillsDirEnv?: string }): string {
  if (agent.kind === "agent-sdk") return `As a plugin, loaded when the task calls for it`;
  if (agent.kind === "app-server") return "As an extra skills folder, loaded when the task calls for it";
  if (agent.skillsDirEnv) return `Through ${agent.skillsDirEnv}, loaded when the task calls for it`;
  return `Not automatic: ${INSTALL_PY}`;
}

/** Everything the Library shows for one skill, and how it reaches each available agent. */
export function skillDetail(catalog: Catalog, name: string, agents: AgentCatalogEntry[]): SkillDetail {
  const skill = catalog.byName.get(name);
  if (!skill) throw new Error(`No skill named ${name}`);
  const available = agents.filter((a) => a.installed);
  return {
    skill,
    body: readSkillBody(catalog.root, name),
    dir: catalog.root.skillsDir ? join(catalog.root.skillsDir, name) : "",
    calledBy: catalog.skills.filter((s) => s.calls.includes(name)).map((s) => s.name),
    routes: available.map((a) => ({
      agent: a.label,
      how: skill.invocation === "user" ? "From the / menu: the app puts the skill's text into your message" : a.skills,
    })),
  };
}

/**
 * Every agent the app knows: Claude, Codex, the ACP presets, and agents.json,
 * installed or not, so the Library can say how to get the missing ones.
 */
export function agentCatalog(opts: {
  installed: (command: string) => boolean;
  custom: AcpAgentConfig[];
}): AgentCatalogEntry[] {
  const acpMcp = "Stdio servers, and HTTP ones (with the browser tools) when the agent supports them";
  const out: AgentCatalogEntry[] = [
    {
      id: "claude",
      label: "Claude",
      kind: "agent-sdk",
      command: null,
      installed: true,
      source: "built-in",
      homepage: "https://docs.claude.com/en/docs/claude-code",
      skills: "",
      mcp: "Stdio and HTTP servers, the browser tools in-process, plus Claude Code's own config",
    },
    {
      id: "codex",
      label: "Codex",
      kind: "app-server",
      command: "codex app-server",
      installed: opts.installed("codex"),
      source: "built-in",
      install: "npm install -g @openai/codex",
      homepage: "https://developers.openai.com/codex",
      skills: "",
      mcp: "Stdio and HTTP servers, the browser tools, plus ~/.codex/config.toml",
    },
  ];
  const customIds = new Set(opts.custom.map((a) => a.id));
  for (const p of ACP_PRESETS) {
    if (customIds.has(p.id)) continue;
    out.push({ ...acpEntry(p, "built-in"), installed: opts.installed(p.command), mcp: acpMcp });
  }
  for (const c of opts.custom) {
    if (c.id === "claude") continue;
    out.push({ ...acpEntry(c, "agents.json"), installed: opts.installed(c.command), mcp: acpMcp });
  }
  return out.map((a) => ({ ...a, skills: skillRoute({ id: a.id, kind: a.kind, skillsDirEnv: findEnv(a.id, opts.custom) }) }));
}

function findEnv(id: string, custom: AcpAgentConfig[]): string | undefined {
  return (custom.find((c) => c.id === id) ?? ACP_PRESETS.find((p) => p.id === id))?.skillsDirEnv;
}

function acpEntry(c: AcpAgentConfig, source: AgentCatalogEntry["source"]): Omit<AgentCatalogEntry, "installed" | "mcp"> {
  return {
    id: c.id,
    label: c.label,
    kind: "acp",
    command: [c.command, ...c.args].join(" "),
    source,
    ...(c.install && { install: c.install }),
    ...(c.homepage && { homepage: c.homepage }),
    skills: "",
  };
}
