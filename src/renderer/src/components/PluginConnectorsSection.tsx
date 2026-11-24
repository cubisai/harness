import { useEffect, useRef, useState } from "react";
import type { PluginConnectorView } from "../../../shared/plugin-parts";
import { api } from "../api";
import { useStore } from "../store";

/** Owner-scoped settings only: no independent Edit/Remove or automatic probe. */
export function PluginConnectorsSection({ connectors, onReload }: { connectors: PluginConnectorView[]; onReload(): void }) {
  if (!connectors.length) return null;
  return <section className="mcp-section plugin-connectors" aria-label="Bundled connectors">
    <h3>From plugins</h3>
    <p className="mcp-note">Managed by their plugin, for all projects. Turning it on does not connect or sign in.</p>
    {connectors.map((view) => <PluginConnectorRow key={`${view.key}:${view.name}:${view.revision}`} view={view} onReload={onReload} />)}
  </section>;
}

function PluginConnectorRow({ view, onReload }: { view: PluginConnectorView; onReload(): void }) {
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const restorePending = useRef(false);
  const handle = { key: view.key, name: view.name, revision: view.revision };
  const signing = view.signingIn || busy === "Waiting for the browser…";
  const disabled = !view.owner.enabled || Boolean(busy) || view.signingIn;
  const action = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await run(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(""); onReload(); }
  };
  const close = () => { restorePending.current = true; setEditing(false); };
  useEffect(() => {
    if (!editing && !busy && restorePending.current) { opener.current?.focus(); restorePending.current = false; }
  }, [editing, busy]);
  const stateText = !view.owner.enabled ? "Owner Off or unavailable" : view.status.state === "connected" ? `${view.status.tools.length} tools`
    : view.status.state === "checking" ? "Not checked" : view.status.state === "needs-auth" ? "Needs sign-in" : "Needs attention";
  return <div className="mcp-server">
    <div className="mcp-server-main">
      <div className="mcp-server-name">
        <span className="mcp-name-text">{view.name}</span>
        <span className="tag">{view.type === "stdio" ? "Command" : view.type.toUpperCase()}</span>
        <span className="mcp-state">{stateText}</span>
      </div>
      <div className="mcp-source">Plugin · {view.owner.title} · All projects</div>
      <code className="mcp-target" title={view.target}>{view.target}</code>
      <code className="mcp-target">{view.runtimeName}</code>
      {view.type === "stdio" && <p className="mcp-note">Check starts this reviewed command locally.</p>}
      {view.variables.length > 0 && <div className="mcp-keys">{view.variables.map((v) => `${v.name}: ${v.missing ? "required" : v.saved ? "saved" : "from environment"}`).join(" · ")}</div>}
      {view.status.auth?.signedIn && <div className="mcp-meta">Signed in</div>}
      {view.status.error && <p className="mcp-note">{view.status.error}</p>}
      {error && <p className="mcp-error" role="alert">{error}</p>}
      {(busy || signing) && <p className="mcp-note" role="status">{busy || "Waiting for the browser…"}</p>}
      <div className="mcp-review-actions">
        <button type="button" className="button ghost" onClick={() => useStore.setState({ libraryTab: "apps" })}>Manage plugin</button>
        {signing && <button type="button" className="button ghost" onClick={() => void action("Cancelling…", () => api().cancelPluginConnectorSignIn(handle))}>Cancel sign-in</button>}
        <button type="button" className="button ghost" disabled={disabled} onClick={() => void action("Checking…", () => api().checkPluginConnector(handle))}>Check</button>
        {view.canSignIn && <button type="button" className="button ghost" disabled={disabled} onClick={() => void action("Waiting for the browser…", async () => {
          const result = await api().connectPluginConnector(handle);
          if (!result.ok) throw new Error(result.error ?? "Sign-in failed. Try again.");
        })}>{view.status.auth?.signedIn ? "Sign in again" : "Sign in"}</button>}
        {view.status.auth?.signedIn && <button type="button" className="button ghost" disabled={disabled} onClick={() => void action("Signing out…", () => api().disconnectPluginConnector(handle))}>Sign out</button>}
        {(view.variables.length > 0 || view.canSetClientSecret) && <button ref={opener} type="button" className="button ghost" disabled={disabled} onClick={() => { setEditing(true); setError(null); }}>Credentials…</button>}
      </div>
      {editing && <PluginCredentialForm view={view} busy={Boolean(busy)} onCancel={close} onSave={(values, clientSecret) => action("Saving…", async () => {
        await api().savePluginConnector(handle, values, clientSecret); close();
      })} />}
    </div>
  </div>;
}

function PluginCredentialForm({ view, busy, onCancel, onSave }: {
  view: PluginConnectorView; busy: boolean; onCancel(): void; onSave(values: Record<string, string>, clientSecret?: string): Promise<void>;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<string, string>>({}), [cleared, setCleared] = useState<Set<string>>(new Set());
  const [clientSecret, setClientSecret] = useState(""), [clearClient, setClearClient] = useState(false);
  useEffect(() => { form.current?.querySelector<HTMLInputElement>("input")?.focus(); }, []);
  return <form ref={form} className="mcp-review editing" aria-label={`Credentials for ${view.name}`} onKeyDown={(e) => {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onCancel(); }
  }} onSubmit={(e) => {
    e.preventDefault();
    const next = Object.fromEntries(view.variables.flatMap((v) => values[v.name] ? [[v.name, values[v.name]!]] : cleared.has(v.name) ? [[v.name, ""]] : []));
    void onSave(next, clientSecret || (clearClient ? "" : undefined));
  }}>
    <p className="mcp-note">Values stay encrypted in CubiQ. Blank keeps a saved value. Save does not connect or start a run.</p>
    {view.variables.map((v) => <label key={v.name} className="mcp-field">
      <span className="mcp-label">{v.name}</span>
      <span className="mcp-pair">
        <input type="password" className="text-input mcp-pair-value" autoComplete="off" aria-label={v.name} disabled={busy} value={values[v.name] ?? ""} placeholder={cleared.has(v.name) ? "Will be cleared" : v.saved ? "Saved · leave blank to keep" : "Enter value"} onChange={(e) => setValues((old) => ({ ...old, [v.name]: e.target.value }))} />
        {v.saved && <button type="button" className="button ghost" disabled={busy} onClick={() => { setValues((old) => ({ ...old, [v.name]: "" })); setCleared((old) => new Set([...old, v.name])); }}>Clear</button>}
      </span>
    </label>)}
    {view.canSetClientSecret && <label className="mcp-field">
      <span className="mcp-label">Client secret</span>
      <span className="mcp-pair">
        <input type="password" className="text-input mcp-pair-value" autoComplete="off" aria-label="Client secret" disabled={busy} value={clientSecret} placeholder={clearClient ? "Will be cleared" : view.hasClientSecret ? "Saved · leave blank to keep" : "Optional"} onChange={(e) => setClientSecret(e.target.value)} />
        {view.hasClientSecret && <button type="button" className="button ghost" disabled={busy} onClick={() => { setClientSecret(""); setClearClient(true); }}>Clear</button>}
      </span>
    </label>}
    <div className="mcp-review-actions">
      <button type="button" className="button ghost" onClick={onCancel}>Cancel</button>
      <button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    </div>
  </form>;
}
