// OpenCode v2 reads a different config shape from v1 (checked on 2.1.0 and
// 2.2.0): it ignores v1's `agent`, `permission`, `provider` and `plugin` keys.
// Every injector here writes the v1 shape; for a v2 CLI the finished config is
// translated once, just before the spawn, so the v1 path never changes.

import type { InjectionPlan } from ".";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** v1 permission keys that v2 renamed; the rest keep their name. */
const ACTIONS: Record<string, string> = { bash: "shell", task: "subagent", write: "edit", patch: "edit" };

/**
 * v1's own default that v2 lacks: v2's base rule allows every action, so a
 * read outside the project would never ask (2.2.0 still checks
 * `external_directory`, sub-agents included, and asks over ACP). Placed first,
 * so any rule after it wins (v2 takes the last match).
 */
const V1_DEFAULTS = [{ action: "external_directory", resource: "*", effect: "ask" }];

/**
 * A v1 `permission` object as v2's ordered `permissions` rules. A bare string
 * is that action's `*` rule; an object's `*` entry goes first so the specific
 * patterns after it win (v1 merged them the same way).
 */
export function toV2Permissions(permission: unknown): { action: string; resource: string; effect: string }[] {
  if (!isObject(permission)) return [];
  const rules: { action: string; resource: string; effect: string }[] = [];
  for (const [key, value] of Object.entries(permission)) {
    const action = ACTIONS[key] ?? key;
    if (typeof value === "string") {
      rules.push({ action, resource: "*", effect: value });
      continue;
    }
    if (!isObject(value)) continue;
    const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    for (const [resource, effect] of [...entries.filter(([r]) => r === "*"), ...entries.filter(([r]) => r !== "*")]) rules.push({ action, resource, effect });
  }
  return rules;
}

/** One v1 agent entry in v2's shape: `prompt` → `system`, `variant` → `model#variant`, `permission` → `permissions`. */
function toV2Agent(agent: unknown): unknown {
  if (!isObject(agent)) return agent;
  const { prompt, variant, permission, model, ...rest } = agent;
  const out: Json = { ...rest };
  if (typeof prompt === "string") out.system = prompt;
  if (typeof model === "string") out.model = typeof variant === "string" && variant ? `${model}#${variant}` : model;
  if (permission !== undefined) {
    const rules = toV2Permissions(permission);
    if (rules.length) out.permissions = rules;
  }
  return out;
}

/** One v1 provider in v2's shape: `npm` → `package: "aisdk:<npm>"`, `options` → `settings`, a model's `id` → `modelID`. */
function toV2Provider(provider: unknown): unknown {
  if (!isObject(provider)) return provider;
  const { npm, options, models, ...rest } = provider;
  const out: Json = { ...rest };
  if (typeof npm === "string") out.package = npm.startsWith("aisdk:") ? npm : `aisdk:${npm}`;
  if (isObject(options)) out.settings = options;
  if (isObject(models)) {
    const next: Json = {};
    for (const [key, model] of Object.entries(models)) {
      if (!isObject(model)) continue;
      const { id, ...fields } = model;
      next[key] = { ...(typeof id === "string" ? { modelID: id } : {}), ...fields };
    }
    out.models = next;
  }
  return out;
}

/** A v1-shaped OpenCode config in v2's shape. Keys v2 shares with v1 (`model`, `$schema`, `mcp`…) pass through. */
export function toOpenCodeV2Config(config: Json): Json {
  const { agent, permission, provider, plugin, ...rest } = config;
  const out: Json = { ...rest };
  if (isObject(agent)) {
    const agents: Json = isObject(rest.agents) ? { ...rest.agents } : {};
    for (const [id, entry] of Object.entries(agent)) agents[id] = toV2Agent(entry);
    out.agents = agents;
  }
  out.permissions = [...V1_DEFAULTS, ...(Array.isArray(rest.permissions) ? rest.permissions : []), ...toV2Permissions(permission)];
  if (isObject(provider)) {
    const providers: Json = isObject(rest.providers) ? { ...rest.providers } : {};
    for (const [id, entry] of Object.entries(provider)) providers[id] = toV2Provider(entry);
    out.providers = providers;
  }
  if (Array.isArray(plugin)) {
    const plugins = Array.isArray(rest.plugins) ? [...rest.plugins] : [];
    for (const entry of plugin) {
      if (typeof entry === "string") plugins.push({ package: entry });
      else if (Array.isArray(entry) && typeof entry[0] === "string") plugins.push({ package: entry[0], ...(isObject(entry[1]) ? { options: entry[1] } : {}) });
    }
    out.plugins = plugins;
  }
  return out;
}

/** Rewrite a plan's inline OpenCode config for a v2 CLI; a plan without one, or with an error, is returned as is. */
export function withOpenCodeV2(plan: InjectionPlan): InjectionPlan {
  if (plan.error) return plan;
  const raw = plan.env.OPENCODE_CONFIG_CONTENT;
  if (raw === undefined) return plan;
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    return plan;
  }
  if (!isObject(config)) return plan;
  plan.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(toOpenCodeV2Config(config));
  return plan;
}
