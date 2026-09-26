import { join } from "node:path";
import type { AgentCapabilities, AgentCatalogEntry, SkillDetail, SkillsDelivery } from "../shared/types";
import type { AcpAgentConfig } from "./agents/acp/driver";
import { acpCapabilities, CLAUDE_CAPABILITIES, CODEX_CAPABILITIES, skillDeliveryGap } from "./agents/capabilities";
import { ACP_PRESETS, BUILT_IN_AGENT_IDS } from "./agents/registry";
import { type Catalog, readSkillBody } from "./skills/catalog";

/** How model-invoked skills reach an agent, worded from its delivery mode. */
export function skillRoute(agent: { skillsDelivery: SkillsDelivery; skillsDirEnv?: string }): string {
  const d = agent.skillsDelivery;
  if (d.mode === "plugin") return "As a plugin, loaded when the task calls for it";
  if (d.mode === "extraRoots") return "As an extra skills folder, loaded when the task calls for it";
  if (d.mode === "envDir") return `Through ${agent.skillsDirEnv}, loaded when the task calls for it`;
  return `Not automatic: ${skillDeliveryGap(d)}`;
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
  /** A running driver's capabilities, authoritative over the preset's static set. */
  liveCapabilities?: (id: string) => AgentCapabilities | undefined;
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
    if (BUILT_IN_AGENT_IDS.has(c.id)) continue;
    out.push({ ...acpEntry(c, "agents.json"), installed: opts.installed(c.command), mcp: acpMcp });
  }
  // A user entry with a preset's id replaces the preset, capabilities included.
  const configById = new Map<string, AcpAgentConfig>();
  for (const p of ACP_PRESETS) configById.set(p.id, p);
  for (const c of opts.custom) configById.set(c.id, c);
  return out.map((a) => {
    if (a.kind === "agent-sdk") {
      return { ...a, skills: skillRoute({ skillsDelivery: CLAUDE_CAPABILITIES.skillsDelivery }), capabilities: opts.liveCapabilities?.(a.id) ?? CLAUDE_CAPABILITIES };
    }
    if (a.kind === "app-server") {
      return { ...a, skills: skillRoute({ skillsDelivery: CODEX_CAPABILITIES.skillsDelivery }), capabilities: opts.liveCapabilities?.(a.id) ?? CODEX_CAPABILITIES };
    }
    const c = configById.get(a.id);
    const caps = acpCapabilities(c ?? {});
    return {
      ...a,
      skills: skillRoute({ skillsDelivery: caps.skillsDelivery, ...(c?.skillsDirEnv ? { skillsDirEnv: c.skillsDirEnv } : {}) }),
      capabilities: opts.liveCapabilities?.(a.id) ?? caps,
    };
  });
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
