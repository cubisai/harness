// A provider's extra headers as each injector hands them over: literal values,
// `${env:VAR}` references the agent reads from its own env, and secret values
// (decrypted in main) passed in fresh env vars so they never reach argv or a file.

import type { Provider } from "../../shared/types";
import { providerKeyVar } from "./keys";

/** A whole header value that names an env var: `${env:VAR}`. */
export const ENV_REF = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

export interface HeaderPlan {
  /** Header → literal value. */
  literal: Record<string, string>;
  /** Header → env var holding its value: the user's `${env:VAR}`, or a var made for a secret header. */
  fromEnv: Record<string, string>;
  /** Env var → secret value, to add to the agent's env. */
  secretVars: Record<string, string>;
}

/** The env var a provider's nth secret header travels in. */
export function secretHeaderVar(providerId: string, index: number): string {
  return `${providerKeyVar(providerId).replace(/_KEY$/, "")}_HEADER_${index + 1}`;
}

/** Split a provider's headers; a secret header wins over a plain one of the same name (case-insensitive). */
export function headerPlan(provider: Pick<Provider, "id" | "headers">, secretHeaders: Record<string, string> = {}): HeaderPlan {
  const plan: HeaderPlan = { literal: {}, fromEnv: {}, secretVars: {} };
  const secretNames = new Set(Object.keys(secretHeaders).map((k) => k.toLowerCase()));
  for (const [name, value] of Object.entries(provider.headers ?? {})) {
    if (secretNames.has(name.toLowerCase())) continue;
    const ref = ENV_REF.exec(value.trim());
    if (ref) plan.fromEnv[name] = ref[1]!;
    else plan.literal[name] = value;
  }
  Object.entries(secretHeaders).forEach(([name, value], i) => {
    const envVar = secretHeaderVar(provider.id, i);
    plan.fromEnv[name] = envVar;
    plan.secretVars[envVar] = value;
  });
  return plan;
}

/** Every header with its value filled in, for agents that take headers as values (and for probes). Unset env refs are left out. */
export function resolvedHeaders(plan: HeaderPlan, env: Record<string, string | undefined>): Record<string, string> {
  const out = { ...plan.literal };
  for (const [name, envVar] of Object.entries(plan.fromEnv)) {
    const value = plan.secretVars[envVar] ?? env[envVar];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
