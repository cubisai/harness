// OpenCode's provider-injection helpers. The injector itself was removed when
// providers became native agents; what remains are the pieces still used by the
// service and settings: parsing OpenCode's model variants, reading them from a
// running binary, and folding a picked variant into an injection plan.

import { killTree, spawnCommand } from "../winspawn";
import type { InjectedEnv, InjectionPlan } from ".";

/**
 * Parse `opencode models --verbose`: each model is a `<provider>/<model>` line
 * followed by a pretty-printed JSON object; its `variants` keys are the model's
 * reasoning levels. Only models with at least one variant are returned, and any
 * line that isn't part of a block (OpenCode logs, blank lines) is ignored.
 */
export function parseOpenCodeVariants(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const id = lines[i]!.trim();
    const isModelId = id.length > 0 && id.includes("/") && !id.startsWith("{") && !id.startsWith("}") && !/\s/.test(id);
    if (!isModelId) {
      i++;
      continue;
    }
    // The block starts on the next non-empty line.
    let start = i + 1;
    while (start < lines.length && lines[start]!.trim() === "") start++;
    if (start >= lines.length || !lines[start]!.trim().startsWith("{")) {
      i++;
      continue;
    }
    // Consume until the braces balance, so a nested object can't end it early.
    let depth = 0;
    let block = "";
    let end = start;
    for (; end < lines.length; end++) {
      block += (block ? "\n" : "") + lines[end]!;
      for (const ch of lines[end]!) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth <= 0) break;
    }
    try {
      const parsed = JSON.parse(block) as { variants?: Record<string, unknown> };
      const names = parsed.variants && typeof parsed.variants === "object" ? Object.keys(parsed.variants) : [];
      if (names.length) out[id] = names;
    } catch {
      // Not a JSON block after all; keep scanning.
    }
    i = end + 1;
  }
  return out;
}

const variantsCache = new Map<string, Promise<Record<string, string[]>>>();

/**
 * `opencode models --verbose`, parsed and cached for the process lifetime.
 * Any failure (not installed, slow, bad output) resolves to `{}`: a missing
 * variant list only means the picker offers no reasoning levels.
 */
export function opencodeVariants(command: string): Promise<Record<string, string[]>> {
  const cached = variantsCache.get(command);
  if (cached) return cached;
  const p = new Promise<Record<string, string[]>>((resolve) => {
    let child;
    try {
      child = spawnCommand(command, ["models", "--verbose"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({});
      return;
    }
    let out = "";
    let settled = false;
    const finish = (result: Record<string, string[]>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({});
    }, 60_000);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => finish({}));
    child.on("close", () => finish(parseOpenCodeVariants(out)));
  });
  variantsCache.set(command, p);
  return p;
}

/**
 * Add a model variant to an OpenCode injection plan. The variant lives under
 * `agent.<agentName>` alongside the model it applies to; every other key of the
 * config (provider, plugin, ...) is kept. A plan that already errored is left
 * to the caller to check; the plan is mutated and returned like the guard's.
 */
export function withOpenCodeVariant(
  plan: InjectionPlan | undefined,
  pick: { agent: string; model: string; variant: string },
  env: NodeJS.ProcessEnv = process.env,
): InjectionPlan {
  let out = plan;
  if (!out) {
    const base: InjectedEnv = {};
    for (const [name, value] of Object.entries(env)) if (value !== undefined) base[name] = value;
    out = { env: base, byok: false };
  }
  const raw = out.env.OPENCODE_CONFIG_CONTENT;
  let config: Record<string, unknown>;
  if (raw !== undefined) {
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      config = {};
    }
  } else {
    config = {};
  }
  const agents = (config.agent && typeof config.agent === "object" ? config.agent : {}) as Record<string, unknown>;
  const existing = (agents[pick.agent] && typeof agents[pick.agent] === "object" ? agents[pick.agent] : {}) as Record<string, unknown>;
  agents[pick.agent] = { ...existing, model: pick.model, variant: pick.variant };
  config.agent = agents;
  out.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return out;
}
