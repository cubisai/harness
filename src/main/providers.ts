// The pure provider core: id validation, feature warnings, connection probes and
// the catalog compiler. Storage, injection and IPC are layered on top of this.

import type {
  ConnectionResult,
  CredentialChoice,
  ModelCapabilities,
  ModelOption,
  Provider,
  ProviderModel,
  ProviderSecret,
  ProviderView,
  WireProtocol,
} from "../shared/types";

export type {
  ConnectionResult,
  CredentialChoice,
  ModelCapabilities,
  Provider,
  ProviderModel,
  ProviderSecret,
  ProviderView,
  WireProtocol,
};

/** Ids the harness itself uses as names; a provider may not shadow them. */
export const RESERVED_PROVIDER_IDS = new Set(["claude", "codex", "unskilled", "default"]);

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isProviderId(id: string): boolean {
  return PROVIDER_ID_RE.test(id) && !RESERVED_PROVIDER_IDS.has(id);
}

// Moved to src/shared so the renderer can use them too; re-exported here so
// existing main-process callers (and test/providers.test.ts) keep working.
export { codexCompatible, providerWarning } from "../shared/provider-rules";

/**
 * The environment variable each migrated legacy key becomes. Kept only so
 * today's process.env export keeps working until Phase 2's per-driver injection.
 */
export const LEGACY_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
} as const;

export type LegacyProviderId = keyof typeof LEGACY_ENV;

/** The three legacy keys as environment variables, for the providers whose key resolves. */
export function legacyEnv(resolve: (providerId: string) => string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of Object.keys(LEGACY_ENV) as LegacyProviderId[]) {
    const value = resolve(id);
    if (value !== null) out[LEGACY_ENV[id]] = value;
  }
  return out;
}

/** The synthesized-provider defaults for settings.json v2's one-shot legacy-key migration. */
export const LEGACY_PROVIDERS: Record<LegacyProviderId, Pick<Provider, "label" | "wireProtocol" | "baseURL" | "models">> = {
  anthropic: { label: "Anthropic", wireProtocol: "anthropic-messages", baseURL: "https://api.anthropic.com", models: [] },
  deepseek: { label: "DeepSeek", wireProtocol: "openai-chat", baseURL: "https://api.deepseek.com", models: [] },
  openai: { label: "OpenAI", wireProtocol: "openai-chat", baseURL: "https://api.openai.com/v1", models: [] },
};

/** The id actually sent on the wire: the model's modelID when set, else the picker id. */
function wireIdOf(model: ProviderModel | undefined, modelId: string): string {
  return model?.modelID ?? modelId;
}

function withQuery(url: string, params: Record<string, string> | undefined): string {
  if (!params || Object.keys(params).length === 0) return url;
  const q = new URLSearchParams(params).toString();
  return url.includes("?") ? `${url}&${q}` : `${url}?${q}`;
}

interface Endpoints {
  models: string | null; // null = listing not attempted (raw path mode)
  generate: string;
}

/**
 * Path suffixes per protocol. `auto` strips a trailing slash and never doubles
 * `/v1`; `raw` posts to baseURL exactly as typed and skips the models probe.
 */
function endpointsFor(provider: Provider, wire: string): Endpoints {
  const base = provider.baseURL.replace(/\/+$/, "");
  const raw = provider.pathMode === "raw";
  let models: string | null = null;
  let generate = raw ? provider.baseURL : base;
  switch (provider.wireProtocol) {
    case "anthropic-messages": {
      if (!raw) {
        const root = base.endsWith("/v1") ? base : `${base}/v1`;
        models = `${root}/models`;
        generate = `${root}/messages`;
      }
      break;
    }
    case "openai-chat":
      if (!raw) {
        models = `${base}/models`;
        generate = `${base}/chat/completions`;
      }
      break;
    case "openai-responses":
      if (!raw) {
        models = `${base}/models`;
        generate = `${base}/responses`;
      }
      break;
    case "gemini":
      if (!raw) {
        models = `${base}/v1beta/models`;
        generate = `${base}/v1beta/models/${wire}:generateContent`;
      }
      break;
  }
  return {
    models: models === null ? null : withQuery(models, provider.queryParams),
    generate: withQuery(generate, provider.queryParams),
  };
}

/** Auth headers differ by protocol: Claude reads X-Api-Key, OpenAI-style reads Bearer, Gemini reads x-goog-api-key. */
function buildHeaders(provider: Provider, apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.wireProtocol === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
  if (apiKey !== null) {
    switch (provider.wireProtocol) {
      case "anthropic-messages":
        headers["x-api-key"] = apiKey;
        break;
      case "openai-chat":
      case "openai-responses":
        headers["Authorization"] = `Bearer ${apiKey}`;
        break;
      case "gemini":
        headers["x-goog-api-key"] = apiKey;
        break;
    }
  }
  Object.assign(headers, provider.headers);
  if (provider.betaHeaders === "strip") {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "anthropic-beta") delete headers[name];
    }
  }
  return headers;
}

/** Probe request bodies. The tools variant offers one trivial `ping` function. */
function bodyFor(provider: Provider, wire: string, tools: boolean): unknown {
  const max = tools ? 64 : 1;
  const prompt = tools ? "Call the ping tool with no arguments." : "hi";
  const pingSchema = { type: "object", properties: {} };
  switch (provider.wireProtocol) {
    case "anthropic-messages":
      return {
        model: wire,
        max_tokens: max,
        messages: [{ role: "user", content: prompt }],
        ...(tools ? { tools: [{ name: "ping", description: "Ping.", input_schema: pingSchema }] } : {}),
      };
    case "openai-chat":
      return {
        model: wire,
        max_tokens: max,
        messages: [{ role: "user", content: prompt }],
        ...(tools ? { tools: [{ type: "function", function: { name: "ping", description: "Ping.", parameters: pingSchema } }] } : {}),
      };
    case "openai-responses":
      return {
        model: wire,
        max_output_tokens: max,
        input: prompt,
        ...(tools ? { tools: [{ type: "function", name: "ping", description: "Ping.", parameters: pingSchema }] } : {}),
      };
    case "gemini":
      return {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: max },
        ...(tools
          ? { tools: [{ functionDeclarations: [{ name: "ping", description: "Ping.", parameters: pingSchema }] }] }
          : {}),
      };
    default:
      return {};
  }
}

/** Whether a probe response actually contains a tool call for the protocol. */
function hasToolCall(protocol: WireProtocol, json: unknown): boolean {
  const j = json as any;
  switch (protocol) {
    case "anthropic-messages":
      return Array.isArray(j?.content) && j.content.some((c: any) => c?.type === "tool_use");
    case "openai-chat":
      return Array.isArray(j?.choices?.[0]?.message?.tool_calls) && j.choices[0].message.tool_calls.length > 0;
    case "openai-responses":
      return Array.isArray(j?.output) && j.output.some((o: any) => o?.type === "function_call");
    case "gemini":
      return Array.isArray(j?.candidates?.[0]?.content?.parts) && j.candidates[0].content.parts.some((p: any) => p?.functionCall);
    default:
      return false;
  }
}

function triageFor(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return `${status}: the key was rejected. Check the header semantics — Claude uses X-Api-Key, OpenAI-style endpoints use Authorization: Bearer — and that the key actually reached this process.`;
    case 404:
      return `404: the path is wrong. That is often a duplicated /v1, or a chat-vs-responses mismatch. Turn on "Send the URL exactly as typed" (raw) and retry.`;
    case 400:
      return `400: the endpoint rejected the request body or headers — a strict schema, or an anthropic-beta header it does not accept. Set betaHeaders to "strip" and retry.`;
    default:
      return `The endpoint answered HTTP ${status} to a minimal request; check the provider's logs for details.`;
  }
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

function readJson(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

/**
 * Three probes per protocol: list models (informational, skipped on raw), one
 * minimal generation (this is what "reachable" means), then a tools probe that
 * must come back with a tool call — an endpoint that chats but cannot call
 * tools fails parity and is reported as such.
 */
export async function testConnection(
  provider: Provider,
  modelId: string,
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionResult> {
  const wire = wireIdOf(
    provider.models.find((m) => m.id === modelId),
    modelId,
  );
  const { models: modelsUrl, generate } = endpointsFor(provider, wire);
  const headers = buildHeaders(provider, apiKey);

  let listsModels: boolean | null = null;
  if (modelsUrl !== null) {
    try {
      const res = await fetchImpl(modelsUrl, { method: "GET", headers });
      listsModels = res.ok ? true : res.status === 404 ? null : false;
    } catch {
      listsModels = false;
    }
  }

  let genStatus = 0;
  try {
    const res = await fetchImpl(generate, { method: "POST", headers, body: JSON.stringify(bodyFor(provider, wire, false)) });
    genStatus = res.status;
    await res.text().catch(() => "");
  } catch {
    return {
      reachable: false,
      listsModels,
      supportsTools: null,
      triage: `Could not reach ${hostOf(provider.baseURL)} — check the base URL and that the endpoint is running.`,
    };
  }
  if (genStatus < 200 || genStatus >= 300) {
    return { reachable: false, listsModels, supportsTools: null, triage: triageFor(genStatus) };
  }

  let supportsTools = false;
  try {
    const res = await fetchImpl(generate, { method: "POST", headers, body: JSON.stringify(bodyFor(provider, wire, true)) });
    supportsTools = res.ok && hasToolCall(provider.wireProtocol, await readJson(res));
  } catch {
    supportsTools = false;
  }
  return {
    reachable: true,
    listsModels,
    supportsTools,
    ...(supportsTools ? {} : { triage: "The endpoint answers but cannot call tools, so the agent's tools won't work through it." }),
  };
}

export interface ProviderCatalog {
  claude: { models: ModelOption[]; env: Record<string, string> };
  codex: { models: Record<string, unknown>[] };
  opencode: { models: Record<string, unknown> };
  acp: { configOption: Record<string, unknown> };
}

/** Compile one Provider into each driver's native model/config shape. */
export function catalogFor(provider: Provider): ProviderCatalog {
  const claudeEnv: Record<string, string> = { ...provider.env };
  for (const model of provider.models) {
    if (model.alias) claudeEnv[`ANTHROPIC_DEFAULT_${model.alias.toUpperCase()}_MODEL`] = wireIdOf(model, model.id);
  }

  const opencodeModels: Record<string, unknown> = {};
  for (const model of provider.models) {
    opencodeModels[model.id] = {
      id: wireIdOf(model, model.id),
      name: model.name ?? model.id,
      capabilities: { ...model.capabilities },
      limit: { context: model.contextWindow, output: model.maxOutput },
    };
  }

  return {
    claude: {
      models: provider.models.map((model) => ({ id: wireIdOf(model, model.id), label: model.name ?? model.id })),
      env: claudeEnv,
    },
    codex: {
      models: provider.models.map((model, index) => ({
        slug: wireIdOf(model, model.id),
        display_name: model.name ?? model.id,
        context_window: model.contextWindow,
        max_output_tokens: model.maxOutput,
        // The full entry Codex's model_catalog_json requires; base_instructions is added at injection time.
        supported_reasoning_levels: model.capabilities.reasoning
          ? [
              { effort: "low", description: "Low" },
              { effort: "medium", description: "Medium" },
              { effort: "high", description: "High" },
            ]
          : [],
        shell_type: "unified_exec",
        visibility: "list",
        supported_in_api: true,
        priority: index,
        support_verbosity: false,
        truncation_policy: { mode: "tokens", limit: 10000 },
        experimental_supported_tools: [],
        ...(model.capabilities.reasoning ? { default_reasoning_level: "medium" } : {}),
        input_modalities: model.capabilities.vision ? ["text", "image"] : ["text"],
      })),
    },
    opencode: { models: opencodeModels },
    acp: {
      // Matches ConfigOption in src/main/agents/acp/driver.ts (id/name/type/category/currentValue/options).
      configOption: {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: provider.models[0] ? wireIdOf(provider.models[0], provider.models[0].id) : "default",
        options: provider.models.map((model) => ({ value: wireIdOf(model, model.id), name: model.name ?? model.id })),
      },
    },
  };
}
