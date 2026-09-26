import { useState } from "react";
import type {
  ConnectionResult,
  CredentialChoice,
  ProviderInput,
  ProviderModel,
  ProviderView,
  WireProtocol,
} from "../../../shared/types";
import { codexCompatible, providerWarning } from "../../../shared/provider-rules";
import { api } from "../api";
import { useStore } from "../store";

const WIRE_PROTOCOLS: WireProtocol[] = ["anthropic-messages", "openai-responses", "openai-chat", "gemini"];
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CAPS = ["tools", "vision", "reasoning"] as const;

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
          <div className="row" key={p.id}>
            <span className="label">{migratedProviders.includes(p.id) ? `${p.label} (from your saved key)` : p.label}</span>
            <span className="chip mono">{p.wireProtocol}</span>
            <span className="value">{hostOf(p.baseURL)}</span>
            <span className="note">{p.models.length === 1 ? "1 model" : `${p.models.length} models`}</span>
            {p.hasSecret ? (
              <span className="value">
                <span className="dot-ok" /> Saved
              </span>
            ) : (
              <span className="value">Not configured</span>
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
 * One credential row per agent above the provider list. Subscription stays a
 * first-class peer; Antigravity is excluded (its gate is phase 9).
 */
export function CredentialRows({
  agents,
  providers,
  credentials,
  onChange,
}: {
  agents: { id: string; label: string }[];
  providers: ProviderView[];
  credentials: Record<string, CredentialChoice>;
  onChange: (agentId: string, choice: CredentialChoice) => void;
}) {
  return (
    <>
      {agents
        .filter((agent) => agent.id !== "antigravity")
        .map((agent) => {
          const choice = credentials[agent.id] ?? { kind: "subscription" as const };
          const builtIn = agent.id === "claude" || agent.id === "codex";
          const selected = choice.kind === "byok" ? choice.providerId : "subscription";
          const provider = choice.kind === "byok" ? providers.find((p) => p.id === choice.providerId) : undefined;
          const warning = agent.id === "claude" && provider ? providerWarning(provider, "claude") : null;
          return (
            <div key={agent.id}>
              <div className="row">
                <span className="label">{agent.label}</span>
                <select
                  className="select"
                  value={selected}
                  onChange={(e) =>
                    onChange(agent.id, e.target.value === "subscription" ? { kind: "subscription" } : { kind: "byok", providerId: e.target.value })
                  }
                >
                  <option value="subscription">{builtIn ? "Subscription login" : "Agent's own config"}</option>
                  {providers.map((p) => {
                    const compat = agent.id === "codex" ? codexCompatible(p) : ({ ok: true } as const);
                    return (
                      <option key={p.id} value={p.id} disabled={!compat.ok} title={compat.ok ? undefined : compat.reason}>
                        {p.label}
                      </option>
                    );
                  })}
                </select>
              </div>
              {warning && <p className="note">{warning}</p>}
            </div>
          );
        })}
    </>
  );
}

/**
 * What the editor saves: its own fields over the existing provider, so the
 * fields it doesn't show (headers, env, query params, retries, label) survive an edit.
 */
export function toProviderInput(
  provider: ProviderView | undefined,
  fields: Pick<ProviderInput, "id" | "wireProtocol" | "baseURL" | "models" | "pathMode" | "betaHeaders">,
): ProviderInput {
  if (!provider) return { label: fields.id, ...fields };
  const { secretKind: _kind, hasSecret: _has, ...kept } = provider;
  return { ...kept, ...fields, id: provider.id };
}

/** The provider editor: protocol → base URL → credential → models, then the two escape hatches. */
function ProviderEditor({ provider, onSaved, onClose }: { provider?: ProviderView; onSaved: (id: string) => void; onClose: () => void }) {
  const existing = provider !== undefined;
  const [id, setId] = useState(provider?.id ?? "");
  const [wireProtocol, setWireProtocol] = useState<WireProtocol>(provider?.wireProtocol ?? "anthropic-messages");
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? "");
  const [secret, setSecret] = useState("");
  const [models, setModels] = useState<ProviderModel[]>(provider?.models ?? []);
  const [pathMode, setPathMode] = useState<"auto" | "raw">(provider?.pathMode ?? "auto");
  const [betaHeaders, setBetaHeaders] = useState<"default" | "strip">(provider?.betaHeaders ?? "default");
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patchModel = (i: number, patch: Partial<ProviderModel>) =>
    setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  const save = async () => {
    if (!existing && !PROVIDER_ID_RE.test(id)) {
      setError("Use lowercase letters, digits and dashes: my-gateway.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const input = toProviderInput(provider, { id, wireProtocol, baseURL: baseURL.trim(), models, pathMode, betaHeaders });
      await api().saveProvider(input, secret.trim() ? secret : undefined);
      setSecret("");
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
      setResult(await api().testProvider(id, model.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-editor">
      {!existing && (
        <div className="row">
          <span className="label">Id</span>
          <input className="text-input" placeholder="my-gateway" value={id} onChange={(e) => setId(e.target.value)} />
        </div>
      )}
      <div className="row">
        <span className="label">Protocol</span>
        <select className="select" value={wireProtocol} onChange={(e) => setWireProtocol(e.target.value as WireProtocol)}>
          {WIRE_PROTOCOLS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <span className="label">Base URL</span>
        <input className="text-input" placeholder="https://gateway.example.com/v1" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
      </div>
      <div className="row">
        <span className="label">Credential</span>
        <input
          className="text-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={provider?.hasSecret ? "Saved — type to replace" : "API key"}
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
                  value={m.contextWindow}
                  onChange={(e) => patchModel(i, { contextWindow: Number(e.target.value) || 0 })}
                />
                <input
                  className="text-input num"
                  type="number"
                  title="Max output"
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
                <select
                  className="select alias"
                  value={m.alias ?? ""}
                  onChange={(e) => patchModel(i, { alias: (e.target.value || undefined) as ProviderModel["alias"] })}
                >
                  <option value="">No alias</option>
                  <option value="opus">opus</option>
                  <option value="sonnet">sonnet</option>
                  <option value="haiku">haiku</option>
                </select>
                <button className="button ghost danger" type="button" onClick={() => setModels((ms) => ms.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div className="row">
            <span className="label" />
            <button
              className="button ghost"
              type="button"
              onClick={() =>
                setModels((ms) => [...ms, { id: "", capabilities: { tools: true, vision: false, reasoning: false }, contextWindow: 0, maxOutput: 0 }])
              }
            >
              Add model
            </button>
          </div>
        </div>
      </div>
      <div className="row">
        <span className="label" />
        <label className="provider-check">
          <input type="checkbox" checked={pathMode === "raw"} onChange={(e) => setPathMode(e.target.checked ? "raw" : "auto")} />
          Send the URL exactly as typed
        </label>
      </div>
      <p className="note">Fixes a 404 from a doubled /v1 or a chat-vs-responses path.</p>
      <div className="row">
        <span className="label" />
        <label className="provider-check">
          <input type="checkbox" checked={betaHeaders === "strip"} onChange={(e) => setBetaHeaders(e.target.checked ? "strip" : "default")} />
          Strip experimental headers
        </label>
      </div>
      <p className="note">For gateways that reject anthropic-beta.</p>

      <div className="row end">
        <button className="button primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        {existing && (
          <button className="button danger" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        )}
        <button className="button" disabled={!existing || models.length === 0 || busy} onClick={() => void test()}>
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

/** Settings → Providers: the credential rows, the list, and the add/edit editor. */
export function ProvidersSection() {
  const settings = useStore((s) => s.settings);
  const agents = useStore((s) => s.agents);
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
        Saving or removing a key restarts running agents.
      </p>
      <CredentialRows
        agents={agents}
        providers={settings.providers}
        credentials={settings.providerCredential}
        onChange={(agentId, choice) => void api().setCredential(agentId, choice).then((s) => useStore.setState({ settings: s }))}
      />
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
        <div className="row">
          <span className="label" />
          <button className="button" onClick={() => setAdding(true)}>
            Add provider
          </button>
        </div>
      )}
    </section>
  );
}
