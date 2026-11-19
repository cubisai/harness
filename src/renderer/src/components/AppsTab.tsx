import { useCallback, useEffect, useRef, useState } from "react";
import type { AppInfo, ExtensionInstallView } from "../../../shared/types";
import { api } from "../api";
import { useStore } from "../store";
import { appIcon } from "./AppFrame";

type AppAction = "enable" | "edit" | "uninstall";

export function AppsTab() {
  const projectId = useStore((s) => s.selectedProjectId);
  const changed = useStore((s) => s.apps);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [installs, setInstalls] = useState<ExtensionInstallView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ key: string; action: AppAction } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const request = useRef(0);
  const reload = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const [list, records] = await Promise.all([api().listApps(projectId), api().listExtensionInstalls(projectId)]);
      if (request.current !== id) return;
      setApps(list);
      setInstalls(records);
      setSelected((key) => list.some((a) => a.key === key) ? key : (list[0]?.key ?? null));
      setError(null);
    } catch (err) {
      if (request.current === id) setError(errorText(err));
    } finally {
      if (request.current === id) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
    return () => { request.current++; };
  }, [reload, changed]);

  const picked = apps.find((a) => a.key === selected) ?? null;
  const record = picked ? installs.find((i) => i.kind === "app" && i.name === picked.name && (picked.scope === "global" ? i.scope.kind === "global" : i.scope.kind === "project" && i.scope.projectId === picked.projectId)) : undefined;
  const act = async (action: AppAction) => {
    if (!picked || busy) return;
    setBusy({ key: picked.key, action });
    setError(null);
    try {
      if (action === "enable") await api().setAppEnabled(picked.key, picked.enabled === false);
      else if (action === "uninstall" && record) {
        await api().uninstallExtension(record.id);
        setConfirm(false);
      } else if (action === "edit") {
        await useStore.getState().editApp(picked);
        return;
      }
      await useStore.getState().loadApps();
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return <AppsTabView apps={apps} selected={selected} query={query} loading={loading} error={error} busy={busy} confirm={confirm} managed={Boolean(record)}
    onQuery={setQuery} onSelect={(key) => { setSelected(key); setConfirm(false); setError(null); }} onRetry={() => void reload()}
    onOpen={() => { if (picked) { useStore.setState({ libraryTab: null }); useStore.getState().openApp(picked); } }}
    onEnable={() => void act("enable")} onEdit={() => void act("edit")} onConfirm={(value) => { setConfirm(value); setError(null); }} onUninstall={() => void act("uninstall")} />;
}

export interface AppsTabViewProps {
  apps: AppInfo[];
  selected: string | null;
  query: string;
  loading: boolean;
  error: string | null;
  busy: { key: string; action: AppAction } | null;
  confirm: boolean;
  managed: boolean;
  onQuery(value: string): void;
  onSelect(key: string): void;
  onRetry(): void;
  onOpen(): void;
  onEnable(): void;
  onEdit(): void;
  onConfirm(value: boolean): void;
  onUninstall(): void;
}

/** Stateless management surface; Library lists disabled apps too, unlike the sidebar. */
export function AppsTabView(p: AppsTabViewProps) {
  const removeRef = useRef<HTMLButtonElement>(null);
  const confirming = useRef(false);
  useEffect(() => {
    if (confirming.current && !p.confirm) removeRef.current?.focus();
    confirming.current = p.confirm;
  }, [p.confirm]);
  const query = p.query.trim().toLowerCase();
  const shown = p.apps.filter((a) => !query || `${a.title} ${a.name} ${a.description}`.toLowerCase().includes(query));
  const app = p.apps.find((a) => a.key === p.selected);
  const Icon = appIcon(app?.icon);
  const busy = Boolean(p.busy);
  return (
    <div className="library-split apps-library" aria-busy={p.loading || busy}>
      <div className="library-list">
        <input className="text-input" aria-label="Search apps" placeholder="Search apps" value={p.query} onChange={(e) => p.onQuery(e.target.value)} spellCheck={false} />
        <div className="library-group">Installed in CubiQ</div>
        {shown.map((a) => <button type="button" key={a.key} className={`library-item${a.key === p.selected ? " selected" : ""}`} aria-pressed={a.key === p.selected} disabled={busy} onClick={() => p.onSelect(a.key)}>
          <span className="n">{a.title}</span>
          <span className="d">{a.enabled === false ? "Disabled · " : ""}{a.description || a.name}</span>
        </button>)}
        {!shown.length && <p className="note apps-list-note">{p.loading ? "Loading apps…" : p.apps.length ? "No matching apps." : "No apps yet. Ask Creator to build one, then install it from its review card."}</p>}
      </div>
      <div className="library-detail">
        {p.error && <div className="apps-library-error" role="alert"><p className="form-error">{p.error}</p><button type="button" className="button" disabled={busy || p.loading} onClick={p.onRetry}>Retry</button></div>}
        {app && <>
          <div className="apps-library-title"><Icon size={18} strokeWidth={1.75} aria-hidden /><h3>{app.title}</h3><span className="proposal-chip">{app.scope === "project" ? "Project" : "Global"}</span><span className="proposal-chip">{app.enabled === false ? "Disabled" : "Enabled"}</span></div>
          <p className="skill-desc">{app.description}</p>
          <div className="apps-library-actions">
            <button type="button" className="button primary" disabled={busy || app.enabled === false || Boolean(app.error)} onClick={p.onOpen}>Open app</button>
            <button type="button" className="button" disabled={busy || Boolean(app.error)} onClick={p.onEdit}>{p.busy?.action === "edit" ? "Preparing draft…" : "Edit with Creator"}</button>
            <button type="button" className="button" disabled={busy} onClick={p.onEnable}>{p.busy?.action === "enable" ? "Saving…" : app.enabled === false ? "Enable" : "Disable"}</button>
            <button ref={removeRef} type="button" className="button ghost" disabled={busy || !p.managed} onClick={() => p.onConfirm(true)}>Uninstall</button>
          </div>
          {app.error && <p className="form-error" role="alert">{app.error}</p>}
          {app.enabled === false && <p className="note">Enable this app to open it. Its saved data is kept while disabled.</p>}
          {!p.managed && <p className="note">This folder has no CubiQ install record. Manage its files manually; it cannot be uninstalled here.</p>}
          <p className="note">Edit with Creator makes a draft. Review its Update card before replacing the installed app.</p>
          {p.confirm && <div className="apps-library-confirm editing" role="group" aria-label="Confirm uninstall" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); p.onConfirm(false); } }}>
            <p>Uninstall {app.title}? Its files and saved app data will be removed. Connectors are kept.</p>
            <div className="apps-library-actions"><button type="button" className="button" autoFocus disabled={busy} onClick={() => p.onConfirm(false)}>Cancel</button><button type="button" className="button danger" disabled={busy} onClick={p.onUninstall}>{p.busy?.action === "uninstall" ? "Uninstalling…" : "Confirm uninstall"}</button></div>
          </div>}
          <section className="apps-library-grants"><h4>Connector tools</h4>
            {app.grants.length ? <ul>{app.grants.flatMap((g) => g.tools.map((tool) => <li key={`${g.server}.${tool}`}><code>{g.server}.{tool}</code></li>))}</ul> : <p className="note">This app has no connector grants.</p>}
            <p className="note">Read-only tools run directly. Tools that can change data ask for your approval.</p>
          </section>
          <div className="apps-library-path"><span>App folder</span><code>{app.path}</code></div>
        </>}
      </div>
    </div>
  );
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
