import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialChoice, Provider, Settings } from "../src/shared/types";
import { type InjectionSource, GATED_DRIVERS, injectionFor } from "../src/main/inject";
import { staleKeyNotice, staleKeySources } from "../src/main/inject/claude";
import { tempDir } from "./helpers";

const KEY = "test-key-value-1";

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: "gateway",
    label: "Gateway",
    wireProtocol: "anthropic-messages",
    baseURL: "https://gateway.example.com",
    secret: { kind: "safeStorage", ciphertext: "x" },
    models: [],
    ...patch,
  };
}

function settings(patch: Partial<Settings> = {}): Settings {
  return { theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providerInjection: {}, ...patch };
}

/** A fake settings surface: no disk, no SettingsStore. */
function source(opts: { providers?: Provider[]; choice?: CredentialChoice; secret?: string | null; secretEnvNames?: string[]; settings?: Partial<Settings> } = {}): InjectionSource {
  const providers = opts.providers ?? [provider()];
  return {
    credential: () => opts.choice ?? { kind: "byok", providerId: providers[0]!.id },
    providers: () => providers,
    providerSecret: () => (opts.secret === undefined ? KEY : opts.secret),
    secretEnvNames: () => opts.secretEnvNames ?? [],
    get: () => settings(opts.settings),
  };
}

describe("injectionFor (Claude)", () => {
  it("starts from a copy of our environment", () => {
    const plan = injectionFor(source(), "claude", process.env, { injector: "claude" });
    const envKey = (env: Record<string, string | undefined>, name: string) => Object.keys(env).find((k) => k.toUpperCase() === name);
    const pathKey = envKey(plan.env, "PATH");
    expect(pathKey).toBeDefined();
    expect(plan.env[pathKey!]).toBe(process.env[pathKey!]);
    const homeName = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const homeKey = envKey(plan.env, homeName);
    expect(homeKey).toBeDefined();
    expect(plan.env[homeKey!]).toBe(process.env[homeKey!]);
  });

  it("sends a gateway key as a Bearer token and warns about feature loss", () => {
    const plan = injectionFor(source({ providers: [provider({ baseURL: "https://gateway.example.com" })] }), "claude", process.env, { injector: "claude" });
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.warning).toMatch(/Remote Control/);
    expect(plan.warning).toMatch(/MCP tool search/);
  });

  it("sends a first-party key as X-Api-Key with no warning", () => {
    const plan = injectionFor(source({ providers: [provider({ baseURL: "https://api.anthropic.com" })] }), "claude", process.env, { injector: "claude" });
    expect(plan.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(plan.warning).toBeUndefined();
  });

  it("strips every key variable from a subscription plan", () => {
    const env = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "stale-a",
      ANTHROPIC_AUTH_TOKEN: "stale-b",
      ANTHROPIC_BASE_URL: "https://stale.example.com",
      DEEPSEEK_API_KEY: "stale-c",
    };
    const plan = injectionFor(source({ choice: { kind: "subscription" }, secretEnvNames: ["DEEPSEEK_API_KEY"] }), "claude", env, { injector: "claude" });
    expect(plan.byok).toBe(false);
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(plan.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(plan.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(plan.env.PATH).toBe("/usr/bin");
  });

  it("errors when Claude gets a non-Anthropic provider", () => {
    const plan = injectionFor(source({ providers: [provider({ wireProtocol: "openai-chat" })] }), "claude", process.env, { injector: "claude" });
    expect(plan.error).toBeTruthy();
  });

  it("errors when the provider has no key saved", () => {
    const plan = injectionFor(source({ secret: null }), "claude", process.env, { injector: "claude" });
    expect(plan.error).toBeTruthy();
  });

  it("passes custom headers and strips experimental betas", () => {
    const plan = injectionFor(source({ providers: [provider({ headers: { "X-A": "1", "X-B": "2" }, betaHeaders: "strip" })] }), "claude", process.env, { injector: "claude" });
    expect(plan.env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-A: 1\nX-B: 2");
    expect(plan.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
    expect(plan.warning).toMatch(/MCP tool search/);
  });

  it("pins Claude's alias slots from the provider's models", () => {
    const model = {
      id: "s-1",
      modelID: "vendor/s-1",
      alias: "sonnet" as const,
      capabilities: { tools: true, vision: false, reasoning: false },
      contextWindow: 1000,
      maxOutput: 100,
    };
    const plan = injectionFor(source({ providers: [provider({ models: [model] })] }), "claude", process.env, { injector: "claude" });
    expect(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("vendor/s-1");
  });

  it("never puts the key into a serialized plan", () => {
    const plan = injectionFor(source({ providers: [provider({ baseURL: "https://gateway.example.com" })] }), "claude", process.env, { injector: "claude" });
    const json = JSON.stringify(plan);
    expect(json).not.toContain(KEY);
    expect(json).toContain("«redacted»");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
  });

  it("never passes settingSources to the SDK", () => {
    const text = readFileSync(join(__dirname, "..", "src", "main", "agents", "claude.ts"), "utf-8");
    expect(text).not.toMatch(/settingSources\s*:/);
  });
});

describe("injectionFor (Claude through the gateway)", () => {
  const chat = provider({
    id: "th",
    wireProtocol: "openai-chat",
    baseURL: "https://tokenharbor.example/v1",
    headers: { "x-team": "a" },
    betaHeaders: "strip",
    models: [
      { id: "flash", modelID: "deepseek-v4-flash", capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 128_000, maxOutput: 8_192, cost: { input: 0.3, output: 1.2 } },
      { id: "noprice", capabilities: { tools: true, vision: false, reasoning: false }, contextWindow: 128_000, maxOutput: 8_192 },
    ],
  });
  const gateway = { url: "http://127.0.0.1:5000/llm", token: "gw-token-abc" };
  const plan = (model: string) => injectionFor(source({ providers: [chat], choice: { kind: "subscription" } }), "claude", {}, { injector: "claude", providerId: "th", model, gateway });

  it("points Claude at the gateway with its token, never the provider key or headers", () => {
    const p = plan("unskilled-th/flash");
    expect(p.error).toBeUndefined();
    expect(p.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:5000/llm/th");
    expect(p.env.ANTHROPIC_AUTH_TOKEN).toBe("gw-token-abc");
    expect(p.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(p.env.ANTHROPIC_MODEL).toBe("deepseek-v4-flash");
    expect(p.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(p.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
    expect(JSON.stringify(p.env)).not.toContain(KEY);
    expect(JSON.stringify(p)).not.toContain("gw-token-abc");
    expect(p.model).toBe("deepseek-v4-flash");
    expect(p.warning).toMatch(/CubiQ's gateway/);
    expect(p.warning).not.toMatch(/accept the loss/);
  });

  it("carries the model's price, or null when the provider has none", () => {
    expect(plan("unskilled-th/flash").pricing).toEqual({ input: 0.3, output: 1.2 });
    expect(plan("unskilled-th/noprice").pricing).toBeNull();
  });

  it("refuses a chat-completions provider when the gateway isn't running", () => {
    const p = injectionFor(source({ providers: [chat] }), "claude", {}, { injector: "claude" });
    expect(p.error).toMatch(/gateway/);
  });
});

describe("injectionFor (gated drivers)", () => {
  it("warns and skips injection for a gated driver", () => {
    GATED_DRIVERS.add("test-gated");
    try {
      const plan = injectionFor(source({ settings: { providerInjection: {} } }), "test-gated");
      expect(plan.files).toEqual([]);
      expect(plan.warning).toMatch(/off/);
    } finally {
      GATED_DRIVERS.delete("test-gated");
    }
  });
});

describe("staleKeySources", () => {
  it("returns the path of a source that sets an Anthropic key", () => {
    const list = staleKeySources([
      { source: "user", settings: { env: { ANTHROPIC_API_KEY: "stale-fixture-value" } }, path: "/p/user.json" },
      { source: "project", settings: { env: { OTHER: "x" } }, path: "/p/clean.json" },
    ]);
    expect(list).toEqual(["/p/user.json"]);
  });
});

describe("staleKeyNotice", () => {
  it("notices a project whose Claude settings pin an Anthropic key", async () => {
    const project = tempDir();
    mkdirSync(join(project, ".claude"), { recursive: true });
    const settingsFile = join(project, ".claude", "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_API_KEY: "stale-fixture-value" } }));
    // Keep the user's real ~/.claude out of the resolution.
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir();
    try {
      const notice = await staleKeyNotice(project);
      expect(notice).not.toBeNull();
      expect(notice).toContain(settingsFile);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});
