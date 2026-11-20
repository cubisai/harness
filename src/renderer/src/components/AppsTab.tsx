import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Star } from "lucide-react";
import type { AppInfo, ExtensionInstallView, Settings } from "../../../shared/types";
import { IconMore } from "../icons";
import { Toggle } from "./Toggle";
import { api } from "../api";
import { useStore } from "../store";
import { appIcon } from "./AppFrame";
import { PluginParts } from "./PluginParts";
import { AppThemeControls } from "./AppThemeControls";

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
  const settings = useStore((s) => s.settings);
  const recordOf = (a: AppInfo) => installs.find((i) => i.kind === "app" && i.name === a.name && (a.scope === "global" ? i.scope.kind === "global" : i.scope.kind === "project" && i.scope.projectId === a.projectId));
  /** A row control on any app (not only the selected one). */
  const rowAct = async (key: string, run: (a: AppInfo) => Promise<unknown>) => {
    const a = apps.find((x) => x.key === key);
    if (!a || busy) return;
    setError(null);
    try {
      await run(a);
      await useStore.getState().loadApps();
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
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
    onEnable={() => void act("enable")} onEdit={() => void act("edit")} onConfirm={(value) => { setConfirm(value); setError(null); }} onUninstall={() => void act("uninstall")}
    onFavorite={(key, on) => void rowAct(key, () => api().setAppFavorite(key, on))}
    onToggle={(key, on) => void rowAct(key, () => api().setAppEnabled(key, on))}
    onOpenKey={(key) => { const a = apps.find((x) => x.key === key); if (a) { useStore.setState({ libraryTab: null }); useStore.getState().openApp(a); } }}
    onReveal={(key) => { const a = apps.find((x) => x.key === key); if (a) void api().revealPath(a.path).catch((err: unknown) => setError(errorText(err))); }}
    onEditKey={(key) => { const a = apps.find((x) => x.key === key); if (a) void useStore.getState().editApp(a); }}
    onUninstallKey={(key) => { setSelected(key); setError(null); const a = apps.find((x) => x.key === key); setConfirm(Boolean(a && recordOf(a))); if (a && !recordOf(a)) setError("This folder has no CubiQ install record, so it can't be uninstalled here."); }}
    builtins={builtinsOf(settings)}
    onBuiltin={(id, on) => void api().updateSettings(builtinPatch(id, on)).then((v) => useStore.setState({ settings: v })).catch((err: unknown) => setError(errorText(err)))} />;
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
  /** Row controls: star, on/off, open, show folder, and Uninstall (asks in the detail pane). */
  onFavorite?(key: string, on: boolean): void;
  onToggle?(key: string, on: boolean): void;
  onOpenKey?(key: string): void;
  onReveal?(key: string): void;
  onEditKey?(key: string): void;
  onUninstallKey?(key: string): void;
  /** CubiQ's own features that already have an on/off setting. */
  builtins?: Builtin[];
  onBuiltin?(id: BuiltinId, on: boolean): void;
}

export type BuiltinId = "memory" | "codeMode" | "uiBlocks" | "linkPreviews" | "issueOffers";
export interface Builtin {
  id: BuiltinId;
  label: string;
  desc: string;
  on: boolean;
}

/** The built-in features listed on the Plugins page: each is an existing setting, nothing new. */
export function builtinsOf(s: Settings | null): Builtin[] {
  if (!s) return [];
  return [
    { id: "memory", label: "Memory", desc: "Shared notes agents keep across threads", on: s.memory?.enabled !== false },
    { id: "codeMode", label: "Code mode", desc: "run_code: one read-only script instead of many reads", on: s.codeMode === "on" },
    { id: "uiBlocks", label: "Inline UI", desc: "Agents may answer with checklists, tables and calculators", on: s.uiBlocks === true },
    { id: "linkPreviews", label: "Link previews", desc: "Pictures for link cards from public sites", on: s.linkPreviews === true },
    { id: "issueOffers", label: "Issue offers", desc: "\"File issue?\" cards when a reply mentions a problem", on: s.issueOffers !== false },
  ];
}

/** The settings patch that turns a built-in feature on or off. */
export function builtinPatch(id: BuiltinId, on: boolean): Partial<Settings> {
  if (id === "memory") return { memory: { enabled: on } as Settings["memory"] };
  if (id === "codeMode") return { codeMode: on ? "on" : "off" };
  return { [id]: on } as Partial<Settings>;
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
        <input className="text-input" aria-label="Search plugins" placeholder="Search plugins" value={p.query} onChange={(e) => p.onQuery(e.target.value)} spellCheck={false} />
        <div className="library-group">Installed</div>
        {shown.map((a) => <PluginRow key={a.key} app={a} selected={a.key === p.selected} busy={busy} p={p} />)}
        {!shown.length && <p className="note apps-list-note">{p.loading ? "Loading apps…" : p.apps.length ? "No matching apps." : "No apps yet. Turn on Creator in the composer's mode menu and ask it to build one, then install it from its review card."}</p>}
        {p.builtins && p.builtins.length > 0 && <>
          <div className="library-group">Built in</div>
          {p.builtins.filter((b) => !query || `${b.label} ${b.desc}`.toLowerCase().includes(query)).map((b) => (
            <div key={b.id} className="plugin-item builtin">
              <div className="plugin-item-main static"><span className="n">{b.label}</span><span className="d">{b.desc}</span></div>
              <Toggle on={b.on} label={`${b.label} ${b.on ? "on" : "off"}`} onChange={(on) => p.onBuiltin?.(b.id, on)} />
            </div>
          ))}
        </>}
      </div>
      <div className="library-detail">
        {p.error && <div className="apps-library-error" role="alert"><p className="form-error">{p.error}</p><button type="button" className="button" disabled={busy || p.loading} onClick={p.onRetry}>Retry</button></div>}
        {app && <>
          <div className="apps-library-title"><Icon size={18} strokeWidth={1.75} aria-hidden /><h3>{app.title}</h3><span className="proposal-chip">{app.scope === "project" ? "Project" : "Global"}</span><span className="proposal-chip">{app.enabled === false ? "Off" : "On"}</span></div>
          <p className="skill-desc">{app.description}</p>
          <div className="apps-library-actions">
            <button type="button" className="button primary" disabled={busy || app.enabled === false || Boolean(app.error)} onClick={p.onOpen}>Open app</button>
            <button type="button" className="button" disabled={busy || Boolean(app.error)} onClick={p.onEdit}>{p.busy?.action === "edit" ? "Preparing draft…" : "Edit with Creator"}</button>
            <button type="button" className="button" disabled={busy} onClick={p.onEnable}>{p.busy?.action === "enable" ? "Saving…" : app.enabled === false ? "Turn on" : "Turn off"}</button>
            <button ref={removeRef} type="button" className="button ghost" disabled={busy || !p.managed} onClick={() => p.onConfirm(true)}>Uninstall</button>
          </div>
          {app.error && <p className="form-error" role="alert">{app.error}</p>}
          {app.enabled === false && <p className="note">Turn this app on to open it. Its saved data is kept while it is off.</p>}
          {!p.managed && <p className="note">This folder has no CubiQ install record. Manage its files manually; it cannot be uninstalled here.</p>}
          <p className="note">Edit with Creator makes a draft. Review its Update card before replacing the installed app.</p>
          {p.confirm && <div className="apps-library-confirm editing" role="group" aria-label="Confirm uninstall" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); p.onConfirm(false); } }}>
            <p>Uninstall {app.title}? Its files and saved app data will be removed. {app.parts?.length ? "Bundled owned parts are removed; external granted connectors are kept." : "Connectors are kept."}</p>
            <div className="apps-library-actions"><button type="button" className="button" autoFocus disabled={busy} onClick={() => p.onConfirm(false)}>Cancel</button><button type="button" className="button danger" disabled={busy} onClick={p.onUninstall}>{p.busy?.action === "uninstall" ? "Uninstalling…" : "Confirm uninstall"}</button></div>
          </div>}
          <section className="apps-library-grants"><h4>Connector tools</h4>
            {app.grants.length ? <ul>{app.grants.flatMap((g) => g.tools.map((tool) => <li key={`${g.server}.${tool}`}><code>{g.server}.{tool}</code></li>))}</ul> : <p className="note">This app has no connector grants.</p>}
            <p className="note">Read-only tools run directly. Tools that can change data ask for your approval.</p>
          </section>
          {!!app.tools?.length && <section className="apps-library-grants"><h4>Agent tools</h4><ul>{app.tools.map((t) => <li key={t.name}><code>{t.name}</code> — {t.description}</li>)}</ul><p className="note">Available in new Chat and Creator threads on any engine. They ask before running, except in Full access. Turning this plugin off also disables its tools.</p></section>}
          {!!app.cards?.length && <section className="apps-library-grants"><h4>Chat cards</h4><p className="note">{app.cards.map((c) => c.name).join(", ")} · Read-only result surfaces</p></section>}
          <PluginParts parts={app.parts} installed />
          {app.parts?.some((p) => p.kind === "app-theme") && <AppThemeControls key={app.key} pluginKey={app.key} />}
          <div className="apps-library-path"><span>App folder</span><code>{app.path}</code></div>
        </>}
      </div>
    </div>
  );
}

/** One installed plugin: select for details, star, switch on/off, open, and ⋯ for the rest. */
function PluginRow({ app, selected, busy, p }: { app: AppInfo; selected: boolean; busy: boolean; p: AppsTabViewProps }) {
  const [menu, setMenu] = useState(false);
  const Icon = appIcon(app.icon);
  const on = app.enabled !== false;
  const close = (fn?: () => void) => () => {
    setMenu(false);
    fn?.();
  };
  return (
    <div className={`plugin-item${selected ? " selected" : ""}${menu ? " menu-open" : ""}`} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMenu(false); }}>
      <button type="button" className="plugin-item-main" aria-pressed={selected} disabled={busy} onClick={() => p.onSelect(app.key)}>
        <Icon size={16} strokeWidth={1.75} aria-hidden className="plugin-item-icon" />
        <span className="n">{app.title}</span>
        <span className="d">{on ? "" : "Off · "}{app.description || app.name}</span>
      </button>
      <button type="button" className={`icon-button plugin-star${app.favorite !== undefined ? " on" : ""}`} aria-pressed={app.favorite !== undefined} aria-label={`Favourite ${app.title}`} title={app.favorite !== undefined ? "Unfavourite" : "Favourite: list it first in the sidebar"} disabled={busy} onClick={() => p.onFavorite?.(app.key, app.favorite === undefined)}>
        <Star size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <Toggle on={on} label={`${app.title} ${on ? "on" : "off"}`} disabled={busy} onChange={(v) => p.onToggle?.(app.key, v)} />
      <button type="button" className="icon-button" aria-label={`Open ${app.title}`} title="Open" disabled={busy || !on || Boolean(app.error)} onClick={() => p.onOpenKey?.(app.key)}>
        <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <span className="plugin-more">
        <button type="button" className="icon-button" aria-haspopup="menu" aria-expanded={menu} aria-label={`${app.title} options`} title="More" disabled={busy} onClick={() => setMenu((m) => !m)}>
          <IconMore />
        </button>
        {menu && (
          <div className="thread-menu" role="menu" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(false); } }}>
            <button role="menuitem" autoFocus disabled={Boolean(app.error)} onClick={close(() => p.onEditKey?.(app.key))}>Edit with Creator</button>
            <button role="menuitem" onClick={close(() => p.onReveal?.(app.key))}>Show folder</button>
            <button role="menuitem" className="danger" onClick={close(() => p.onUninstallKey?.(app.key))}>Uninstall…</button>
          </div>
        )}
      </span>
    </div>
  );
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
