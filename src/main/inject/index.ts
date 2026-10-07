// The per-agent credential injection contract. A driver never reads a key
// itself: it asks for a plan and applies it (env, argv, files), so the same
// rules decide what every agent inherits and what it never sees.

import type { CredentialChoice, ModelPricing, Provider, Settings } from "../../shared/types";
import { redactDeep } from "./redact";
import { injectAcp } from "./acp";
import { CLAUDE_KEY_VARS, injectClaude } from "./claude";
import { FALLBACK_INSTRUCTIONS, injectCodex } from "./codex";
import { injectOpenCode } from "./opencode";

/** The variables a child process is handed. `Options.env` replaces, never merges. */
export type InjectedEnv = Record<string, string>;

/** Which credential injector a driver uses; data (a preset field), never the agent id. */
export type InjectorKind = "claude" | "codex" | "opencode" | "acp";

export interface InjectionPlan {
  /** The child's complete environment: a copy of ours with the key vars replaced. */
  env: InjectedEnv;
  /** Extra command-line arguments for drivers started as a process. */
  args?: string[];
  /** Files the caller writes before the agent starts (outside the project cwd only). */
  files?: { path: string; contents: string }[];
  /** Feature-loss text, shown as a notice. The turn still runs. */
  warning?: string;
  /** Injection is impossible (e.g. the provider has no key): the caller errors and does not start the agent. */
  error?: string;
  /** The id the agent runs a pinned provider model as (its wire id), in place of the thread's `unskilled-<provider>/<model>`. */
  model?: string;
  /** A pinned provider model's prices; null when unknown, so the turn shows no cost rather than the agent's guess. */
  pricing?: ModelPricing | null;
  byok: boolean;
}

/** The read-only settings surface an injection plan is built from. */
export interface InjectionSource {
  credential(agentId: string): CredentialChoice;
  providers(): Provider[];
  providerSecret(id: string): string | null;
  /** The provider's secret headers, decrypted (name → value); none when it has no such headers. */
  providerSecretHeaders?(id: string): Record<string, string>;
  secretEnvNames(): string[];
  get(): Settings;
}

/** Drivers that write files outside the app data folder (none today); BYOK for them is gated by Settings.providerInjection. */
export const GATED_DRIVERS = new Set<string>();

export { CLAUDE_KEY_VARS };

/** A copy of `env` with undefined values dropped and every name in stripNames removed. */
export function baseEnv(stripNames: readonly string[], env: NodeJS.ProcessEnv = process.env): InjectedEnv {
  const strip = new Set(stripNames);
  const out: InjectedEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || strip.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Make a plan safe to stringify: a non-enumerable toJSON returns a redacted
 * copy, so JSON.stringify(plan) never leaks a key while plan.env still has it.
 */
function sealed(plan: InjectionPlan, secrets: string[]): InjectionPlan {
  Object.defineProperty(plan, "toJSON", { value: () => redactDeep(plan, secrets), enumerable: false });
  return plan;
}

/** The environment every plan starts from: ours, minus any name a key could occupy. */
function strippedBase(source: InjectionSource, env: NodeJS.ProcessEnv): InjectedEnv {
  return baseEnv([...new Set([...source.secretEnvNames(), ...CLAUDE_KEY_VARS])], env);
}

/** What one agent gets this turn: which provider (if any) and how to reach it. */
export function injectionFor(
  source: InjectionSource,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    injector?: InjectorKind;
    codexCatalogDir?: string;
    codexInstructions?: () => string;
    opencodeVersion?: () => string | null;
    agentLabel?: string;
    keyVar?: string;
    providerEnvOnly?: boolean;
    /** A provider the thread pinned (by picking one of its models): it wins over the agent's own credential. */
    providerId?: string;
    /** The thread's model id (`unskilled-<provider>/<model>`), so the plan can name its wire id. */
    model?: string;
    /** The translation gateway (`…/llm` and its token), for providers the agent can't speak to directly. */
    gateway?: { url: string; token: string };
  } = {},
): InjectionPlan {
  const base = strippedBase(source, env);
  const choice: CredentialChoice = opts.providerId ? { kind: "byok", providerId: opts.providerId } : source.credential(agentId);
  // Subscription: the agent's own login, so no provider key — not even one the
  // shell happens to have exported.
  if (choice.kind === "subscription") return sealed({ env: base, byok: false }, []);

  const provider = source.providers().find((p) => p.id === choice.providerId);
  if (!provider) {
    return sealed({ env: base, byok: true, error: "The provider this agent uses no longer exists." }, []);
  }
  if (GATED_DRIVERS.has(agentId) && source.get().providerInjection?.[agentId] !== true) {
    return sealed({
      env: base,
      files: [],
      byok: true,
      warning: `Provider injection for ${agentId} is off, so it uses its own login. Turn it on in Settings to use ${provider.label}.`,
    }, []);
  }
  const secret = source.providerSecret(provider.id);
  const secretHeaders = source.providerSecretHeaders?.(provider.id) ?? {};
  // Everything a serialized plan must never show: the key and every secret header value.
  const secrets = [...(secret ? [secret] : []), ...Object.values(secretHeaders), ...(opts.gateway ? [opts.gateway.token] : [])];
  switch (opts.injector ?? "acp") {
    case "claude":
      return sealed(injectClaude(provider, secret, base, { secretHeaders, ...(opts.gateway && { gateway: opts.gateway }), ...(opts.model && { model: opts.model }) }), secrets);
    case "codex":
      if (!opts.codexCatalogDir) {
        return sealed({ env: base, byok: true, error: "Codex BYOK needs the app data folder." }, secrets);
      }
      return sealed(
        injectCodex(provider, secret, base, {
          catalogDir: opts.codexCatalogDir,
          instructions: opts.codexInstructions?.() ?? FALLBACK_INSTRUCTIONS,
          secretHeaders,
        }),
        secrets,
      );
    case "opencode":
      return sealed(injectOpenCode(provider, secret, base, { version: opts.opencodeVersion?.() ?? null, secretHeaders }), secrets);
    case "acp":
      return sealed(
        injectAcp({ label: opts.agentLabel ?? agentId, keyVar: opts.keyVar, providerEnvOnly: opts.providerEnvOnly }, provider, secret, base),
        secrets,
      );
  }
}
