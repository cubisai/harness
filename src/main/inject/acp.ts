// The generic ACP injector. ACP's `initialize`/`session/new` have no field for
// handing the agent a provider credential (session/new's env belongs to stdio
// MCP servers), so the spawn env is the only injection point. The key sits in
// the child's environment (on Linux readable via /proc/<pid>/environ); never log
// the env object.

import type { Provider, WireProtocol } from "../../shared/types";
import { protocolKeyVar } from "./keys";
import type { InjectedEnv, InjectionPlan } from ".";

/** Base-URL variables by wire protocol, set alongside the key for agents we can't confirm. */
const BASE_URL_VARS: Partial<Record<WireProtocol, string>> = {
  "anthropic-messages": "ANTHROPIC_BASE_URL",
  "openai-chat": "OPENAI_BASE_URL",
  "openai-responses": "OPENAI_BASE_URL",
  gemini: "GOOGLE_GEMINI_BASE_URL",
};

/**
 * The spawn-env plan for one ACP agent turn. A known preset gets its documented
 * key variable; an unknown one gets its protocol's conventional variable (and
 * base URL) with a notice, since we can't confirm it reads it.
 */
export function injectAcp(agent: { label: string; keyVar?: string; providerEnvOnly?: boolean }, provider: Provider, secret: string | null, base: InjectedEnv): InjectionPlan {
  // An agent whose provider setting isn't verified yet only gets the
  // provider's own env; the turn still runs.
  if (agent.providerEnvOnly) {
    return {
      env: { ...base, ...provider.env },
      files: [],
      byok: true,
      warning: `${agent.label}'s provider setting isn't verified yet (spike S6), so only the provider's own env reaches it.`,
    };
  }
  if (!secret) return { env: base, byok: true, error: `${provider.label} has no key saved.` };

  const known = agent.keyVar;
  const keyVar = known ?? protocolKeyVar(provider);
  if (keyVar === null) {
    return {
      env: { ...base, ...provider.env },
      files: [],
      byok: true,
      warning: `${agent.label} has no known key variable for ${provider.wireProtocol} providers, so only the provider's own env reaches it.`,
    };
  }
  const baseVar = known === undefined ? BASE_URL_VARS[provider.wireProtocol] : undefined;
  const warning =
    known === undefined
      ? `${agent.label} doesn't document which variable it reads a provider key from; it's passed as ${keyVar}${baseVar ? ` with ${baseVar}` : ""}, and may not reach it.`
      : undefined;
  const env: InjectedEnv = { ...base, ...provider.env, [keyVar]: secret };
  if (baseVar) env[baseVar] = provider.baseURL;
  return { env, files: [], byok: true, ...(warning ? { warning } : {}) };
}
