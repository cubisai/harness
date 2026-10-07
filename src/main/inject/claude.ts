// Claude's injector: the environment Claude Code reads, and the stale-settings
// warning that a project or user settings file can still override it with.

import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import type { Provider } from "../../shared/types";
import { PROVIDER_MODEL_PREFIX, anthropicAuthStyle, providerWarning } from "../../shared/provider-rules";
import { catalogFor, wireIdOf } from "../providers";
import { headerPlan, resolvedHeaders } from "./headers";
import type { InjectedEnv, InjectionPlan } from ".";

/** The variables Claude reads its endpoint and key from; stripped from every plan before injection. */
export const CLAUDE_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];

const STRIP_BETA_WARNING =
  "Stripping experimental headers also turns off MCP tool search, so every MCP tool is loaded up front.";

/** The wire id of the provider model a thread's `unskilled-<provider>/<model>` id names, or undefined. */
function pinnedWireId(provider: Provider, model: string | undefined): string | undefined {
  const prefix = `${PROVIDER_MODEL_PREFIX}${provider.id}/`;
  if (!model?.startsWith(prefix)) return undefined;
  const id = model.slice(prefix.length);
  const found = provider.models.find((m) => m.id === id);
  return found ? wireIdOf(found, found.id) : id;
}

/**
 * The environment for one Claude turn on a BYOK provider: the endpoint, the
 * key (by the provider's auth style: X-Api-Key on api.anthropic.com and Bearer
 * elsewhere unless chosen), the first model's wire id, the small/fast model,
 * and the provider's own env and headers (secret ones decrypted by the caller).
 * A chat-completions provider goes through the translation gateway instead:
 * Claude gets the gateway's route and token, and the key and headers stay in main.
 */
export function injectClaude(
  provider: Provider,
  secret: string | null,
  base: InjectedEnv,
  opts: { secretHeaders?: Record<string, string>; gateway?: { url: string; token: string }; model?: string } = {},
): InjectionPlan {
  const gateway = provider.wireProtocol === "openai-chat";
  if (provider.wireProtocol !== "anthropic-messages" && !gateway) {
    return {
      env: base,
      byok: true,
      error: `Claude takes an Anthropic Messages provider, or a chat-completions one through CubiQ's gateway; ${provider.label} speaks ${provider.wireProtocol}.`,
    };
  }
  if (!secret) return { env: base, byok: true, error: `${provider.label} has no key saved.` };
  if (gateway && !opts.gateway) return { env: base, byok: true, error: `CubiQ's gateway for ${provider.label} isn't running; try again.` };

  const env: InjectedEnv = { ...base, ...catalogFor(provider).claude.env, ANTHROPIC_BASE_URL: gateway ? `${opts.gateway!.url}/${provider.id}` : provider.baseURL };
  // Exactly one of the two key variables, whatever the provider's own env set.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (gateway) env.ANTHROPIC_AUTH_TOKEN = opts.gateway!.token;
  else if (anthropicAuthStyle(provider) === "x-api-key") env.ANTHROPIC_API_KEY = secret;
  else env.ANTHROPIC_AUTH_TOKEN = secret; // sent as Authorization: Bearer

  const pinned = pinnedWireId(provider, opts.model);
  const first = provider.models[0];
  if (pinned) env.ANTHROPIC_MODEL = pinned;
  else if (first) env.ANTHROPIC_MODEL = first.modelID ?? first.id;
  // Background work (titles, summaries) goes to the cheap model; the haiku slot follows it unless pinned.
  const small = provider.models.find((m) => m.id === provider.smallModel);
  if (small) {
    env.ANTHROPIC_SMALL_FAST_MODEL = wireIdOf(small, small.id);
    if (!provider.models.some((m) => m.alias === "haiku")) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = wireIdOf(small, small.id);
  }
  // Through the gateway, main adds the provider's headers itself.
  const headers = gateway ? {} : resolvedHeaders(headerPlan(provider, opts.secretHeaders), base);
  if (Object.keys(headers).length > 0) {
    env.ANTHROPIC_CUSTOM_HEADERS = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  }

  const warnings: string[] = [];
  const remote = providerWarning(provider, "claude");
  if (remote) warnings.push(remote);
  // The gateway never forwards beta headers, so there is nothing to strip.
  if (provider.betaHeaders === "strip" && !gateway) {
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
    warnings.push(STRIP_BETA_WARNING);
  }

  return { env, byok: true, ...(pinned ? { model: pinned } : {}), ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
}

/** Which settings sources pin an Anthropic key or base URL, by path where there is one. */
export function staleKeySources(
  sources: { source: string; settings: { env?: Record<string, string> }; path?: string }[],
): string[] {
  const stale: string[] = [];
  for (const entry of sources) {
    const env = entry.settings.env;
    if (env && CLAUDE_KEY_VARS.some((name) => name in env)) stale.push(entry.path ?? entry.source);
  }
  return stale;
}

/** The notice for a cwd whose Claude settings would override the injected provider, or null. */
export async function staleKeyNotice(cwd: string): Promise<string | null> {
  let list: string[];
  try {
    list = staleKeySources((await resolveSettings({ cwd })).sources);
  } catch {
    return null; // an unreadable or unread settings cascade is not worth failing a turn over
  }
  if (!list.length) return null;
  return `Claude settings in ${list.join(", ")} set an Anthropic key or base URL, which overrides the provider you picked here.`;
}
