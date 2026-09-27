// OpenCode's injector: `opencode acp` reads its whole provider config from the
// OPENCODE_CONFIG_CONTENT env var and the key from its own env var, referenced
// there as `{env:VAR}`, so nothing is written anywhere. The key lives only in
// the child process environment (and on Linux is readable via /proc/<pid>/environ
// by processes that may read it); never log the env object.

import type { Provider } from "../../shared/types";
import { execCommandSync, killTree, spawnCommand } from "../winspawn";
import { catalogFor } from "../providers";
import { providerKeyVar } from "./keys";
import type { InjectedEnv, InjectionPlan } from ".";

/**
 * The plan for one OpenCode turn on a BYOK provider: a v1 config in
 * OPENCODE_CONFIG_CONTENT, the key in the env var the config references.
 */
export function injectOpenCode(
  provider: Provider,
  secret: string | null,
  base: InjectedEnv,
  opts: { version: string | null },
): InjectionPlan {
  const major = opts.version === null ? null : Number.parseInt(opts.version, 10);
  if (major !== 1) {
    return {
      env: base,
      byok: true,
      error: `OpenCode ${opts.version ?? "(version unknown)"} uses a config format this app hasn't been verified against (1.x only).`,
    };
  }
  if (provider.wireProtocol !== "openai-chat") {
    return {
      env: base,
      byok: true,
      error: `OpenCode provider injection supports OpenAI-compatible (chat completions) providers so far; ${provider.label} speaks ${provider.wireProtocol}.`,
    };
  }
  if (!secret) return { env: base, byok: true, error: `${provider.label} has no key saved.` };
  if (provider.models.length === 0) return { env: base, byok: true, error: `${provider.label} lists no models for OpenCode.` };

  const providerKey = `unskilled-${provider.id}`;
  const keyVar = providerKeyVar(provider.id);
  const hasHeaders = Boolean(provider.headers && Object.keys(provider.headers).length > 0);
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${providerKey}/${provider.models[0]!.id}`,
    provider: {
      [providerKey]: {
        npm: "@ai-sdk/openai-compatible",
        name: provider.label,
        options: {
          baseURL: provider.baseURL,
          apiKey: `{env:${keyVar}}`,
          ...(hasHeaders ? { headers: provider.headers } : {}),
        },
        models: catalogFor(provider).opencode.models,
      },
    },
  };
  const env: InjectedEnv = { ...base, ...provider.env, [keyVar]: secret, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
  return { env, files: [], byok: true };
}

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

const versionCache = new Map<string, string>();

/**
 * `opencode --version`, cached per command since it never changes for a given
 * binary. Only a successful answer is cached: a slow cold start (e.g. under
 * load) returns null this once and is asked again next time, rather than
 * disabling injection until the app restarts.
 */
export function opencodeVersion(command: string): string | null {
  const cached = versionCache.get(command);
  if (cached !== undefined) return cached;
  try {
    const version = execCommandSync(command, ["--version"], { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (version) versionCache.set(command, version);
    return version || null;
  } catch {
    return null; // Not installed, not executable, too slow, or no --version: reported as unknown.
  }
}
