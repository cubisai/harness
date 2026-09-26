// The per-agent credential injection contract. A driver never reads a key
// itself: it asks for a plan and applies it (env, argv, files), so the same
// rules decide what every agent inherits and what it never sees.

import type { CredentialChoice, Provider, Settings } from "../../shared/types";
import { redactSecrets } from "./redact";
import { CLAUDE_KEY_VARS, injectClaude } from "./claude";
import { FALLBACK_INSTRUCTIONS, injectCodex } from "./codex";
import { injectOpenCode } from "./opencode";

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
  byok: boolean;
}

/** The read-only settings surface an injection plan is built from. */
export interface InjectionSource {
  credential(agentId: string): CredentialChoice;
  providers(): Provider[];
  providerSecret(id: string): string | null;
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

/** A deep copy with every string redacted, so a plan can be logged safely. */
function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, secrets);
    return out;
  }
  return value;
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
  opts: { codexCatalogDir?: string; codexInstructions?: () => string; opencodeVersion?: () => string | null } = {},
): InjectionPlan {
  const base = strippedBase(source, env);
  const choice = source.credential(agentId);
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
  if (agentId === "claude") {
    const secret = source.providerSecret(provider.id);
    return sealed(injectClaude(provider, secret, base), secret ? [secret] : []);
  }
  if (agentId === "codex") {
    const secret = source.providerSecret(provider.id);
    if (!opts.codexCatalogDir) {
      return sealed({ env: base, byok: true, error: "Codex BYOK needs the app data folder." }, secret ? [secret] : []);
    }
    return sealed(
      injectCodex(provider, secret, base, {
        catalogDir: opts.codexCatalogDir,
        instructions: opts.codexInstructions?.() ?? FALLBACK_INSTRUCTIONS,
      }),
      secret ? [secret] : [],
    );
  }
  if (agentId === "opencode") {
    const secret = source.providerSecret(provider.id);
    return sealed(injectOpenCode(provider, secret, base, { version: opts.opencodeVersion?.() ?? null }), secret ? [secret] : []);
  }
  // TODO(phase 2 step E): the generic ACP injector.
  return sealed({ env: base, byok: true }, []);
}
