import { describe, expect, it, vi } from "vitest";
import type { CredentialChoice, Provider, Settings } from "../src/shared/types";
import { type InjectionSource, injectionFor } from "../src/main/inject";

const KEY = "test-acp-key";

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: "deepseek",
    label: "DeepSeek",
    wireProtocol: "openai-chat",
    baseURL: "https://api.deepseek.com",
    secret: { kind: "safeStorage", ciphertext: "x" },
    models: [],
    ...patch,
  };
}

function settings(patch: Partial<Settings> = {}): Settings {
  return { theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providerInjection: {}, ...patch };
}

/** A fake settings surface, like test/inject.test.ts's: no disk, no SettingsStore. */
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

describe("injectAcp (generic ACP injector)", () => {
  it("passes a DeepSeek key under its documented variable, with no base URL or notice", () => {
    const plan = injectionFor(source(), "deepseek", {}, { agentLabel: "DeepSeek" });
    expect(plan.env.DEEPSEEK_API_KEY).toBe(KEY);
    expect(plan.env.OPENAI_BASE_URL).toBeUndefined();
    expect(plan.warning).toBeUndefined();
    expect(plan.error).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain(KEY);
  });

  it("uses the protocol's variable and base URL for an agent it can't confirm, with a notice", () => {
    const p = provider({ id: "gateway", label: "Gateway", baseURL: "https://gateway.example.com" });
    const plan = injectionFor(source({ providers: [p] }), "cursor", {}, { agentLabel: "Cursor" });
    expect(plan.env.OPENAI_API_KEY).toBe(KEY);
    expect(plan.env.OPENAI_BASE_URL).toBe("https://gateway.example.com");
    expect(plan.warning).toMatch(/Cursor/);
    expect(plan.warning).toMatch(/may not reach it/);
    expect(JSON.stringify(plan)).not.toContain(KEY);
  });

  it("gives Antigravity only the provider's own env, with an S6 notice", () => {
    const p = provider({ id: "google", label: "Google", wireProtocol: "gemini", baseURL: "https://generativelanguage.example.com", env: { GOOGLE_CLOUD_PROJECT: "p" } });
    const plan = injectionFor(source({ providers: [p] }), "antigravity", {}, { agentLabel: "Antigravity" });
    expect(plan.env.GEMINI_API_KEY).toBeUndefined();
    expect(plan.env.GOOGLE_CLOUD_PROJECT).toBe("p");
    expect(plan.warning).toMatch(/S6/);
  });

  it("strips a planted key from a subscription ACP plan", () => {
    const env = { PATH: "/usr/bin", DEEPSEEK_API_KEY: "planted" };
    const plan = injectionFor(source({ choice: { kind: "subscription" }, secretEnvNames: ["DEEPSEEK_API_KEY"] }), "deepseek", env);
    expect(plan.byok).toBe(false);
    expect(plan.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(plan.env.PATH).toBe("/usr/bin");
  });

  it("errors when the provider has no key saved", () => {
    const plan = injectionFor(source({ secret: null }), "deepseek", {}, { agentLabel: "DeepSeek" });
    expect(plan.error).toMatch(/no key saved/);
  });

  it("never writes the key through console", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const a = injectionFor(source(), "deepseek", {}, { agentLabel: "DeepSeek" });
      const b = injectionFor(
        source({ providers: [provider({ id: "gateway", label: "Gateway", baseURL: "https://gateway.example.com" })] }),
        "cursor",
        {},
        { agentLabel: "Cursor" },
      );
      const c = injectionFor(
        source({ providers: [provider({ id: "google", label: "Google", wireProtocol: "gemini", env: { GOOGLE_CLOUD_PROJECT: "p" } })] }),
        "antigravity",
        {},
        { agentLabel: "Antigravity" },
      );
      expect(a.env.DEEPSEEK_API_KEY).toBe(KEY);
      expect(b.env.OPENAI_API_KEY).toBe(KEY);
      expect(c.warning).toMatch(/S6/);
      for (const arg of [...error.mock.calls, ...warn.mock.calls, ...log.mock.calls].flat()) {
        expect(String(arg)).not.toContain(KEY);
      }
    } finally {
      error.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
