import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialChoice, Provider, ProviderInput, Settings } from "../src/shared/types";
import { anthropicAuthStyle, providerOfModel } from "../src/shared/provider-rules";
import { type InjectionSource, injectionFor } from "../src/main/inject";
import { ENV_REF, headerPlan, resolvedHeaders } from "../src/main/inject/headers";
import { catalogFor, upstreamMessage } from "../src/main/providers";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import { tempDir } from "./helpers";

const KEY = "p1-key-value";
const SECRET_HEADER = "p1-secret-header-value";
const caps = { tools: true, vision: false, reasoning: false };

/** Reversible, and visibly not plaintext. */
const box: SecretBox = {
  available: true,
  encrypt: (s) => Buffer.from([...s].reverse().join("")).toString("base64"),
  decrypt: (b) => [...Buffer.from(b, "base64").toString()].reverse().join(""),
};

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: "gw",
    label: "GW",
    wireProtocol: "anthropic-messages",
    baseURL: "https://gw.example.com",
    secret: { kind: "safeStorage", ciphertext: "x" },
    models: [
      { id: "big", capabilities: caps, contextWindow: 200_000, maxOutput: 8_000 },
      { id: "cheap", modelID: "vendor/cheap-1", capabilities: caps, contextWindow: 100_000, maxOutput: 4_000 },
    ],
    ...patch,
  };
}

function settings(): Settings {
  return { theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providerInjection: {} };
}

function source(p: Provider, secretHeaders: Record<string, string> = {}): InjectionSource {
  return {
    credential: (): CredentialChoice => ({ kind: "byok", providerId: p.id }),
    providers: () => [p],
    providerSecret: () => KEY,
    providerSecretHeaders: () => secretHeaders,
    secretEnvNames: () => [],
    get: settings,
  };
}

describe("anthropicAuthStyle", () => {
  it("defaults to X-Api-Key on api.anthropic.com and Bearer elsewhere, unless chosen", () => {
    expect(anthropicAuthStyle({ baseURL: "https://api.anthropic.com" })).toBe("x-api-key");
    expect(anthropicAuthStyle({ baseURL: "https://gw.example.com" })).toBe("bearer");
    expect(anthropicAuthStyle({ baseURL: "https://gw.example.com", authStyle: "x-api-key" })).toBe("x-api-key");
    expect(anthropicAuthStyle({ baseURL: "https://api.anthropic.com", authStyle: "bearer" })).toBe("bearer");
  });
});

describe("headerPlan", () => {
  it("splits literal, ${env:VAR} and secret headers; a secret one wins over a plain one", () => {
    const plan = headerPlan({ id: "gw", headers: { "X-A": "1", "X-Env": "${env:MY_VAR}", "x-secret": "plain" } }, { "X-Secret": SECRET_HEADER });
    expect(plan.literal).toEqual({ "X-A": "1" });
    expect(plan.fromEnv).toEqual({ "X-Env": "MY_VAR", "X-Secret": "UNSKILLED_GW_HEADER_1" });
    expect(plan.secretVars).toEqual({ UNSKILLED_GW_HEADER_1: SECRET_HEADER });
    expect(resolvedHeaders(plan, { MY_VAR: "from-env" })).toEqual({ "X-A": "1", "X-Env": "from-env", "X-Secret": SECRET_HEADER });
    expect(resolvedHeaders(plan, {})).not.toHaveProperty("X-Env");
    expect(ENV_REF.test("prefix ${env:X}")).toBe(false);
  });
});

describe("Claude injection (P1)", () => {
  it("follows the auth style", () => {
    const bearer = injectionFor(source(provider()), "claude", {}, { injector: "claude" });
    expect(bearer.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(bearer.env.ANTHROPIC_API_KEY).toBeUndefined();
    const xKey = injectionFor(source(provider({ authStyle: "x-api-key" })), "claude", {}, { injector: "claude" });
    expect(xKey.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(xKey.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("sets the small/fast model and the haiku slot unless a haiku alias is pinned", () => {
    const plan = injectionFor(source(provider({ smallModel: "cheap" })), "claude", {}, { injector: "claude" });
    expect(plan.env.ANTHROPIC_SMALL_FAST_MODEL).toBe("vendor/cheap-1");
    expect(plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("vendor/cheap-1");
    const pinned = provider({ smallModel: "cheap" });
    pinned.models[0]!.alias = "haiku";
    expect(injectionFor(source(pinned), "claude", {}, { injector: "claude" }).env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("big");
    expect(injectionFor(source(provider({ smallModel: "gone" })), "claude", {}, { injector: "claude" }).env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
  });

  it("sends secret and env headers resolved, and never shows a secret header in a serialized plan", () => {
    const plan = injectionFor(source(provider({ headers: { "X-Env": "${env:MY_VAR}" } }), { "X-Secret": SECRET_HEADER }), "claude", { MY_VAR: "v" }, { injector: "claude" });
    expect(plan.env.ANTHROPIC_CUSTOM_HEADERS).toBe(`X-Env: v\nX-Secret: ${SECRET_HEADER}`);
    expect(JSON.stringify(plan)).not.toContain(SECRET_HEADER);
  });
});

describe("Codex injection (P1)", () => {
  const responses = (patch: Partial<Provider> = {}) => provider({ wireProtocol: "openai-responses", ...patch });
  const plan = (p: Provider, secretHeaders?: Record<string, string>) =>
    injectionFor(source(p, secretHeaders), "codex", { PATH: "/usr/bin" }, { injector: "codex", codexCatalogDir: tempDir(), codexInstructions: () => "x" });

  it("puts secret and env headers in env_http_headers, never their values in argv", () => {
    const p = plan(responses({ headers: { "X-A": "1", "X-Env": "${env:MY_VAR}" } }), { "X-Secret": SECRET_HEADER });
    const table = p.args!.at(-1)!;
    expect(table).toContain(`http_headers={ "X-A"="1" }`);
    expect(table).toContain(`env_http_headers={ "X-Env"="MY_VAR", "X-Secret"="UNSKILLED_GW_HEADER_1" }`);
    expect(p.args!.join(" ")).not.toContain(SECRET_HEADER);
    expect(p.env.UNSKILLED_GW_HEADER_1).toBe(SECRET_HEADER);
    expect(JSON.stringify(p)).not.toContain(SECRET_HEADER);
  });

  it("writes the context override into the catalog", () => {
    const p = plan(responses({ contextWindowOverride: 64_000 }));
    const contents = JSON.parse(p.files![0]!.contents) as { models: { context_window: number }[] };
    expect(contents.models.map((m) => m.context_window)).toEqual([64_000, 64_000]);
  });
});

describe("catalogFor context override", () => {
  it("replaces every model's window for OpenCode and Codex, and leaves them alone without one", () => {
    const over = catalogFor(provider({ contextWindowOverride: 32_000 }));
    expect(Object.values(over.opencode.models).map((m) => (m as { limit: { context: number } }).limit.context)).toEqual([32_000, 32_000]);
    expect(catalogFor(provider()).codex.models.map((m) => m.context_window)).toEqual([200_000, 100_000]);
  });
});

describe("SettingsStore secret headers", () => {
  const input = (patch: Partial<ProviderInput> = {}): ProviderInput => ({ id: "gw", label: "GW", wireProtocol: "openai-chat", baseURL: "https://gw.example.com/v1", models: [], ...patch });

  it("encrypts secret header values, shows only their names, and keeps or drops them by name", () => {
    const file = join(tempDir(), "settings.json");
    const s = new SettingsStore(file, box);
    const view = s.saveProvider(input(), KEY, { "X-Secret": SECRET_HEADER, "X-Two": "two-value" });
    expect(view.secretHeaderNames).toEqual(["X-Secret", "X-Two"]);
    expect(view).not.toHaveProperty("secretHeaders");
    expect(readFileSync(file, "utf8")).not.toContain(SECRET_HEADER);
    expect(s.providerSecretHeaders("gw")).toEqual({ "X-Secret": SECRET_HEADER, "X-Two": "two-value" });
    // Saving without names keeps them all; listing one name drops the other.
    s.saveProvider(input({ label: "GW 2" }));
    expect(Object.keys(s.providerSecretHeaders("gw"))).toEqual(["X-Secret", "X-Two"]);
    s.saveProvider(input({ secretHeaderNames: ["X-Two"] }));
    expect(s.providerSecretHeaders("gw")).toEqual({ "X-Two": "two-value" });
  });

  it("probes a draft with the saved key and headers only while the host is unchanged", () => {
    const s = new SettingsStore(join(tempDir(), "settings.json"), box);
    s.saveProvider(input({ headers: { "X-A": "1" } }), KEY, { "X-Secret": SECRET_HEADER });
    const same = s.draftProvider(input({ headers: { "X-A": "2" } }));
    expect(same.key).toBe(KEY);
    expect(same.provider.headers).toEqual({ "X-A": "2", "X-Secret": SECRET_HEADER });
    expect(same.provider).not.toHaveProperty("secretHeaders");
    const moved = s.draftProvider(input({ baseURL: "https://elsewhere.example.com/v1" }));
    expect(moved.key).toBeNull();
    expect(moved.provider.headers).toEqual({});
    expect(s.draftProvider(input({ baseURL: "https://elsewhere.example.com/v1" }), "typed-key").key).toBe("typed-key");
  });
});

describe("upstreamMessage", () => {
  it("reads OpenAI, Anthropic and plain error bodies, masks the key, and ignores non-JSON", () => {
    expect(upstreamMessage(JSON.stringify({ error: { message: "Model `x` is not available on your plan's API access", code: "model_not_in_plan" } }), null)).toBe("Model `x` is not available on your plan's API access.");
    expect(upstreamMessage(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad key sk-1" } }), "sk-1")).toBe("bad key «redacted».");
    expect(upstreamMessage(JSON.stringify({ error: "nope!" }), null)).toBe("nope!");
    expect(upstreamMessage("<html>502</html>", null)).toBeNull();
  });
});

describe("per-thread provider (P1d)", () => {
  it("reads the provider a model id names", () => {
    expect(providerOfModel("unskilled-th-chat/deepseek-v4-flash")).toBe("th-chat");
    expect(providerOfModel("unskilled-gw/vendor/model")).toBe("gw");
    expect(providerOfModel("anthropic/claude")).toBeNull();
    expect(providerOfModel("unskilled-/x")).toBeNull();
    expect(providerOfModel(null)).toBeNull();
  });

  it("lets a thread's provider win over the agent's subscription", () => {
    const p = provider({ wireProtocol: "openai-chat", baseURL: "https://gw.example.com/v1" });
    const sub: InjectionSource = { ...source(p), credential: () => ({ kind: "subscription" }) };
    const opts = { injector: "opencode" as const, opencodeVersion: () => "1.18.0" };
    expect(injectionFor(sub, "opencode", { PATH: "/usr/bin" }, opts).byok).toBe(false);
    const pinned = injectionFor(sub, "opencode", { PATH: "/usr/bin" }, { ...opts, providerId: "gw" });
    expect(pinned.byok).toBe(true);
    expect(pinned.env.UNSKILLED_GW_KEY).toBe(KEY);
    expect(injectionFor(sub, "opencode", {}, { ...opts, providerId: "gone" }).error).toMatch(/no longer exists/);
  });
});
