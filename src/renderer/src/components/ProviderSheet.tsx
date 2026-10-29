import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useRef, useState } from "react";
import type {
  CatalogProvider,
  ConnectionResult,
  DiscoveredModel,
  ModelDiscovery,
  ProviderInput,
  ProviderModel,
  ProviderView,
  WireProtocol,
} from "../../../shared/types";
import { PROVIDER_PRESETS, providerPreset, type ProviderPreset } from "../../../shared/provider-catalog";
import { api } from "../api";
import { useStore } from "../store";
import { Select, type SelectOption } from "./Select";

const WIRE_PROTOCOLS: WireProtocol[] = ["anthropic-messages", "openai-responses", "openai-chat", "gemini"];
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CAPS = ["tools", "vision", "reasoning"] as const;

/** How Anthropic Messages sends the key; `auto` picks by host. */
type AuthStyle = "auto" | "bearer" | "x-api-key";

const AUTH_OPTIONS: SelectOption<AuthStyle>[] = [
  { value: "auto", label: "Automatic (X-Api-Key on api.anthropic.com, Bearer elsewhere)" },
  { value: "bearer", label: "Authorization: Bearer" },
  { value: "x-api-key", label: "X-Api-Key" },
];

/** One header row: a plain one, or a secret whose value travels separately (and stays encrypted). */
interface HeaderRow {
  key: string;
  value: string;
  secret: boolean;
  /** A value already stored (a loaded secret header): an empty value keeps it. */
  stored: boolean;
}

interface QueryRow {
  key: string;
  value: string;
}

/** A context window as a compact K/M label, e.g. 128000 → "128K". */
function contextSize(tokens: number): string {
  // One decimal at most, and none when it rounds to a whole number (1,048,576 → "1M").
  const short = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  if (tokens >= 1_000_000) return `${short(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${short(tokens / 1_000)}K`;
  return String(tokens);
}

/** "id · 128K ctx · $0.10 / $0.40 per 1M · tools", for one discovered model. */
function discoveredMeta(m: DiscoveredModel): string {
  const parts = [m.id];
  if (m.contextWindow > 0) parts.push(`${contextSize(m.contextWindow)} ctx`);
  if (m.cost) parts.push(`$${m.cost.input.toFixed(2)} / $${m.cost.output.toFixed(2)} per 1M`);
  if (m.capabilities.tools) parts.push("tools");
  return parts.join(" · ");
}

/** The host (plus a non-default port) of a URL — never userinfo, path or query. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return "invalid URL";
  }
}

/** The provider rows: migration banner, then one row per provider. Pure props. */
export function ProviderList({
  providers,
  migratedProviders,
  onEdit,
}: {
  providers: ProviderView[];
  migratedProviders: string[];
  onEdit?: (id: string) => void;
}) {
  return (
    <>
      {migratedProviders.length > 0 && (
        <p className="notice" role="status">
          Your saved keys now live in Providers. Nothing was deleted.
        </p>
      )}
      {providers.length === 0 ? (
        <p className="note">No providers yet.</p>
      ) : (
        providers.map((p) => (
          <div className="provider-item" key={p.id}>
            <div className="provider-item-main">
              <span className="provider-item-name">{migratedProviders.includes(p.id) ? `${p.label} (from your saved key)` : p.label}</span>
              <span className="provider-item-meta">
                {p.wireProtocol} · {hostOf(p.baseURL)} · {p.models.length === 1 ? "1 model" : `${p.models.length} models`}
              </span>
            </div>
            {p.hasSecret ? (
              <span className="provider-item-status">
                <span className="dot-ok" /> Saved
              </span>
            ) : (
              <span className="provider-item-status muted">Not configured</span>
            )}
            <button className="button ghost" onClick={() => onEdit?.(p.id)}>
              Edit
            </button>
          </div>
        ))
      )}
    </>
  );
}

/**
 * What the editor saves: its own fields over the existing provider, so the
 * fields it doesn't show (headers, env, query params, retries) survive an edit.
 * The label comes from the fields for a new provider (the picked preset's, or
 * the id when blank); an existing provider keeps its stored label, since the
 * editor passes no label for it (and an undefined one never overwrites it).
 */
export function toProviderInput(
  provider: ProviderView | undefined,
  fields: Pick<
    ProviderInput,
    | "id"
    | "wireProtocol"
    | "baseURL"
    | "models"
    | "pathMode"
    | "betaHeaders"
    | "headers"
    | "queryParams"
    | "retries"
    | "contextWindowOverride"
    | "authStyle"
    | "smallModel"
    | "secretHeaderNames"
  > & { label?: string },
): ProviderInput {
  const { label, ...rest } = fields;
  if (!provider) return { ...rest, label: label?.trim() || fields.id };
  const { secretKind: _kind, hasSecret: _has, ...kept } = provider;
  return { ...kept, ...rest, id: provider.id };
}

/** The preset pick list: a custom provider first, then every known preset. */
export function presetOptions(): SelectOption<string>[] {
  return [{ value: "", label: "Custom" }, ...PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label }))];
}

/** Pick a known provider preset to prefill the editor; "" means a custom provider. */
export function PresetPicker({ value, onPick }: { value: string; onPick: (preset: ProviderPreset | null) => void }) {
  return (
    <div className="row">
      <span className="label">Preset</span>
      <Select value={value} options={presetOptions()} onChange={(v) => onPick(providerPreset(v) ?? null)} ariaLabel="Preset" />
    </div>
  );
}

/** One catalog result's sub-line: protocol, host and how many models models.dev lists. */
export function catalogMeta(entry: CatalogProvider): string {
  return `${entry.wireProtocol} · ${hostOf(entry.baseURL)} · ${entry.models.length} model${entry.models.length === 1 ? "" : "s"}`;
}

/** Search models.dev's providers; picking one prefills the editor. Results show only while there's a query. */
export function CatalogSearch({ onPick }: { onPick: (entry: CatalogProvider) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogProvider[]>([]);
  const latest = useRef(0);
  const search = (text: string) => {
    setQuery(text);
    const ticket = ++latest.current;
    if (!text.trim()) return setResults([]);
    void api()
      .searchProviderCatalog(text)
      .then((found) => {
        // A slower answer to an older query never replaces a newer one.
        if (ticket === latest.current) setResults(found);
      })
      .catch(() => {
        if (ticket === latest.current) setResults([]);
      });
  };
  return (
    <div className="row provider-models-row">
      <span className="label">Catalog</span>
      <div className="provider-catalog">
        <input
          className="text-input"
          placeholder="Search models.dev providers"
          aria-label="Search models.dev providers"
          value={query}
          spellCheck={false}
          onChange={(e) => search(e.target.value)}
        />
        {query.trim() !== "" && (
          <div className="provider-discover-list" role="group" aria-label="Catalog providers">
            {results.length === 0 ? (
              <p className="note">No provider matches. The catalog needs one download (models.dev) to work offline.</p>
            ) : (
              results.map((entry) => (
                <button
                  type="button"
                  className="provider-discover-row provider-catalog-row"
                  key={entry.id}
                  onClick={() => {
                    onPick(entry);
                    setQuery("");
                    setResults([]);
                  }}
                >
                  <span className="provider-discover-main">
                    <span className="provider-discover-name">{entry.name}</span>
                    <span className="provider-discover-meta">{catalogMeta(entry)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The provider editor: protocol → base URL → credential → models, then the two escape hatches. */
function ProviderEditor({
  provider,
  takenIds,
  onSaved,
  onClose,
}: {
  provider?: ProviderView;
  takenIds?: readonly string[];
  onSaved: (id: string) => void;
  onClose: () => void;
}) {
  const existing = provider !== undefined;
  const [id, setId] = useState(provider?.id ?? "");
  const [label, setLabel] = useState(provider?.label ?? "");
  const [presetId, setPresetId] = useState("");
  const [catalogPick, setCatalogPick] = useState<CatalogProvider | null>(null);
  const [wireProtocol, setWireProtocol] = useState<WireProtocol>(provider?.wireProtocol ?? "anthropic-messages");
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? "");
  const [secret, setSecret] = useState("");
  const [models, setModels] = useState<ProviderModel[]>(provider?.models ?? []);
  const [pathMode, setPathMode] = useState<"auto" | "raw">(provider?.pathMode ?? "auto");
  const [betaHeaders, setBetaHeaders] = useState<"default" | "strip">(provider?.betaHeaders ?? "default");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => [
    ...Object.entries(provider?.headers ?? {}).map(([key, value]): HeaderRow => ({ key, value, secret: false, stored: false })),
    ...(provider?.secretHeaderNames ?? []).map((key): HeaderRow => ({ key, value: "", secret: true, stored: true })),
  ]);
  const [queryRows, setQueryRows] = useState<QueryRow[]>(() => Object.entries(provider?.queryParams ?? {}).map(([key, value]) => ({ key, value })));
  const [retryRequest, setRetryRequest] = useState(provider?.retries?.request !== undefined ? String(provider.retries.request) : "");
  const [retryStream, setRetryStream] = useState(provider?.retries?.stream !== undefined ? String(provider.retries.stream) : "");
  const [retryIdle, setRetryIdle] = useState(provider?.retries?.streamIdleTimeoutMs !== undefined ? String(provider.retries.streamIdleTimeoutMs) : "");
  const [contextOverride, setContextOverride] = useState(provider?.contextWindowOverride !== undefined ? String(provider.contextWindowOverride) : "");
  const [authStyle, setAuthStyle] = useState<AuthStyle>(provider?.authStyle ?? "auto");
  const [smallModel, setSmallModel] = useState(provider?.smallModel ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [discovery, setDiscovery] = useState<ModelDiscovery | null>(null);
  const [discoverFilter, setDiscoverFilter] = useState("");
  const [discoverPicked, setDiscoverPicked] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const advancedId = useId();

  const preset = providerPreset(presetId);
  /** Where the prefilled fields came from: a curated preset, else a catalog pick. */
  const origin = preset ?? catalogPick;

  const patchModel = (i: number, patch: Partial<ProviderModel>) =>
    setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const patchHeader = (i: number, patch: Partial<HeaderRow>) =>
    setHeaderRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const patchQuery = (i: number, patch: Partial<QueryRow>) =>
    setQueryRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  /**
   * What Save, Test and Fetch all send: the editor's fields over the stored
   * provider (`undefined` clears a stored one), plus new secret header values
   * that travel once. `secretHeaderNames` is always set so an unticked or
   * removed stored secret is dropped.
   */
  const draft = (): { input: ProviderInput; headerValues: Record<string, string> } => {
    const headers: Record<string, string> = {};
    const headerValues: Record<string, string> = {};
    const secretHeaderNames: string[] = [];
    for (const row of headerRows) {
      const key = row.key.trim();
      if (!key) continue;
      if (row.secret) {
        if (row.value !== "") headerValues[key] = row.value;
        else if (row.stored) secretHeaderNames.push(key);
      } else {
        headers[key] = row.value;
      }
    }
    const queryParams: Record<string, string> = {};
    for (const row of queryRows) {
      const key = row.key.trim();
      if (key) queryParams[key] = row.value;
    }
    const numberOrUndefined = (text: string): number | undefined => {
      const trimmed = text.trim();
      if (trimmed === "") return undefined;
      const value = Number(trimmed);
      return Number.isFinite(value) ? value : undefined;
    };
    const retries: NonNullable<ProviderInput["retries"]> = {};
    const request = numberOrUndefined(retryRequest);
    const stream = numberOrUndefined(retryStream);
    const idle = numberOrUndefined(retryIdle);
    if (request !== undefined) retries.request = request;
    if (stream !== undefined) retries.stream = stream;
    if (idle !== undefined) retries.streamIdleTimeoutMs = idle;
    const input = toProviderInput(provider, {
      id,
      wireProtocol,
      baseURL: baseURL.trim(),
      models,
      pathMode,
      betaHeaders,
      label,
      headers: Object.keys(headers).length ? headers : undefined,
      queryParams: Object.keys(queryParams).length ? queryParams : undefined,
      retries: Object.keys(retries).length ? retries : undefined,
      contextWindowOverride: numberOrUndefined(contextOverride),
      authStyle: wireProtocol === "anthropic-messages" && authStyle !== "auto" ? authStyle : undefined,
      smallModel: smallModel !== "" && models.some((m) => m.id === smallModel) ? smallModel : undefined,
      secretHeaderNames,
    });
    return { input, headerValues };
  };

  const save = async () => {
    if (!existing && !PROVIDER_ID_RE.test(id)) {
      setError("Use lowercase letters, digits and dashes: my-gateway.");
      return;
    }
    if (!existing && takenIds?.includes(id)) {
      setError(`A provider with id ${id} exists: edit it, or pick another id.`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { input, headerValues } = draft();
      await api().saveProvider(input, secret.trim() ? secret : undefined, headerValues);
      setSecret("");
      // A typed secret header is stored now: clear the field and keep the row as saved.
      setHeaderRows((rows) => rows.map((r) => (r.secret && r.value !== "" ? { ...r, value: "", stored: true } : r)));
      setResult(null);
      useStore.setState({ settings: await api().getSettings() });
      onSaved(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      await api().removeProvider(id);
      useStore.setState({ settings: await api().getSettings() });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const model = models[0];
    if (!model) return;
    setError(null);
    setBusy(true);
    try {
      const { input, headerValues } = draft();
      setResult(await api().testProvider(input, model.id, secret.trim() || undefined, headerValues));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fetchModels = async () => {
    setError(null);
    setBusy(true);
    try {
      const { input, headerValues } = draft();
      const found = await api().discoverProviderModels(input, secret.trim() || undefined, headerValues);
      if (!found.ok) {
        setDiscovery(null);
        setError(found.error);
        return;
      }
      setDiscovery(found);
      setDiscoverFilter("");
      // Nothing ticked: a gateway can list dozens of models, and the user adds the few they want.
      setDiscoverPicked(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleDiscovered = (modelId: string) =>
    setDiscoverPicked((picked) => {
      const next = new Set(picked);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });

  const addDiscovered = () => {
    if (!discovery?.ok) return;
    // The price stays on the model: turns through the gateway are costed from it.
    const toPlain = ({ enriched: _enriched, ...model }: DiscoveredModel): ProviderModel => model;
    const toAdd = discovery.models.filter((m) => discoverPicked.has(m.id) && !models.some((x) => x.id === m.id)).map(toPlain);
    if (!toAdd.length) return;
    setModels((ms) => [...ms, ...toAdd]);
    if (smallModel === "" && discovery.smallModel && toAdd.some((m) => m.id === discovery.smallModel)) setSmallModel(discovery.smallModel);
    setDiscovery(null);
    setDiscoverFilter("");
    setDiscoverPicked(new Set());
  };

  const closeDiscovery = () => {
    setDiscovery(null);
    setDiscoverFilter("");
    setDiscoverPicked(new Set());
  };

  const candidates = discovery?.ok ? discovery.models.filter((m) => !models.some((x) => x.id === m.id)) : [];
  const filterText = discoverFilter.trim().toLowerCase();
  const visibleDiscovered = filterText
    ? candidates.filter((m) => m.id.toLowerCase().includes(filterText) || (m.name ?? "").toLowerCase().includes(filterText))
    : candidates;

  return (
    <div className="provider-editor">
      {!existing && (
        <>
          <PresetPicker
            value={presetId}
            onPick={(picked) => {
              setPresetId(picked?.id ?? "");
              setCatalogPick(null);
              // Custom keeps what's typed, but not a preset's label: it isn't shown, so the id names it.
              if (!picked) return setLabel("");
              setId(picked.id);
              setLabel(picked.label);
              setWireProtocol(picked.wireProtocol);
              setBaseURL(picked.baseURL);
              setResult(null);
              setError(null);
            }}
          />
          <CatalogSearch
            onPick={(entry) => {
              // A curated preset with the same id wins: it was checked live.
              const curated = providerPreset(entry.id);
              setPresetId(curated?.id ?? "");
              setCatalogPick(curated ? null : entry);
              setId(entry.id);
              setLabel(curated?.label ?? entry.name);
              setWireProtocol(curated?.wireProtocol ?? entry.wireProtocol);
              setBaseURL(curated?.baseURL ?? entry.baseURL);
              setResult(null);
              setError(null);
              // Its models go to the pick list, not straight in: a router can list hundreds.
              if (entry.models.length) {
                setDiscovery({ ok: true, models: entry.models });
                setDiscoverFilter("");
                setDiscoverPicked(new Set());
              }
            }}
          />
          <div className="row">
            <span className="label">Id</span>
            <input className="text-input" placeholder="my-gateway" value={id} onChange={(e) => setId(e.target.value)} />
          </div>
        </>
      )}
      <div className="row">
        <span className="label">Protocol</span>
        <Select
          value={wireProtocol}
          options={WIRE_PROTOCOLS.map((w): SelectOption<string> => ({ value: w, label: w }))}
          onChange={(v) => setWireProtocol(v as WireProtocol)}
          ariaLabel="Protocol"
        />
      </div>
      <div className="row">
        <span className="label">Base URL</span>
        <input className="text-input" placeholder="https://gateway.example.com/v1" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
      </div>
      {origin?.docs && <p className="note">Docs: {origin.docs}</p>}
      {preset?.alsoServes && <p className="note">This URL also serves {preset.alsoServes.join(" and ")}.</p>}
      {catalogPick && <p className="note">From models.dev, not tested by CubiQ: use Test before saving.</p>}
      <div className="row">
        <span className="label">Credential</span>
        <input
          className="text-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={provider?.hasSecret ? "Saved — type to replace" : preset?.local ? "Any value (local server)" : origin?.keyVar ? `API key (${origin.keyVar})` : "API key"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </div>
      <div className="row provider-models-row">
        <span className="label">Models</span>
        <div className="provider-models">
          {models.map((m, i) => (
            <div className="provider-model" key={i}>
              <div className="line">
                <input className="text-input" placeholder="model id" value={m.id} onChange={(e) => patchModel(i, { id: e.target.value })} />
                <input
                  className="text-input"
                  placeholder="wire id (optional)"
                  value={m.modelID ?? ""}
                  onChange={(e) => patchModel(i, { modelID: e.target.value || undefined })}
                />
                <input
                  className="text-input num"
                  type="number"
                  title="Context window"
                  aria-label="Context window"
                  value={m.contextWindow}
                  onChange={(e) => patchModel(i, { contextWindow: Number(e.target.value) || 0 })}
                />
                <input
                  className="text-input num"
                  type="number"
                  title="Max output"
                  aria-label="Max output"
                  value={m.maxOutput}
                  onChange={(e) => patchModel(i, { maxOutput: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="line">
                {CAPS.map((cap) => (
                  <label className="provider-check" key={cap}>
                    <input
                      type="checkbox"
                      checked={m.capabilities[cap]}
                      onChange={(e) => patchModel(i, { capabilities: { ...m.capabilities, [cap]: e.target.checked } })}
                    />
                    {cap}
                  </label>
                ))}
                <Select
                  className="alias"
                  value={m.alias ?? ""}
                  options={[
                    { value: "", label: "No alias" },
                    { value: "opus", label: "opus" },
                    { value: "sonnet", label: "sonnet" },
                    { value: "haiku", label: "haiku" },
                  ]}
                  onChange={(v) => patchModel(i, { alias: (v || undefined) as ProviderModel["alias"] })}
                  ariaLabel="Alias"
                />
                <button className="button ghost danger remove" type="button" onClick={() => setModels((ms) => ms.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div className="provider-model-actions">
            <button
              className="button ghost"
              type="button"
              onClick={() =>
                setModels((ms) => [...ms, { id: "", capabilities: { tools: true, vision: false, reasoning: false }, contextWindow: 0, maxOutput: 0 }])
              }
            >
              Add model
            </button>
            <button className="button ghost" type="button" disabled={!baseURL.trim() || busy} onClick={() => void fetchModels()}>
              Fetch models
            </button>
          </div>
          <div className="provider-small">
            <span className="provider-small-label">Small model</span>
            <Select<string>
              value={smallModel}
              options={[
                { value: "", label: "Same as the main model" },
                ...models.filter((m) => m.id.trim() !== "").map((m): SelectOption<string> => ({ value: m.id, label: m.id })),
              ]}
              onChange={setSmallModel}
              ariaLabel="Small model"
            />
            <p className="note">A cheaper model the agent uses for side tasks, such as titles and summaries.</p>
          </div>
          {discovery?.ok && (
            <div className="provider-discover">
              <input
                className="text-input"
                placeholder="Filter models"
                aria-label="Filter models"
                value={discoverFilter}
                spellCheck={false}
                onChange={(e) => setDiscoverFilter(e.target.value)}
              />
              <div className="provider-discover-list" role="group" aria-label="Discovered models">
                {visibleDiscovered.length === 0 ? (
                  <p className="note">No models to add.</p>
                ) : (
                  visibleDiscovered.map((m) => (
                    <label className="provider-discover-row" key={m.id}>
                      <input type="checkbox" checked={discoverPicked.has(m.id)} onChange={() => toggleDiscovered(m.id)} />
                      <span className="provider-discover-main">
                        <span className="provider-discover-name">{m.name ?? m.id}</span>
                        <span className="provider-discover-meta">{discoveredMeta(m)}</span>
                      </span>
                    </label>
                  ))
                )}
              </div>
              <div className="provider-discover-actions">
                <button className="button primary" type="button" disabled={discoverPicked.size === 0} onClick={addDiscovered}>
                  Add {discoverPicked.size} model{discoverPicked.size === 1 ? "" : "s"}
                </button>
                <button className="button ghost" type="button" onClick={closeDiscovery}>
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="provider-advanced">
        <button
          type="button"
          className="provider-disclosure"
          aria-expanded={advanced}
          aria-controls={advancedId}
          onClick={() => setAdvanced((a) => !a)}
        >
          {advanced ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          Advanced
        </button>
        {advanced && (
          <div className="provider-advanced-body" id={advancedId}>
            {wireProtocol === "anthropic-messages" && (
              <div className="row">
                <span className="label">Key header</span>
                <div className="provider-auth">
                  <Select<AuthStyle> value={authStyle} options={AUTH_OPTIONS} onChange={setAuthStyle} ariaLabel="Key header" />
                </div>
              </div>
            )}
            <div className="row">
              <span className="label">Headers</span>
              <div className="provider-pairs">
                {headerRows.map((row, i) => (
                  <div className="provider-pair" key={i}>
                    <input
                      className="text-input"
                      placeholder="Header"
                      aria-label="Header name"
                      value={row.key}
                      spellCheck={false}
                      onChange={(e) => patchHeader(i, { key: e.target.value })}
                    />
                    <input
                      className="text-input"
                      type={row.secret ? "password" : "text"}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={row.secret && row.stored ? "Saved — type to replace" : "Value"}
                      aria-label={row.key.trim() ? `${row.key.trim()} value` : "Header value"}
                      value={row.value}
                      onChange={(e) => patchHeader(i, { value: e.target.value })}
                    />
                    <label className="provider-check">
                      <input type="checkbox" checked={row.secret} onChange={(e) => patchHeader(i, { secret: e.target.checked })} />
                      Secret
                    </label>
                    <button className="button ghost remove" type="button" onClick={() => setHeaderRows((rows) => rows.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </div>
                ))}
                <div>
                  <button className="button ghost" type="button" onClick={() => setHeaderRows((rows) => [...rows, { key: "", value: "", secret: false, stored: false }])}>
                    Add header
                  </button>
                </div>
                <p className="note">
                  {"Secret values are encrypted and reach the agent only through its environment. A value of ${env:VAR} is read from your environment when the agent starts."}
                </p>
              </div>
            </div>
            <div className="row">
              <span className="label">Query params</span>
              <div className="provider-pairs">
                {queryRows.map((row, i) => (
                  <div className="provider-pair" key={i}>
                    <input
                      className="text-input"
                      placeholder="Parameter"
                      aria-label="Query parameter name"
                      value={row.key}
                      spellCheck={false}
                      onChange={(e) => patchQuery(i, { key: e.target.value })}
                    />
                    <input
                      className="text-input"
                      placeholder="Value"
                      aria-label={row.key.trim() ? `${row.key.trim()} value` : "Query parameter value"}
                      value={row.value}
                      spellCheck={false}
                      onChange={(e) => patchQuery(i, { value: e.target.value })}
                    />
                    <button className="button ghost remove" type="button" onClick={() => setQueryRows((rows) => rows.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </div>
                ))}
                <div>
                  <button className="button ghost" type="button" onClick={() => setQueryRows((rows) => [...rows, { key: "", value: "" }])}>
                    Add parameter
                  </button>
                </div>
                <p className="note">Sent by Codex and OpenCode (chat-completions only).</p>
              </div>
            </div>
            <div className="row">
              <span className="label">Retries</span>
              <div className="provider-retries">
                <input className="text-input num" type="number" aria-label="Request" placeholder="Request" value={retryRequest} onChange={(e) => setRetryRequest(e.target.value)} />
                <input className="text-input num" type="number" aria-label="Stream" placeholder="Stream" value={retryStream} onChange={(e) => setRetryStream(e.target.value)} />
                <input
                  className="text-input num"
                  type="number"
                  aria-label="Idle timeout (ms)"
                  placeholder="Idle timeout (ms)"
                  value={retryIdle}
                  onChange={(e) => setRetryIdle(e.target.value)}
                />
                <p className="note">Codex only.</p>
              </div>
            </div>
            <div className="row">
              <span className="label">Context window</span>
              <div className="provider-context">
                <input
                  className="text-input num"
                  type="number"
                  aria-label="Context window override"
                  placeholder="Each model's own"
                  value={contextOverride}
                  onChange={(e) => setContextOverride(e.target.value)}
                />
                <p className="note">Overrides every model&apos;s context window.</p>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="row provider-options-row">
        <span className="label">Options</span>
        <div className="provider-options">
          <label className="provider-option">
            <input type="checkbox" checked={pathMode === "raw"} onChange={(e) => setPathMode(e.target.checked ? "raw" : "auto")} />
            <span>
              Send the URL exactly as typed
              <span className="note">Fixes a 404 from a doubled /v1 or a chat-vs-responses path.</span>
            </span>
          </label>
          <label className="provider-option">
            <input type="checkbox" checked={betaHeaders === "strip"} onChange={(e) => setBetaHeaders(e.target.checked ? "strip" : "default")} />
            <span>
              Strip experimental headers
              <span className="note">For gateways that reject anthropic-beta.</span>
            </span>
          </label>
        </div>
      </div>

      <div className="row end">
        <button className="button primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        {existing && (
          <button className="button danger" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        )}
        <button className="button" disabled={models.length === 0 || !baseURL.trim() || busy} onClick={() => void test()}>
          Test connection
        </button>
      </div>
      {result && (
        <div className="note">
          <div>Reachable: {result.reachable ? "yes" : "no"}</div>
          <div>Lists models: {result.listsModels === null ? "—" : result.listsModels ? "yes" : "no"}</div>
          <div>Tool calling: {result.supportsTools === null ? "—" : result.supportsTools ? "yes" : "no"}</div>
          {result.triage && <div>{result.triage}</div>}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

/** Settings → Providers: the list and the add/edit editor. */
export function ProvidersSection() {
  const settings = useStore((s) => s.settings);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  if (!settings) return null;

  const active = adding || editing !== null;
  return (
    <section>
      <h3>Providers</h3>
      <p className="note">
        {settings.secretsEncrypted
          ? "Stored encrypted with your system keychain, and only ever passed to the agent they belong to."
          : "This system has no keychain available, so keys are stored obfuscated, not encrypted."}{" "}
        Each provider shows up as its own agent in the model picker; Claude, Codex and OpenCode always use their own sign-in. Saving or removing a key restarts running agents.
      </p>
      <ProviderList
        providers={settings.providers}
        migratedProviders={settings.migratedProviders}
        onEdit={(id) => {
          setAdding(false);
          setEditing(id);
        }}
      />
      {active ? (
        <ProviderEditor
          key={editing ?? "new"}
          provider={settings.providers.find((p) => p.id === editing)}
          takenIds={settings.providers.map((p) => p.id)}
          onSaved={(id) => {
            setAdding(false);
            setEditing(id);
          }}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      ) : (
        <div className="provider-add">
          <button className="button ghost" onClick={() => setAdding(true)}>
            + Add provider
          </button>
        </div>
      )}
    </section>
  );
}
