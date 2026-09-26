// Codex's injector: `codex app-server` takes its endpoint and key as `-c`
// config overrides and a generated model catalog, so nothing is written to
// $CODEX_HOME. The key travels only in the spawn env, never in argv.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Provider } from "../../shared/types";
import { codexCompatible } from "../../shared/provider-rules";
import { catalogFor } from "../providers";
import { providerKeyVar } from "./keys";
import type { InjectedEnv, InjectionPlan } from ".";

/** The env var a Codex provider's key is passed in. */
export function codexKeyVar(providerId: string): string {
  return providerKeyVar(providerId);
}

/** A TOML basic string; JSON.stringify of a JS string is valid for our inputs. */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

/** The `model_providers.<id>={…}` inline table for one provider. */
function providerTable(provider: Provider, providerId: string, keyVar: string): string {
  const fields = [
    `name=${tomlString(provider.label)}`,
    `base_url=${tomlString(provider.baseURL)}`,
    `env_key=${tomlString(keyVar)}`,
    `wire_api="responses"`,
  ];
  if (provider.headers && Object.keys(provider.headers).length > 0) {
    fields.push(`http_headers={ ${Object.entries(provider.headers).map(([k, v]) => `${tomlString(k)}=${tomlString(v)}`).join(", ")} }`);
  }
  if (provider.queryParams && Object.keys(provider.queryParams).length > 0) {
    fields.push(`query_params={ ${Object.entries(provider.queryParams).map(([k, v]) => `${tomlString(k)}=${tomlString(v)}`).join(", ")} }`);
  }
  if (provider.retries?.request !== undefined) fields.push(`request_max_retries=${provider.retries.request}`);
  if (provider.retries?.stream !== undefined) fields.push(`stream_max_retries=${provider.retries.stream}`);
  if (provider.retries?.streamIdleTimeoutMs !== undefined) fields.push(`stream_idle_timeout_ms=${provider.retries.streamIdleTimeoutMs}`);
  return `model_providers.${providerId}={ ${fields.join(", ")} }`;
}

/**
 * The plan for one Codex turn on a BYOK provider: the endpoint as `-c`
 * overrides, the key in the env, and a model catalog written under the app's
 * data folder (the caller writes it via prepareCodexPlan).
 */
export function injectCodex(
  provider: Provider,
  secret: string | null,
  base: InjectedEnv,
  opts: { catalogDir: string; instructions: string },
): InjectionPlan {
  const compatible = codexCompatible(provider);
  if (!compatible.ok) return { env: base, byok: true, error: compatible.reason };
  if (!secret) return { env: base, byok: true, error: `${provider.label} has no key saved.` };
  if (provider.models.length === 0) return { env: base, byok: true, error: `${provider.label} lists no models for Codex.` };

  const keyVar = codexKeyVar(provider.id);
  const env: InjectedEnv = { ...base, ...provider.env, [keyVar]: secret };
  const providerId = `unskilled-${provider.id}`;
  const catalogPath = join(opts.catalogDir, `unskilled-${provider.id}.json`);
  const models = catalogFor(provider).codex.models;
  const catalog = {
    models: models.map((m) => ({ ...m, base_instructions: opts.instructions })),
  };
  const args = [
    "-c", `model_provider=${tomlString(providerId)}`,
    "-c", `model=${tomlString(String(models[0]!.slug))}`,
    "-c", `model_catalog_json=${tomlString(catalogPath)}`,
    "-c", providerTable(provider, providerId, keyVar),
  ];
  return { env, args, files: [{ path: catalogPath, contents: JSON.stringify(catalog, null, 2) }], byok: true };
}

/** The system prompt the catalog entries carry when Codex's own can't be read. */
export const FALLBACK_INSTRUCTIONS =
  "You are Codex, a coding agent. Work in the user's repository with the tools you are given, keep changes focused, and report what you changed and how you verified it.";

const instructionsCache = new Map<string, string>();

/**
 * Codex's own base instructions, read from `codex debug models`; cached per
 * command, since it never changes for a given binary. Falls back on any error,
 * and only a real answer is cached, so a slow cold start is retried next time.
 */
export function codexInstructions(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const cached = instructionsCache.get(command);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync(command, ["debug", "models"], { env, timeout: 30_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const parsed = JSON.parse(out) as { models?: { visibility?: string; base_instructions?: string }[] };
    const found = parsed.models?.find((m) => m.visibility === "list" && m.base_instructions);
    if (found?.base_instructions) {
      instructionsCache.set(command, found.base_instructions);
      return found.base_instructions;
    }
  } catch {
    // An installed Codex that won't answer: the fallback prompt is still valid.
  }
  return FALLBACK_INSTRUCTIONS;
}

/** Whether Codex accepts the generated catalog; null on success, else the reason. */
export function validateCodexCatalog(command: string, catalogPath: string, env: NodeJS.ProcessEnv): string | null {
  try {
    execFileSync(command, ["debug", "models", "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`], {
      env,
      timeout: 20_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return null;
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr ? e.stderr.toString("utf8") : "";
    const last = stderr
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    return `Codex rejected the generated model catalog: ${last ?? e.message ?? "unknown failure"}`;
  }
}

/**
 * Write a plan's catalog files and have Codex validate the catalog, mutating
 * and returning the same plan (so its sealed toJSON stays attached).
 */
export function prepareCodexPlan(plan: InjectionPlan, command: string): InjectionPlan {
  if (plan.error || !plan.files?.length) return plan;
  try {
    for (const file of plan.files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.contents);
    }
  } catch (err) {
    plan.error = `Couldn't write the Codex model catalog: ${err instanceof Error ? err.message : String(err)}`;
    return plan;
  }
  const invalid = validateCodexCatalog(command, plan.files[0]!.path, plan.env);
  if (invalid) plan.error = invalid;
  return plan;
}
