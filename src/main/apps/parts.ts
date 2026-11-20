import { createHash } from "node:crypto";
import type { PluginContributions, PluginPartView, PluginRule, PluginRuleTarget } from "../../shared/plugin-parts";
import { prepareAutomation } from "../creator/automations";
import { describeSchedule } from "../automations/schedule";
import { describeSpec } from "../mcp/servers";
import { requiredVarsOf, validateProposal } from "../extensions/manifest";
import type { Thread } from "../../shared/types";
import { parseAppTheme } from "./app-theme-validation";

const PART = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const NATIVE = new Set(["Bash", "Run", "Edit", "Write", "Read", "MultiEdit", "NotebookEdit", "Glob", "Grep", "Skill", "TodoWrite", "WebFetch", "WebSearch", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "Task", "Agent", "bash", "read", "edit", "write", "shell", "exec_command", "apply_patch", "propose_plan"]);
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function exact(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!record(v) || Object.keys(v).some((k) => !keys.includes(k))) throw new Error(`Expected an object with only ${keys.join(", ")}.`);
}
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.includes("\0") || Buffer.byteLength(v) > max) throw new Error(`Expected non-empty text, at most ${max} bytes.`);
  return v.trim();
}
function name(v: unknown): string { if (typeof v !== "string" || !PART.test(v)) throw new Error("Part names use lowercase letters, digits and dashes, starting with a letter (max 32)."); return v; }

export function parseContributions(raw: unknown, paths: ReadonlySet<string>): PluginContributions | undefined {
  if (raw === undefined) return undefined;
  exact(raw, ["commands", "rules", "skills", "connectors", "automations", "appTheme"]);
  const out: PluginContributions = {};
  let total = 0;
  const appTheme = parseAppTheme(raw.appTheme);
  if (appTheme) { out.appTheme = appTheme; total++; }
  const list = (key: keyof PluginContributions, max: number): unknown[] => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max) throw new Error(`${key} must be a list of at most ${max} parts.`);
    total += v.length;
    return v;
  };
  const unique = (items: { name: string }[]) => { if (new Set(items.map((i) => i.name)).size !== items.length) throw new Error("Duplicate contribution name."); };
  const commands = list("commands", 16).map((v) => {
    exact(v, ["name", "description", "prompt"]);
    return { name: name(v.name), description: text(v.description, 500), prompt: text(v.prompt, 32 * 1024) };
  });
  unique(commands); if (commands.length) out.commands = commands;
  const skills = list("skills", 8).map((v) => {
    exact(v, ["name", "description", "path"]);
    const path = text(v.path, 200);
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path) || !paths.has(`${path}/SKILL.md`)) throw new Error("Each skill path must be a local folder containing SKILL.md.");
    return { name: name(v.name), description: text(v.description, 500), path };
  });
  unique(skills);
  if (skills.some((s, i) => skills.some((other, j) => i !== j && (other.path === s.path || other.path.startsWith(`${s.path}/`))))) throw new Error("Skill folders must not overlap.");
  if (skills.length) out.skills = skills;
  const connectors = list("connectors", 8).map((v) => {
    exact(v, ["name", "spec"]);
    const check = validateProposal({ kind: "connector", name: name(v.name), spec: v.spec }, { scope: { kind: "global" } });
    if (!check.ok) throw new Error(check.errors.join(" "));
    if (check.proposal.draft.kind !== "connector") throw new Error("Invalid connector.");
    return { name: check.proposal.draft.name, spec: check.proposal.draft.spec };
  });
  unique(connectors); if (connectors.length) out.connectors = connectors;
  const rules = list("rules", 32).map((v): PluginRule => {
    exact(v, ["action", "target", "reason"]);
    if (v.action !== "ask" && v.action !== "allow") throw new Error("Rule action must be ask or allow.");
    const t = v.target;
    let target: PluginRuleTarget;
    if (record(t) && t.kind === "tool") {
      exact(t, ["kind", "name"]);
      if (typeof t.name !== "string" || !TOOL.test(t.name) || NATIVE.has(t.name)) throw new Error("Rules require an exact CubiQ-managed tool, not native Bash/Run/Read/Edit tools.");
      target = { kind: "tool", name: t.name };
    } else {
      exact(t, ["kind", "server", "tool"]);
      if (t.kind !== "connector" || typeof t.server !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(t.server) || typeof t.tool !== "string" || !TOOL.test(t.tool)) throw new Error("A connector rule needs exact server and tool names.");
      target = { kind: "connector", server: t.server, tool: t.tool };
    }
    return { action: v.action, target, ...(v.reason !== undefined ? { reason: text(v.reason, 500) } : {}) };
  });
  if (new Set(rules.map((r) => JSON.stringify(r.target))).size !== rules.length) throw new Error("List each rule target only once per plugin.");
  if (rules.length) out.rules = rules;
  const automations = list("automations", 8).map((v) => {
    exact(v, ["name", "config"]);
    if (!record(v.config) || typeof v.config.agent !== "string" || !(v.config.model === null || typeof v.config.model === "string")) throw new Error("Bundled automation config must explicitly select agent and model (null for default).");
    const draft = prepareAutomation(name(v.name), v.config, { agent: v.config.agent, model: v.config.model ?? "default" } as Thread, [{ id: v.config.agent, models: typeof v.config.model === "string" ? [v.config.model] : [] }]);
    return { name: draft.name, input: draft.input };
  });
  unique(automations); if (automations.length) out.automations = automations;
  if (total > 64) throw new Error("A plugin may contribute at most 64 parts.");
  return total ? out : undefined;
}

/** Runtime identifiers fit both the skill and server limits, without ambiguous concatenation. */
export function partRuntimeName(plugin: string, part: string): string {
  const hash = createHash("sha256").update(JSON.stringify([plugin, part])).digest("hex").slice(0, 16);
  return `p-${plugin.slice(0, 12)}-${part.slice(0, 7)}-${hash}`;
}

export function contributionViews(plugin: string, parts?: PluginContributions, projectId?: string): PluginPartView[] {
  if (!parts) return [];
  return [
    ...(parts.appTheme ? [{ kind: "app-theme" as const, name: "App theme", description: "CubiQ chrome palette · All projects · Apply separately", detail: JSON.stringify(parts.appTheme, null, 2) }] : []),
    ...(parts.commands ?? []).map((c): PluginPartView => ({ kind: "command", name: `/${plugin}.${c.name}`, description: c.description, detail: c.prompt })),
    ...(parts.rules ?? []).map((r): PluginPartView => ({ kind: "rule", name: r.target.kind === "tool" ? r.target.name : `${r.target.server}.${r.target.tool}`, description: r.action === "ask" ? "Always ask" : "Allow verified reads only", ...(r.reason ? { detail: r.reason } : {}) })),
    ...(parts.skills ?? []).map((s): PluginPartView => ({ kind: "skill", name: partRuntimeName(plugin, s.name), description: s.description, detail: s.path })),
    ...(parts.connectors ?? []).map((c): PluginPartView => ({ kind: "connector", name: partRuntimeName(plugin, c.name), description: describeSpec(c.spec), detail: `Required variables: ${requiredVarsOf(c.spec).map((v) => `\${${v}}`).join(", ") || "none"}\n${JSON.stringify(c.spec, null, 2)}`, ...(c.spec.type === "stdio" ? { risk: true } : {}) })),
    ...(parts.automations ?? []).map((a): PluginPartView => ({ kind: "automation", name: a.name, description: `${a.input.name} · ${describeSchedule(a.input.schedule)} · Off/Ask`, detail: JSON.stringify(a.input, null, 2), ...(projectId ? { projectId } : {}) })),
  ];
}

export function decidePluginRule(rules: readonly PluginRule[], target: PluginRuleTarget, readOnly: boolean): "ask" | "allow" | null {
  const matches = rules.filter((r) => JSON.stringify(r.target) === JSON.stringify(target));
  if (matches.some((r) => r.action === "ask")) return "ask";
  return readOnly && matches.some((r) => r.action === "allow") ? "allow" : null;
}
