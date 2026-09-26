import { describe, expect, it } from "vitest";
import type { CredentialChoice, Provider, Settings } from "../src/shared/types";
import { type InjectionSource, injectionFor } from "../src/main/inject";
import { tempDir } from "./helpers";

const KEY = "test-codex-key";
const INSTRUCTIONS = "You are a test agent.";

const catalogDir = tempDir();

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: "gw",
    label: 'Gate "Way"',
    wireProtocol: "openai-responses",
    baseURL: "https://gw.example.com/v1",
    secret: { kind: "safeStorage", ciphertext: "x" },
    headers: { "X-A": "1" },
    models: [
      {
        id: "picked",
        modelID: "vendor/m-1",
        name: "M One",
        capabilities: { tools: true, vision: true, reasoning: true },
        contextWindow: 200_000,
        maxOutput: 64_000,
      },
      { id: "plain", capabilities: { tools: true, vision: false, reasoning: false }, contextWindow: 8_000, maxOutput: 1_024 },
    ],
    ...patch,
  };
}

function settings(): Settings {
  return { theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providerInjection: {} };
}

/** A fake settings surface: no disk, no SettingsStore. */
function source(opts: { providers?: Provider[]; choice?: CredentialChoice; secret?: string | null; secretEnvNames?: string[] } = {}): InjectionSource {
  const providers = opts.providers ?? [provider()];
  return {
    credential: () => opts.choice ?? { kind: "byok", providerId: providers[0]!.id },
    providers: () => providers,
    providerSecret: () => (opts.secret === undefined ? KEY : opts.secret),
    secretEnvNames: () => opts.secretEnvNames ?? [],
    get: () => settings(),
  };
}

const opts = () => ({ injector: "codex" as const, codexCatalogDir: catalogDir, codexInstructions: () => INSTRUCTIONS });

/** The default plan the read-only assertions share. */
function lead() {
  return injectionFor(source(), "codex", process.env, opts());
}

describe("injectCodex", () => {
  it("puts the key in the spawn env and strips the provider's secret vars", () => {
    const plan = injectionFor(source({ secretEnvNames: ["OPENAI_API_KEY"] }), "codex", { ...process.env, OPENAI_API_KEY: "stale-openai" }, opts());
    expect(plan.error).toBeUndefined();
    expect(plan.env.UNSKILLED_GW_KEY).toBe(KEY);
    expect(plan.env.PATH).toBe(process.env.PATH);
    expect(plan.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("points app-server at the provider through -c overrides", () => {
    const args = lead().args!;
    expect(args).toContain('model_provider="unskilled-gw"');
    expect(args).toContain('model="vendor/m-1"');
    const catalogArg = args.find((a) => a.startsWith("model_catalog_json="));
    expect(catalogArg).toBeDefined();
    expect(JSON.parse(catalogArg!.slice("model_catalog_json=".length)).startsWith(catalogDir)).toBe(true);
    const table = args.find((a) => a.startsWith("model_providers.unskilled-gw={"));
    expect(table).toContain('name="Gate \\"Way\\""');
    expect(table).toContain('env_key="UNSKILLED_GW_KEY"');
    expect(table).toContain('wire_api="responses"');
    expect(table).toContain('"X-A"="1"');
  });

  it("never puts the key in argv, a file, or a serialized plan", () => {
    const plan = lead();
    for (const arg of plan.args!) expect(arg).not.toContain(KEY);
    for (const file of plan.files!) expect(file.contents).not.toContain(KEY);
    expect(JSON.stringify(plan)).not.toContain(KEY);
  });

  it("writes a catalog with the full entry shape Codex requires", () => {
    const files = lead().files!;
    expect(files).toHaveLength(1);
    const parsed = JSON.parse(files[0]!.contents) as { models: Record<string, unknown>[] };
    for (const m of parsed.models) {
      expect(typeof m.slug).toBe("string");
      expect(typeof m.display_name).toBe("string");
      expect(typeof m.context_window).toBe("number");
      expect(Array.isArray(m.supported_reasoning_levels)).toBe(true);
      expect(m.shell_type).toBe("unified_exec");
      expect(m.visibility).toBe("list");
      expect(m.supported_in_api).toBe(true);
      expect(typeof m.priority).toBe("number");
      expect(m.support_verbosity).toBe(false);
      expect(m.truncation_policy).toEqual({ mode: "tokens", limit: 10000 });
      expect(m.experimental_supported_tools).toEqual([]);
      expect(typeof m.base_instructions).toBe("string");
      expect((m.base_instructions as string).length).toBeGreaterThan(0);
      expect(m.base_instructions).toBe(INSTRUCTIONS);
    }
    const [reasoning, plain] = parsed.models;
    expect(reasoning!.supported_reasoning_levels).toEqual([
      { effort: "low", description: "Low" },
      { effort: "medium", description: "Medium" },
      { effort: "high", description: "High" },
    ]);
    expect(reasoning!.input_modalities).toEqual(["text", "image"]);
    expect(reasoning!.default_reasoning_level).toBe("medium");
    expect(reasoning!.priority).toBe(0);
    expect(plain!.input_modalities).toEqual(["text"]);
    expect(plain!.priority).toBe(1);
  });

  it("errors for a chat provider, a missing key, and an empty catalog", () => {
    const chat = injectionFor(source({ providers: [provider({ wireProtocol: "openai-chat" })] }), "codex", process.env, opts());
    expect(chat.error).toMatch(/Responses/);
    const noKey = injectionFor(source({ secret: null }), "codex", process.env, opts());
    expect(noKey.error).toBeTruthy();
    const noModels = injectionFor(source({ providers: [provider({ models: [] })] }), "codex", process.env, opts());
    expect(noModels.error).toBeTruthy();
  });

  it("never writes a catalog inside the project cwd", () => {
    const cwd = tempDir();
    for (const file of lead().files!) expect(file.path.startsWith(cwd)).toBe(false);
  });
});
