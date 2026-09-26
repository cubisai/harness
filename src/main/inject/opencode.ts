// OpenCode's injector: `opencode acp` reads its whole provider config from the
// OPENCODE_CONFIG_CONTENT env var and the key from its own env var, referenced
// there as `{env:VAR}`, so nothing is written anywhere. The key lives only in
// the child process environment (and on Linux is readable via /proc/<pid>/environ
// by processes that may read it); never log the env object.

import { execFileSync } from "node:child_process";
import type { Provider } from "../../shared/types";
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
    const version = execFileSync(command, ["--version"], { timeout: 30_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (version) versionCache.set(command, version);
    return version || null;
  } catch {
    return null; // Not installed, not executable, too slow, or no --version: reported as unknown.
  }
}
