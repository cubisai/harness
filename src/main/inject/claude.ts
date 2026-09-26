// Claude's injector: the environment Claude Code reads, and the stale-settings
// warning that a project or user settings file can still override it with.

import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import type { Provider } from "../../shared/types";
import { providerWarning } from "../../shared/provider-rules";
import { catalogFor } from "../providers";
import type { InjectedEnv, InjectionPlan } from ".";

/** The variables Claude reads its endpoint and key from; stripped from every plan before injection. */
export const CLAUDE_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];

const STRIP_BETA_WARNING =
  "Stripping experimental headers also turns off MCP tool search, so every MCP tool is loaded up front.";

/** The hostname a provider points Claude at, or null when the URL won't parse. */
function hostOf(baseURL: string): string | null {
  try {
    return new URL(baseURL).hostname;
  } catch {
    return null;
  }
}

/**
 * The environment for one Claude turn on a BYOK provider: the endpoint, the
 * key (as X-Api-Key on api.anthropic.com, Bearer everywhere else), the first
 * model's wire id, and the provider's own env and headers.
 */
export function injectClaude(provider: Provider, secret: string | null, base: InjectedEnv): InjectionPlan {
  if (provider.wireProtocol !== "anthropic-messages") {
    return {
      env: base,
      byok: true,
      error: `Claude needs an Anthropic Messages provider; ${provider.label} speaks ${provider.wireProtocol}.`,
    };
  }
  if (!secret) return { env: base, byok: true, error: `${provider.label} has no key saved.` };

  const env: InjectedEnv = { ...base, ...catalogFor(provider).claude.env, ANTHROPIC_BASE_URL: provider.baseURL };
  // Exactly one of the two key variables, whatever the provider's own env set.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (hostOf(provider.baseURL) === "api.anthropic.com") env.ANTHROPIC_API_KEY = secret;
  else env.ANTHROPIC_AUTH_TOKEN = secret; // a gateway takes Bearer, not X-Api-Key

  const first = provider.models[0];
  if (first) env.ANTHROPIC_MODEL = first.modelID ?? first.id;
  if (provider.headers && Object.keys(provider.headers).length > 0) {
    env.ANTHROPIC_CUSTOM_HEADERS = Object.entries(provider.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  }

  const warnings: string[] = [];
  const remote = providerWarning(provider, "claude");
  if (remote) warnings.push(remote);
  if (provider.betaHeaders === "strip") {
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
    warnings.push(STRIP_BETA_WARNING);
  }

  return { env, byok: true, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
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
