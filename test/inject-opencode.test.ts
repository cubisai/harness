import { describe, expect, it } from "vitest";
import type { CredentialChoice, Provider, Settings } from "../src/shared/types";
import { type InjectionSource, injectionFor } from "../src/main/inject";

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
function source(opts: { providers?: Provider[]; choice?: CredentialChoice; secret?: string | null } = {}): InjectionSource {
  const providers = opts.providers ?? [provider()];
  return {
    credential: () => opts.choice ?? { kind: "byok", providerId: providers[0]!.id },
    providers: () => providers,
    providerSecret: () => (opts.secret === undefined ? KEY : opts.secret),
    secretEnvNames: () => [],
    get: () => settings(),
  };
}

const opts = (version: string | null = VERSION) => ({ opencodeVersion: () => version });

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
      provider: Record<string, { npm: string; name: string; options: { baseURL: string; apiKey: string; headers?: Record<string, string> }; models: Record<string, { id?: string; tool_call: boolean }> }>;
    };
    expect(config.model).toBe("unskilled-gw/picked");
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

  it("errors for a non chat-completions provider, a missing key, and no models", () => {
    const anthropic = injectionFor(source({ providers: [provider({ wireProtocol: "anthropic-messages" })] }), "opencode", process.env, opts());
    expect(anthropic.error).toMatch(/OpenAI-compatible/);
    const noKey = injectionFor(source({ secret: null }), "opencode", process.env, opts());
    expect(noKey.error).toMatch(/no key saved/);
    const noModels = injectionFor(source({ providers: [provider({ models: [] })] }), "opencode", process.env, opts());
    expect(noModels.error).toMatch(/no models/);
  });

  it("stays inert on a subscription", () => {
    const plan = injectionFor(source({ choice: { kind: "subscription" } }), "opencode", { PATH: "/usr/bin", HOME: "/home/x" }, opts());
    expect(plan.byok).toBe(false);
    expect(Object.keys(plan.env).some((name) => name.startsWith("UNSKILLED_"))).toBe(false);
    expect(plan.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });
});
