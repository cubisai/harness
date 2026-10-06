import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialChoice, Provider, Settings } from "../src/shared/types";
import { type InjectionPlan, type InjectionSource, injectionFor } from "../src/main/inject";
import { opencodePackage, parseOpenCodeVariants, withOpenCodeVariant } from "../src/main/inject/opencode";

const KEY = "test-opencode-key";
const VERSION = "1.18.32";

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: "gw",
    label: "GW",
    wireProtocol: "openai-chat",
    baseURL: "https://gw.example.com/v1",
    secret: { kind: "safeStorage", ciphertext: "x" },
    headers: { "X-A": "1" },
    models: [
      {
        id: "picked",
        modelID: "vendor/wire-1",
        name: "Picked",
        capabilities: { tools: true, vision: true, reasoning: false },
        contextWindow: 128_000,
        maxOutput: 8_192,
      },
      { id: "plain", capabilities: { tools: false, vision: false, reasoning: false }, contextWindow: 8_000, maxOutput: 1_024 },
    ],
    ...patch,
  };
}

function settings(): Settings {
  return { theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providerInjection: {} };
}

/** A fake settings surface: no disk, no SettingsStore. */
function source(opts: { providers?: Provider[]; choice?: CredentialChoice; secret?: string | null; providerSecretHeaders?: Record<string, string> } = {}): InjectionSource {
  const providers = opts.providers ?? [provider()];
  return {
    credential: () => opts.choice ?? { kind: "byok", providerId: providers[0]!.id },
    providers: () => providers,
    providerSecret: () => (opts.secret === undefined ? KEY : opts.secret),
    providerSecretHeaders: () => opts.providerSecretHeaders ?? {},
    secretEnvNames: () => [],
    get: () => settings(),
  };
}

const opts = (version: string | null = VERSION) => ({ injector: "opencode" as const, opencodeVersion: () => version });

/** The default plan the read-only assertions share. */
function lead(version: string | null = VERSION) {
  return injectionFor(source(), "opencode", process.env, opts(version));
}

describe("injectOpenCode", () => {
  it("puts the key in the spawn env and writes no files", () => {
    const plan = lead();
    expect(plan.error).toBeUndefined();
    expect(plan.env.UNSKILLED_GW_KEY).toBe(KEY);
    expect(plan.env.PATH).toBe(process.env.PATH);
    expect(plan.files).toEqual([]);
    expect(plan.args).toBeUndefined();
  });

  it("builds a v1 config with the picked model and per-model wire ids", () => {
    const config = JSON.parse(lead().env.OPENCODE_CONFIG_CONTENT!) as {
      model: string;
      small_model: string;
      enabled_providers: string[];
      provider: Record<string, { npm: string; name: string; options: { baseURL: string; apiKey: string; headers?: Record<string, string> }; models: Record<string, { id?: string; tool_call: boolean }> }>;
    };
    expect(config.model).toBe("unskilled-gw/picked");
    expect(config.small_model).toBe("unskilled-gw/picked");
    expect(config.enabled_providers).toEqual(["unskilled-gw"]);
    const injected = config.provider["unskilled-gw"]!;
    expect(injected.npm).toBe("@ai-sdk/openai-compatible");
    expect(injected.name).toBe("GW");
    expect(injected.options.baseURL).toBe("https://gw.example.com/v1");
    expect(injected.options.apiKey).toBe("{env:UNSKILLED_GW_KEY}");
    expect(injected.options.headers).toEqual({ "X-A": "1" });
    expect(injected.models.picked!.id).toBe("vendor/wire-1");
    expect(injected.models.picked!.tool_call).toBe(true);
    expect(injected.models.plain!.id).toBeUndefined();
    expect(injected.models.plain!.tool_call).toBe(false);
    for (const model of Object.values(injected.models)) expect(model).not.toHaveProperty("capabilities");
    for (const model of provider().models) expect(injected.models).toHaveProperty(model.id);
  });

  it("never puts the key in the config or a serialized plan", () => {
    const plan = lead();
    expect(plan.env.OPENCODE_CONFIG_CONTENT).not.toContain(KEY);
    expect(JSON.stringify(plan)).not.toContain(KEY);
  });

  it("errors for a config version it wasn't verified against", () => {
    expect(lead("2.0.1").error).toMatch(/1\.x only/);
    expect(lead(null).error).toMatch(/version unknown/);
  });

  it("errors for a missing key and no models", () => {
    const noKey = injectionFor(source({ secret: null }), "opencode", process.env, opts());
    expect(noKey.error).toMatch(/no key saved/);
    const noModels = injectionFor(source({ providers: [provider({ models: [] })] }), "opencode", process.env, opts());
    expect(noModels.error).toMatch(/no models/);
  });

  it("injects every wire protocol without error", () => {
    for (const wireProtocol of ["openai-chat", "openai-responses", "anthropic-messages", "gemini"] as const) {
      const plan = injectionFor(source({ providers: [provider({ wireProtocol })] }), "opencode", process.env, opts());
      expect(plan.error, wireProtocol).toBeUndefined();
    }
  });

  it("adds a bearer Authorization for Anthropic on a non-Anthropic host, unless x-api-key is chosen", () => {
    const plan = injectionFor(source({ providers: [provider({ wireProtocol: "anthropic-messages", baseURL: "https://gw.example.com" })] }), "opencode", process.env, opts());
    const config = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT!) as { provider: Record<string, { options: { headers: Record<string, string> } }> };
    expect(config.provider["unskilled-gw"]!.options.headers.Authorization).toBe("Bearer {env:UNSKILLED_GW_KEY}");
    const chosen = injectionFor(source({ providers: [provider({ wireProtocol: "anthropic-messages", baseURL: "https://gw.example.com", authStyle: "x-api-key" })] }), "opencode", process.env, opts());
    const chosenConfig = JSON.parse(chosen.env.OPENCODE_CONFIG_CONTENT!) as { provider: Record<string, { options: { headers: Record<string, string> } }> };
    expect(chosenConfig.provider["unskilled-gw"]!.options.headers.Authorization).toBeUndefined();
  });

  it("turns an env-ref header into an {env:} ref and keeps a secret header's value out of the config", () => {
    const secretValue = "super-secret-header-value";
    const plan = injectionFor(
      source({ providers: [provider({ headers: { "X-A": "${env:FOO}", "X-Secret": "plain" } })], providerSecretHeaders: { "X-Secret": secretValue } }),
      "opencode",
      process.env,
      opts(),
    );
    const config = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT!) as { provider: Record<string, { options: { headers: Record<string, string> } }> };
    const headers = config.provider["unskilled-gw"]!.options.headers;
    expect(headers["X-A"]).toBe("{env:FOO}");
    expect(headers["X-Secret"]).toBe("{env:UNSKILLED_GW_HEADER_1}");
    expect(plan.env.UNSKILLED_GW_HEADER_1).toBe(secretValue);
    expect(plan.env.OPENCODE_CONFIG_CONTENT).not.toContain(secretValue);
    expect(JSON.stringify(plan)).not.toContain(secretValue);
  });

  it("uses provider.smallModel when it names one of the models, else falls back to model", () => {
    const named = injectionFor(source({ providers: [provider({ smallModel: "plain" })] }), "opencode", process.env, opts());
    const namedConfig = JSON.parse(named.env.OPENCODE_CONFIG_CONTENT!) as { model: string; small_model: string };
    expect(namedConfig.model).toBe("unskilled-gw/picked");
    expect(namedConfig.small_model).toBe("unskilled-gw/plain");
    const unknown = injectionFor(source({ providers: [provider({ smallModel: "nope" })] }), "opencode", process.env, opts());
    const unknownConfig = JSON.parse(unknown.env.OPENCODE_CONFIG_CONTENT!) as { model: string; small_model: string };
    expect(unknownConfig.small_model).toBe("unskilled-gw/picked");
  });

  it("passes queryParams to chat providers and warns for the rest", () => {
    const chat = injectionFor(source({ providers: [provider({ queryParams: { api_version: "2024-10-01" } })] }), "opencode", process.env, opts());
    expect(chat.warning).toBeUndefined();
    const chatConfig = JSON.parse(chat.env.OPENCODE_CONFIG_CONTENT!) as { provider: Record<string, { options: { queryParams?: Record<string, string> } }> };
    expect(chatConfig.provider["unskilled-gw"]!.options.queryParams).toEqual({ api_version: "2024-10-01" });

    const responses = injectionFor(source({ providers: [provider({ wireProtocol: "openai-responses", queryParams: { api_version: "2024-10-01" } })] }), "opencode", process.env, opts());
    expect(responses.warning).toMatch(/query parameters only to chat-completions providers/);
    const responsesConfig = JSON.parse(responses.env.OPENCODE_CONFIG_CONTENT!) as { provider: Record<string, { options: { queryParams?: unknown } }> };
    expect(responsesConfig.provider["unskilled-gw"]!.options.queryParams).toBeUndefined();
  });

  it("stays inert on a subscription", () => {
    const plan = injectionFor(source({ choice: { kind: "subscription" } }), "opencode", { PATH: "/usr/bin", HOME: "/home/x" }, opts());
    expect(plan.byok).toBe(false);
    expect(Object.keys(plan.env).some((name) => name.startsWith("UNSKILLED_"))).toBe(false);
    expect(plan.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });
});

describe("opencodePackage", () => {
  it("picks the AI-SDK package and base URL per protocol", () => {
    expect(opencodePackage(provider({ wireProtocol: "openai-chat", baseURL: "https://gw.example.com/v1" }))).toEqual({ npm: "@ai-sdk/openai-compatible", baseURL: "https://gw.example.com/v1" });
    expect(opencodePackage(provider({ wireProtocol: "openai-responses", baseURL: "https://gw.example.com/v1" }))).toEqual({ npm: "@ai-sdk/openai", baseURL: "https://gw.example.com/v1" });
    expect(opencodePackage(provider({ wireProtocol: "anthropic-messages", baseURL: "https://gw.example.com" }))).toEqual({ npm: "@ai-sdk/anthropic", baseURL: "https://gw.example.com/v1" });
    expect(opencodePackage(provider({ wireProtocol: "gemini", baseURL: "https://gw.example.com" }))).toEqual({ npm: "@ai-sdk/google", baseURL: "https://gw.example.com/v1beta" });
  });

  it("doesn't double /v1 for Anthropic or /v1beta for Gemini", () => {
    expect(opencodePackage(provider({ wireProtocol: "anthropic-messages", baseURL: "https://gw.example.com/v1" })).baseURL).toBe("https://gw.example.com/v1");
    expect(opencodePackage(provider({ wireProtocol: "gemini", baseURL: "https://gw.example.com/v1beta" })).baseURL).toBe("https://gw.example.com/v1beta");
  });

  it("strips trailing slashes in auto mode, and leaves a raw URL exactly as typed", () => {
    expect(opencodePackage(provider({ baseURL: "https://gw.example.com/v1///" })).baseURL).toBe("https://gw.example.com/v1");
    for (const wireProtocol of ["openai-chat", "openai-responses", "anthropic-messages", "gemini"] as const) {
      expect(opencodePackage(provider({ wireProtocol, baseURL: "https://gw.example.com/custom/", pathMode: "raw" })).baseURL).toBe("https://gw.example.com/custom/");
    }
  });
});

describe("parseOpenCodeVariants", () => {
  const fixture = readFileSync(join(__dirname, "fixtures", "opencode-models.txt"), "utf8");

  it("maps model ids with variants and skips the rest", () => {
    expect(parseOpenCodeVariants(fixture)).toEqual({
      "opencode/space-bunny-free": ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("handles CRLF line endings", () => {
    expect(parseOpenCodeVariants(fixture.replace(/\n/g, "\r\n"))).toEqual({
      "opencode/space-bunny-free": ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("ignores log lines and blank input", () => {
    expect(parseOpenCodeVariants("just a log line\n\nnot/a/model id\n")).toEqual({});
  });
});

describe("withOpenCodeVariant", () => {
  const pick = { agent: "build", model: "opencode/space-bunny-free", variant: "high" };

  it("creates a plan and config when none exists", () => {
    const out = withOpenCodeVariant(undefined, pick, { PATH: "/usr/bin" });
    expect(out.byok).toBe(false);
    expect(out.env.PATH).toBe("/usr/bin");
    expect(JSON.parse(out.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      agent: { build: { model: pick.model, variant: "high" } },
    });
  });

  it("preserves provider and plugin keys", () => {
    const plan: InjectionPlan = {
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { gw: { npm: "@ai-sdk/openai-compatible" } }, plugin: ["file:///guard.mjs"] }) },
      byok: true,
    };
    const out = withOpenCodeVariant(plan, pick);
    expect(out).toBe(plan);
    const config = JSON.parse(out.env.OPENCODE_CONFIG_CONTENT!) as { $schema: string; provider: unknown; plugin: string[]; agent: Record<string, unknown> };
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(config.provider).toEqual({ gw: { npm: "@ai-sdk/openai-compatible" } });
    expect(config.plugin).toEqual(["file:///guard.mjs"]);
    expect(config.agent.build).toEqual({ model: pick.model, variant: "high" });
  });

  it("keeps the other fields of an existing agent entry", () => {
    const plan: InjectionPlan = {
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { build: { temperature: 0.2, description: "keep me" } } }) },
      byok: true,
    };
    withOpenCodeVariant(plan, pick);
    const config = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT!) as { agent: Record<string, Record<string, unknown>> };
    expect(config.agent.build).toEqual({ temperature: 0.2, description: "keep me", model: pick.model, variant: "high" });
  });
});

describe("opencodeVersion", () => {
  it.skipIf(process.platform === "win32")("doesn't cache a failed lookup", async () => {
    const { opencodeVersion } = await import("../src/main/inject/opencode");
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "oc-ver-"));
    const bin = join(dir, "fake-opencode");
    writeFileSync(bin, "#!/bin/sh\nexit 1\n");
    chmodSync(bin, 0o755);
    expect(opencodeVersion(bin)).toBeNull();
    writeFileSync(bin, "#!/bin/sh\necho 1.2.3\n");
    expect(opencodeVersion(bin)).toBe("1.2.3");
  });
});
