import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialChoice, Provider, Settings } from "../src/shared/types";
import { type InjectionSource, injectionFor } from "../src/main/inject";
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
    const plan = injectionFor(source(), "claude");
    expect(plan.env.PATH).toBeDefined();
    expect(plan.env.HOME).toBeDefined();
    expect(plan.env.PATH).toBe(process.env.PATH);
    expect(plan.env.HOME).toBe(process.env.HOME);
  });

  it("sends a gateway key as a Bearer token and warns about feature loss", () => {
    const plan = injectionFor(source({ providers: [provider({ baseURL: "https://gateway.example.com" })] }), "claude");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.warning).toMatch(/Remote Control/);
    expect(plan.warning).toMatch(/MCP tool search/);
  });

  it("sends a first-party key as X-Api-Key with no warning", () => {
    const plan = injectionFor(source({ providers: [provider({ baseURL: "https://api.anthropic.com" })] }), "claude");
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
    const plan = injectionFor(source({ choice: { kind: "subscription" }, secretEnvNames: ["DEEPSEEK_API_KEY"] }), "claude", env);
    expect(plan.byok).toBe(false);
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(plan.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(plan.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(plan.env.PATH).toBe("/usr/bin");
  });

  it("errors when Claude gets a non-Anthropic provider", () => {
    const plan = injectionFor(source({ providers: [provider({ wireProtocol: "openai-chat" })] }), "claude");
    expect(plan.error).toBeTruthy();
  });

  it("errors when the provider has no key saved", () => {
    const plan = injectionFor(source({ secret: null }), "claude");
    expect(plan.error).toBeTruthy();
  });

  it("passes custom headers and strips experimental betas", () => {
    const plan = injectionFor(source({ providers: [provider({ headers: { "X-A": "1", "X-B": "2" }, betaHeaders: "strip" })] }), "claude");
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
    const plan = injectionFor(source({ providers: [provider({ models: [model] })] }), "claude");
    expect(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("vendor/s-1");
  });

  it("never puts the key into a serialized plan", () => {
    const plan = injectionFor(source({ providers: [provider({ baseURL: "https://gateway.example.com" })] }), "claude");
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

describe("injectionFor (gated drivers)", () => {
  it("runs codex without BYOK files until providerInjection turns it on", () => {
    const off = injectionFor(source({ settings: { providerInjection: {} } }), "codex");
    expect(off.files).toEqual([]);
    expect(off.args).toBeUndefined();
    expect(off.warning).toMatch(/off/);
  });

  it("drops the codex warning once providerInjection is on", () => {
    const on = injectionFor(source({ settings: { providerInjection: { codex: true } } }), "codex");
    expect(on.warning).toBeUndefined();
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
