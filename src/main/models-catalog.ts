// Model discovery for BYOK providers: list the provider's own models, enrich
// them from the models.dev catalog (cached on disk, works offline) and pick a
// cheap tool-capable default. Listing data always wins over models.dev.

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { DiscoveredModel, ModelCapabilities, Provider } from "../shared/types";
import { buildHeaders, endpointsFor } from "./providers";

export type { DiscoveredModel };

export type DiscoveryResult = { ok: true; models: DiscoveredModel[] } | { ok: false; error: string };

/** The subset of models.dev fields the app keeps for a model. */
export interface ModelsDevMetadata {
  contextWindow?: number;
  maxOutput?: number;
  tools?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  cost?: { input: number; output: number };
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 8_192;
const DEFAULT_TIMEOUT_MS = 15_000;
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 10;

interface ModelsDevEntry extends ModelsDevMetadata {
  apiHost?: string;
}

/** Add query params to a URL that may or may not already carry some. */
function withQuery(url: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
}

/** The host of a URL, or undefined when it doesn't parse. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** A finite number from a number or numeric string, else undefined. */
function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function entryFrom(model: any, apiHost: string | undefined): ModelsDevEntry {
  const entry: ModelsDevEntry = {};
  if (apiHost) entry.apiHost = apiHost;
  const context = num(model?.limit?.context);
  if (context !== undefined) entry.contextWindow = context;
  const output = num(model?.limit?.output);
  if (output !== undefined) entry.maxOutput = output;
  if (typeof model?.tool_call === "boolean") entry.tools = model.tool_call;
  if (typeof model?.reasoning === "boolean") entry.reasoning = model.reasoning;
  const modalities = model?.modalities?.input;
  entry.vision = model?.attachment === true || (Array.isArray(modalities) && modalities.includes("image"));
  const input = num(model?.cost?.input);
  const costOutput = num(model?.cost?.output);
  if (input !== undefined && costOutput !== undefined) entry.cost = { input, output: costOutput };
  return entry;
}

/**
 * A disk-backed models.dev catalog. `load` reads a fresh cache file, otherwise
 * fetches, caches atomically and never throws; `lookup` resolves one model id.
 */
export class ModelsDev {
  private readonly file: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly url: string;
  private index: Map<string, ModelsDevEntry[]> | null = null;
  private loading: Promise<void> | null = null;
  /** When the index was last loaded; a load older than the ttl runs again, so a long-running app stays current. */
  private loadedAt: number | null = null;

  constructor(opts: { file: string; fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number; url?: string }) {
    this.file = opts.file;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? MODELS_DEV_TTL_MS;
    this.url = opts.url ?? MODELS_DEV_URL;
  }

  /** Fresh cache file (< ttl) → use it; else fetch url (default https://models.dev/api.json, 15 s timeout) and write the file atomically (tmp + rename); fetch fails → stale file if any; nothing → null. Never throws. Concurrent calls share one load. */
  load(): Promise<void> {
    if (this.loadedAt !== null && this.now() - this.loadedAt < this.ttlMs) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = this.doLoad().finally(() => {
      this.loadedAt = this.now();
      this.loading = null;
    });
    return this.loading;
  }

  /** Metadata for a model id, or null. Match order: exact id; lowercase; the part after the last "/". When several models.dev providers have it, prefer the one whose `api` URL host equals baseURL's host. */
  lookup(id: string, baseURL?: string): ModelsDevMetadata | null {
    const index = this.index;
    if (!index) return null;
    const suffix = id.slice(id.lastIndexOf("/") + 1);
    const candidates = index.get(id) ?? index.get(id.toLowerCase()) ?? index.get(suffix);
    if (!candidates || candidates.length === 0) return null;
    const host = hostOf(baseURL);
    const chosen = (host ? candidates.find((candidate) => candidate.apiHost === host) : undefined) ?? candidates[0];
    if (!chosen) return null;
    const metadata: ModelsDevMetadata = {};
    if (chosen.contextWindow !== undefined) metadata.contextWindow = chosen.contextWindow;
    if (chosen.maxOutput !== undefined) metadata.maxOutput = chosen.maxOutput;
    if (chosen.tools !== undefined) metadata.tools = chosen.tools;
    if (chosen.vision !== undefined) metadata.vision = chosen.vision;
    if (chosen.reasoning !== undefined) metadata.reasoning = chosen.reasoning;
    if (chosen.cost !== undefined) metadata.cost = chosen.cost;
    return metadata;
  }

  private async doLoad(): Promise<void> {
    const fresh = this.readFreshIndex();
    if (fresh) {
      this.index = fresh;
      return;
    }
    try {
      const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
      if (res.ok) {
        const text = await res.text();
        const parsed = this.parse(text);
        if (parsed) {
          this.index = parsed;
          this.writeAtomic(text);
          return;
        }
      }
    } catch {
      // fall through to a stale cache file
    }
    this.index = this.readFileIndex() ?? this.index;
  }

  private readFreshIndex(): Map<string, ModelsDevEntry[]> | null {
    try {
      const stat = statSync(this.file);
      if (this.now() - stat.mtimeMs < this.ttlMs) return this.readFileIndex();
    } catch {
      // no cache file yet
    }
    return null;
  }

  private readFileIndex(): Map<string, ModelsDevEntry[]> | null {
    try {
      return this.parse(readFileSync(this.file, "utf8"));
    } catch {
      return null;
    }
  }

  private writeAtomic(text: string): void {
    try {
      const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      writeFileSync(tmp, text);
      renameSync(tmp, this.file);
    } catch {
      // a failed cache write must not fail discovery
    }
  }

  private parse(text: string): Map<string, ModelsDevEntry[]> | null {
    let root: any;
    try {
      root = JSON.parse(text);
    } catch {
      return null;
    }
    if (!root || typeof root !== "object") return null;
    const index = new Map<string, ModelsDevEntry[]>();
    for (const provider of Object.values(root)) {
      const p = provider as any;
      if (!p || typeof p !== "object") continue;
      const apiHost = hostOf(typeof p.api === "string" ? p.api : undefined);
      if (!p.models || typeof p.models !== "object") continue;
      for (const [key, value] of Object.entries(p.models as Record<string, any>)) {
        if (!value || typeof value !== "object") continue;
        const id = typeof value.id === "string" ? value.id : key;
        const entry = entryFrom(value, apiHost);
        const existing = index.get(id);
        if (existing) existing.push(entry);
        else index.set(id, [entry]);
      }
    }
    return index;
  }
}

/** A listing row before models.dev enrichment; `supplied` marks a row that carried its own limits/capabilities. */
interface ListingModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  tools?: boolean;
  promptCaching?: boolean;
  vision?: boolean;
  cost?: { input: number; output: number };
  supplied: boolean;
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  host: string,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ok: false, error: `Couldn't reach ${host}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: `The key was rejected (HTTP ${res.status}).` };
  if (res.status === 404) return { ok: false, error: "This endpoint doesn't list models (HTTP 404); add models by hand." };
  if (!res.ok) return { ok: false, error: `The model listing failed (HTTP ${res.status}).` };
  try {
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, error: "The model listing wasn't in a format this app reads." };
  }
}

/** OpenAI-style listing: `{ data: [{ id, ... }] }`, with gateway extras passed through. */
function parseOpenAi(json: any): ListingModel[] {
  if (!Array.isArray(json?.data)) return [];
  const models: ListingModel[] = [];
  for (const item of json.data) {
    const id = typeof item?.id === "string" ? item.id : undefined;
    if (!id) continue;
    // Embedding, speech and image models can't drive an agent.
    if (typeof item.type === "string" && item.type !== "chat" && item.type !== "model") continue;
    const contextWindow = num(item.context_length) ?? num(item.context_window);
    const maxOutput = num(item.max_output_tokens) ?? num(item.top_provider?.max_completion_tokens);
    const inputs = item.modalities?.input ?? item.architecture?.input_modalities;
    const vision = Array.isArray(inputs) ? inputs.includes("image") : undefined;
    let tools: boolean | undefined;
    if (Array.isArray(item.supported_parameters) && item.supported_parameters.includes("tools")) tools = true;
    if (tools === undefined) {
      // OpenRouter-style, then TokenHarbor-style flags.
      const flag = [item.supports_tool_calling, item.tool_calling, item.tool_call, item.function_call].find((v) => typeof v === "boolean");
      if (flag !== undefined) tools = flag;
    }
    let cost: { input: number; output: number } | undefined;
    const pricing = item.pricing;
    if (pricing && typeof pricing === "object") {
      const perMillionIn = num(pricing.input) ?? num(pricing.input_usd_per_1m) ?? num(pricing.input_per_m);
      const perMillionOut = num(pricing.output) ?? num(pricing.output_usd_per_1m) ?? num(pricing.output_per_m);
      if (perMillionIn !== undefined && perMillionOut !== undefined) {
        cost = { input: perMillionIn, output: perMillionOut };
      } else {
        const perTokenIn = num(pricing.prompt);
        const perTokenOut = num(pricing.completion);
        if (perTokenIn !== undefined && perTokenOut !== undefined) cost = { input: perTokenIn * 1e6, output: perTokenOut * 1e6 };
      }
    }
    const promptCaching = typeof item.supports_prompt_cache === "boolean" ? item.supports_prompt_cache : undefined;
    const model: ListingModel = { id, supplied: contextWindow !== undefined || maxOutput !== undefined || tools !== undefined || cost !== undefined };
    const name = typeof item.name === "string" ? item.name : typeof item.label === "string" ? item.label : undefined;
    if (name !== undefined) model.name = name;
    if (promptCaching !== undefined) model.promptCaching = promptCaching;
    if (vision !== undefined) model.vision = vision;
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    if (maxOutput !== undefined) model.maxOutput = maxOutput;
    if (tools !== undefined) model.tools = tools;
    if (cost !== undefined) model.cost = cost;
    models.push(model);
  }
  return models;
}

/** Anthropic listing: paginated `{ data: [{ id, display_name }], has_more, last_id }`. */
async function listAnthropic(
  base: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  host: string,
): Promise<{ ok: true; models: ListingModel[] } | { ok: false; error: string }> {
  const models: ListingModel[] = [];
  let url = base;
  for (let page = 0; page < MAX_PAGES; page++) {
    const got = await getJson(url, headers, fetchImpl, timeoutMs, host);
    if (!got.ok) return got;
    const json = got.json as any;
    if (!Array.isArray(json?.data)) return { ok: false, error: "The model listing wasn't in a format this app reads." };
    for (const item of json.data) {
      const id = typeof item?.id === "string" ? item.id : undefined;
      if (!id) continue;
      const model: ListingModel = { id, supplied: false };
      if (typeof item.display_name === "string") model.name = item.display_name;
      models.push(model);
    }
    if (!json.has_more || typeof json.last_id !== "string" || json.last_id === "") break;
    url = withQuery(base, { after_id: json.last_id, limit: "1000" });
  }
  return { ok: true, models };
}

/** Gemini listing: paginated `{ models, nextPageToken }`, generateContent only. */
async function listGemini(
  base: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  host: string,
): Promise<{ ok: true; models: ListingModel[] } | { ok: false; error: string }> {
  const models: ListingModel[] = [];
  let url = base;
  for (let page = 0; page < MAX_PAGES; page++) {
    const got = await getJson(url, headers, fetchImpl, timeoutMs, host);
    if (!got.ok) return got;
    const json = got.json as any;
    if (!Array.isArray(json?.models)) return { ok: false, error: "The model listing wasn't in a format this app reads." };
    for (const item of json.models) {
      const name = typeof item?.name === "string" ? item.name : undefined;
      const methods = item?.supportedGenerationMethods;
      if (!name || !Array.isArray(methods) || !methods.includes("generateContent")) continue;
      const id = name.startsWith("models/") ? name.slice("models/".length) : name;
      const contextWindow = num(item.inputTokenLimit);
      const maxOutput = num(item.outputTokenLimit);
      const model: ListingModel = { id, supplied: contextWindow !== undefined || maxOutput !== undefined };
      if (typeof item.displayName === "string") model.name = item.displayName;
      if (contextWindow !== undefined) model.contextWindow = contextWindow;
      if (maxOutput !== undefined) model.maxOutput = maxOutput;
      models.push(model);
    }
    if (typeof json.nextPageToken !== "string" || json.nextPageToken === "") break;
    url = withQuery(base, { pageToken: json.nextPageToken });
  }
  return { ok: true, models };
}

/** Fold one listing row and its models.dev metadata into a model; listing values win. */
function buildModel(listing: ListingModel, metadata: ModelsDevMetadata | null): DiscoveredModel {
  const capabilities: ModelCapabilities = {
    tools: listing.tools ?? metadata?.tools ?? true,
    vision: listing.vision ?? metadata?.vision ?? false,
    reasoning: metadata?.reasoning ?? false,
    ...(listing.promptCaching !== undefined && { promptCaching: listing.promptCaching }),
  };
  const model: DiscoveredModel = {
    id: listing.id,
    capabilities,
    contextWindow: listing.contextWindow ?? metadata?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutput: listing.maxOutput ?? metadata?.maxOutput ?? DEFAULT_MAX_OUTPUT,
    enriched: listing.supplied || metadata !== null,
  };
  if (listing.name !== undefined) model.name = listing.name;
  const cost = listing.cost ?? metadata?.cost;
  if (cost !== undefined) model.cost = cost;
  return model;
}

/** List a provider's models from its own API, enrich them from models.dev, and dedupe by id in listing order. */
export async function discoverModels(
  provider: Provider,
  apiKey: string | null,
  opts?: { fetchImpl?: typeof fetch; modelsDev?: ModelsDev; timeoutMs?: number },
): Promise<DiscoveryResult> {
  const listingUrl = endpointsFor(provider, "").models;
  if (listingUrl === null) return { ok: false, error: "Raw path mode has no model listing; add models by hand." };

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const host = hostOf(provider.baseURL) ?? provider.baseURL;

  const headers = buildHeaders(provider, apiKey);
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "content-type") delete headers[name];
  }

  let listed: { ok: true; models: ListingModel[] } | { ok: false; error: string };
  switch (provider.wireProtocol) {
    case "openai-chat":
    case "openai-responses": {
      const got = await getJson(listingUrl, headers, fetchImpl, timeoutMs, host);
      if (!got.ok) return got;
      if (!Array.isArray((got.json as any)?.data)) {
        return { ok: false, error: "The model listing wasn't in a format this app reads." };
      }
      listed = { ok: true, models: parseOpenAi(got.json) };
      break;
    }
    case "anthropic-messages":
      listed = await listAnthropic(listingUrl, headers, fetchImpl, timeoutMs, host);
      break;
    case "gemini":
      listed = await listGemini(listingUrl, headers, fetchImpl, timeoutMs, host);
      break;
  }
  if (!listed.ok) return listed;

  await opts?.modelsDev?.load();

  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const listing of listed.models) {
    if (seen.has(listing.id)) continue;
    seen.add(listing.id);
    models.push(buildModel(listing, opts?.modelsDev?.lookup(listing.id, provider.baseURL) ?? null));
  }
  return { ok: true, models };
}

/** The cheapest tool-capable model by input cost, then output cost; undefined when none has a cost. */
export function pickSmallModel(models: DiscoveredModel[]): string | undefined {
  const candidates = models.filter((model) => model.capabilities.tools && model.cost !== undefined);
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => (a.cost!.input - b.cost!.input) || (a.cost!.output - b.cost!.output));
  return candidates[0]?.id;
}
