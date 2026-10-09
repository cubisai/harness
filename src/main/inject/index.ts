// The per-agent credential injection contract. A driver never reads a key
// itself: it asks for a plan and applies it (env, argv, files), so the same
// rules decide what every agent inherits and what it never sees.

import type { CredentialChoice, ModelPricing, Provider, Settings } from "../../shared/types";
import { redactDeep } from "./redact";
import { CLAUDE_KEY_VARS } from "./claude";

/** The variables a child process is handed. `Options.env` replaces, never merges. */
export type InjectedEnv = Record<string, string>;

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

/** What one agent gets this turn: the agent's own login, never a provider key. */
export function injectionFor(source: InjectionSource, agentId: string, env: NodeJS.ProcessEnv = process.env): InjectionPlan {
  const base = strippedBase(source, env);
  // Subscription: the agent's own login, so no provider key — not even one the
  // shell happens to have exported.
  return sealed({ env: base, byok: false }, []);
}
