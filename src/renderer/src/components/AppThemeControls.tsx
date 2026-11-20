import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppThemeSource, AppThemeState } from "../../../shared/app-themes";
import { api } from "../api";
import { chromeSafetyStyle } from "../app-themes";
import { acceptAppThemeState, useStore } from "../store";
import { Select } from "./Select";

let opener: HTMLElement | null = null;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export function rememberThemePreviewFocus(): void {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
}
export function restoreThemePreviewFocus(target: HTMLElement | null = opener): void {
  if (target?.isConnected && !target.matches(":disabled")) target.focus();
}
export async function cancelThemePreview(token: string, restore = false): Promise<AppThemeState> {
  const state = await api().cancelAppThemePreview(token);
  acceptAppThemeState(state);
  if (restore) restoreThemePreviewFocus();
  return state;
}

/** The same explicit actions in Appearance, Plugins detail and an app proposal. */
export function AppThemeControls({ pluginKey, proposalId }: { pluginKey?: string; proposalId?: string }) {
  const appearance = !pluginKey && !proposalId;
  const state = useStore((s) => s.appThemes);
  const [choice, setChoice] = useState(state?.selected?.key ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!state);
  const ownerToken = useRef<string | null>(null);
  const busyRef = useRef(false);
  const loadRequest = useRef(0);
  const live = useRef(true);
  const previewButton = useRef<HTMLButtonElement>(null);
  const focusAfterAction = useRef<HTMLButtonElement | null>(null);
  const load = async () => {
    const request = ++loadRequest.current;
    setLoading(true); setError(null);
    try { const next = await api().appThemeState(); if (live.current && request === loadRequest.current) acceptAppThemeState(next); }
    catch (err) { if (live.current && request === loadRequest.current) setError(message(err)); }
    finally { if (live.current && request === loadRequest.current) setLoading(false); }
  };
  useEffect(() => {
    live.current = true;
    if (!useStore.getState().appThemes) void load();
    return () => { live.current = false; loadRequest.current++; if (ownerToken.current) void cancelThemePreview(ownerToken.current).catch(() => {}); };
  }, []);
  useEffect(() => { if (!pluginKey && !proposalId) setChoice(state?.selected?.key ?? ""); }, [state?.selected?.key, pluginKey, proposalId]);
  useLayoutEffect(() => {
    if (busy || !focusAfterAction.current) return;
    const target = focusAfterAction.current;
    focusAfterAction.current = null;
    restoreThemePreviewFocus(target);
  });
  const theme = state?.themes.find((t) => t.key === (pluginKey ?? choice));
  const source: AppThemeSource | undefined = proposalId ? { proposalId } : theme ? { key: theme.key, revision: theme.revision, hash: theme.hash } : undefined;
  const previewing = state?.preview && JSON.stringify(state.preview.source) === JSON.stringify(source);
  const selected = theme && state?.selected?.key === theme.key && state.selected.hash === theme.hash;
  const action = async (run: () => Promise<AppThemeState>, preview = false, restore = false) => {
    if (busyRef.current) return;
    const target = restore ? previewButton.current : null;
    busyRef.current = true;
    setBusy(true); setError(null);
    if (preview) rememberThemePreviewFocus();
    try {
      const next = await run();
      if (!live.current) { if (preview && next.preview) void cancelThemePreview(next.preview.token).catch(() => {}); return; }
      if (preview) ownerToken.current = next.preview?.token ?? null;
      if (restore) focusAfterAction.current = target;
      acceptAppThemeState(next);
    } catch (err) { if (live.current) setError(message(err)); }
    finally { busyRef.current = false; if (live.current) setBusy(false); }
  };
  return <div className={`app-theme-controls${appearance ? " app-theme-appearance" : ""}`} style={chromeSafetyStyle()} aria-busy={busy || loading}>
    {!pluginKey && !proposalId && <Select<string> value={choice} ariaLabel="App theme" disabled={busy || loading} onChange={setChoice}
      options={[{ value: "", label: "CubiQ", detail: "Default palette" }, ...(state?.themes ?? []).map((t) => ({ value: t.key, label: t.title, detail: t.error ?? (state?.selected?.key === t.key ? "Applied" : "From plugin"), disabled: !t.enabled }))]} />}
    {proposalId && <p className="note">Preview only. Install first, then apply separately.</p>}
    {previewing && <p className="note" role="status">Previewing app theme · {state!.preview!.title}</p>}
    {loading && <span role="status">Loading app themes…</span>}
    <div className="app-theme-actions">
      {source && <button ref={previewButton} type="button" className="button ghost" aria-label={appearance ? "Preview app theme" : undefined} disabled={busy || (!proposalId && !theme?.enabled)} onClick={() => void action(() => api().previewAppTheme(source), true)}>{appearance ? "Preview" : "Preview theme"}</button>}
      {theme && !proposalId && !selected && <button type="button" className="button" disabled={busy || !theme.enabled} onClick={() => void action(() => api().applyAppTheme({ key: theme.key, revision: theme.revision, hash: theme.hash }, previewing ? state!.preview!.token : undefined))}>Apply theme</button>}
      {selected && !appearance && <span className="app-theme-status" role="status">Applied</span>}
      {previewing && <button type="button" className="button" disabled={busy} onClick={() => void action(() => cancelThemePreview(state!.preview!.token), false, true)}>Cancel preview</button>}
      {!proposalId && state?.selected && (!pluginKey || state.selected.key === pluginKey) && <button type="button" className="button" disabled={busy} onClick={() => void action(() => api().revertAppTheme())}>Revert to CubiQ</button>}
    </div>
    {theme?.error && <p className="note">{theme.error}</p>}
    {state?.error && <p className="note">{state.error}</p>}
    {error && <p className="form-error" role="alert">{error} <button type="button" className="button ghost" disabled={busy} onClick={() => void load()}>Retry</button></p>}
    {!proposalId && !pluginKey && state && !state.themes.length && <p className="note">No plugin app themes installed. CubiQ's default palette is available.</p>}
  </div>;
}

/** Visible recovery stays in baseline colors, independent of the candidate palette. */
export function AppThemePreviewBar() {
  const preview = useStore((s) => s.appThemes?.preview);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!preview) return null;
  return <section className="app-theme-preview" style={chromeSafetyStyle()} aria-label="App theme preview">
    <span>Previewing app theme · <strong>{preview.title}</strong></span>
    <button type="button" className="button" disabled={busy} onClick={async () => { setBusy(true); try { await cancelThemePreview(preview.token, true); setError(null); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>Cancel preview</button>
    {!("proposalId" in preview.source) && <button type="button" className="button" disabled={busy} onClick={async () => { setBusy(true); try { acceptAppThemeState(await api().applyAppTheme(preview.source as Exclude<AppThemeSource, { proposalId: string }>, preview.token)); setError(null); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>Apply theme</button>}
    {error && <p className="note" role="alert">{error}</p>}
  </section>;
}
