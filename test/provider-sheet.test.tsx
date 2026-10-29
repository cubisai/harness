import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderView } from "../src/shared/types";
import { CatalogSearch, PresetPicker, ProviderList, catalogMeta, hostOf, presetOptions, toProviderInput } from "../src/renderer/src/components/ProviderSheet";

const caps = { tools: true, vision: false, reasoning: false };

function providerView(patch: Partial<ProviderView> & { id: string }): ProviderView {
  return {
    label: patch.id,
    wireProtocol: "openai-chat",
    baseURL: "https://api.deepseek.com",
    models: [{ id: "m", capabilities: caps, contextWindow: 4096, maxOutput: 1024 }],
    secretKind: "safeStorage",
    hasSecret: true,
    ...patch,
  };
}

describe("hostOf", () => {
  it("keeps only the host and a non-default port", () => {
    expect(hostOf("https://user:sk-leak-123@gw.example.com:8443/v1?key=sk-leak-456")).toBe("gw.example.com:8443");
    expect(hostOf("https://api.deepseek.com")).toBe("api.deepseek.com");
  });

  it("returns 'invalid URL' for an unparseable value", () => {
    expect(hostOf("not a url")).toBe("invalid URL");
  });
});

describe("ProviderList", () => {
  const providers = [
    providerView({ id: "gateway", label: "Gateway", baseURL: "https://user:sk-leak-123@gw.example.com:8443/v1?key=sk-leak-456", models: [] }),
    providerView({ id: "deepseek", label: "DeepSeek" }),
  ];

  it("renders hosts but never userinfo, path or query", () => {
    const html = renderToStaticMarkup(<ProviderList providers={providers} migratedProviders={[]} />);
    expect(html).toContain("gw.example.com:8443");
    expect(html).toContain("api.deepseek.com");
    expect(html).not.toContain("sk-leak");
    expect(html).not.toContain("user:");
    expect(html).not.toContain("/v1?");
  });

  it("shows the migration banner and labels migrated rows", () => {
    const migrated = [
      providerView({ id: "anthropic", label: "Anthropic" }),
      providerView({ id: "openai", label: "OpenAI" }),
    ];
    const html = renderToStaticMarkup(<ProviderList providers={migrated} migratedProviders={["anthropic", "openai"]} />);
    expect(html).toContain("Your saved keys now live in Providers. Nothing was deleted.");
    expect(html.match(/from your saved key/g)).toHaveLength(2);
  });

  it("omits the banner when nothing migrated", () => {
    const html = renderToStaticMarkup(<ProviderList providers={providers} migratedProviders={[]} />);
    expect(html).not.toContain("Your saved keys now live in Providers. Nothing was deleted.");
  });
});

describe("toProviderInput", () => {
  it("keeps the fields the editor doesn't show when editing", () => {
    const existing: ProviderView = {
      id: "gw",
      label: "My gateway",
      wireProtocol: "openai-chat",
      baseURL: "https://gw.example.com",
      models: [],
      headers: { "X-Team": "a" },
      env: { EXTRA: "1" },
      queryParams: { "api-version": "2" },
      retries: { request: 3 },
      contextWindowOverride: 1000,
      secretKind: "safeStorage",
      hasSecret: true,
    };
    const input = toProviderInput(existing, { id: "gw", wireProtocol: "openai-responses", baseURL: "https://gw2.example.com", models: [], pathMode: "raw", betaHeaders: "default" });
    expect(input).toMatchObject({ label: "My gateway", headers: { "X-Team": "a" }, env: { EXTRA: "1" }, queryParams: { "api-version": "2" }, retries: { request: 3 }, contextWindowOverride: 1000 });
    expect(input.wireProtocol).toBe("openai-responses");
    expect(input.baseURL).toBe("https://gw2.example.com");
    expect("hasSecret" in input || "secretKind" in input).toBe(false);
  });

  it("labels a new provider with its id", () => {
    expect(toProviderInput(undefined, { id: "new", wireProtocol: "gemini", baseURL: "https://x", models: [], pathMode: "auto", betaHeaders: "default" }).label).toBe("new");
  });

  it("uses the picked preset's label for a new provider, falling back to the id", () => {
    const fields = { id: "groq", wireProtocol: "openai-chat" as const, baseURL: "https://api.groq.com/openai/v1", models: [], pathMode: "auto" as const, betaHeaders: "default" as const };
    expect(toProviderInput(undefined, { ...fields, label: "  Groq  " }).label).toBe("Groq");
    expect(toProviderInput(undefined, { ...fields, label: "" }).label).toBe("groq");
    expect(toProviderInput(undefined, fields).label).toBe("groq");
  });

  it("keeps the stored label when editing, even if the editor passes a blank one", () => {
    const existing = providerView({ id: "gw", label: "My gateway" });
    const fields = { id: "gw", wireProtocol: "openai-chat" as const, baseURL: "https://gw.example.com", models: [], pathMode: "auto" as const, betaHeaders: "default" as const };
    expect(toProviderInput(existing, { ...fields, label: "X" }).label).toBe("My gateway");
    expect(toProviderInput(existing, fields).label).toBe("My gateway");
  });

  it("clears a stored field the editor passes as undefined, and keeps the ones it omits", () => {
    const existing: ProviderView = {
      id: "gw",
      label: "My gateway",
      wireProtocol: "openai-chat",
      baseURL: "https://gw.example.com",
      models: [],
      headers: { "X-Team": "a" },
      env: { EXTRA: "1" },
      queryParams: { "api-version": "2" },
      secretKind: "safeStorage",
      hasSecret: false,
    };
    const fields = { id: "gw", wireProtocol: "openai-chat" as const, baseURL: "https://gw.example.com", models: [], pathMode: "auto" as const, betaHeaders: "default" as const };
    // Removing every header / query param clears the stored maps; env is untouched (the editor never passes it).
    const cleared = toProviderInput(existing, { ...fields, headers: undefined, queryParams: undefined });
    expect(cleared.headers).toBeUndefined();
    expect(cleared.queryParams).toBeUndefined();
    expect(cleared.env).toEqual({ EXTRA: "1" });
    // Omitting a key entirely (not passing it as undefined) keeps the stored value.
    const kept = toProviderInput(existing, fields);
    expect(kept.headers).toEqual({ "X-Team": "a" });
    expect(kept.queryParams).toEqual({ "api-version": "2" });
  });

  it("carries authStyle, smallModel and secretHeaderNames, and an empty list clears stored secret headers", () => {
    const existing = providerView({ id: "gw", label: "My gateway", authStyle: "auto", smallModel: "old", secretHeaderNames: ["X-Key"] });
    const fields = { id: "gw", wireProtocol: "anthropic-messages" as const, baseURL: "https://gw.example.com", models: [], pathMode: "auto" as const, betaHeaders: "default" as const };
    const input = toProviderInput(existing, { ...fields, authStyle: "x-api-key", smallModel: "new", secretHeaderNames: [] });
    expect(input.authStyle).toBe("x-api-key");
    expect(input.smallModel).toBe("new");
    expect(input.secretHeaderNames).toEqual([]);
    expect("hasSecret" in input || "secretKind" in input).toBe(false);
  });

  it("carries the new fields for a brand-new provider too", () => {
    const input = toProviderInput(undefined, {
      id: "gw",
      wireProtocol: "openai-responses",
      baseURL: "https://gw.example.com",
      models: [],
      pathMode: "auto",
      betaHeaders: "default",
      headers: { "X-Team": "a" },
      retries: { request: 3 },
      contextWindowOverride: 200_000,
      secretHeaderNames: ["X-Key"],
    });
    expect(input).toMatchObject({ label: "gw", headers: { "X-Team": "a" }, retries: { request: 3 }, contextWindowOverride: 200_000, secretHeaderNames: ["X-Key"] });
  });
});

describe("PresetPicker", () => {
  it("offers Custom plus every preset", () => {
    const options = presetOptions();
    expect(options[0]).toEqual({ value: "", label: "Custom" });
    expect(options.map((o) => o.label)).toEqual(expect.arrayContaining(["Groq", "Ollama (local)"]));
    const html = renderToStaticMarkup(<PresetPicker value="" onPick={() => {}} />);
    expect(html).toContain("Custom");
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("<select");
    expect(html).toMatchSnapshot();
  });
});

describe("CatalogSearch", () => {
  it("starts as a labelled search with no result list", () => {
    const html = renderToStaticMarkup(<CatalogSearch onPick={() => {}} />);
    expect(html).toContain('aria-label="Search models.dev providers"');
    expect(html).not.toContain("Catalog providers");
  });

  it("describes a result by protocol, host and model count", () => {
    const entry = { id: "minimax", name: "MiniMax", wireProtocol: "anthropic-messages" as const, baseURL: "https://api.minimax.io/anthropic/v1", models: [] };
    expect(catalogMeta(entry)).toBe("anthropic-messages · api.minimax.io · 0 models");
    const one = { ...entry, models: [{ id: "m", capabilities: { tools: true, vision: false, reasoning: false }, contextWindow: 1, maxOutput: 1, enriched: true }] };
    expect(catalogMeta(one)).toBe("anthropic-messages · api.minimax.io · 1 model");
  });
});
