import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AppThemeHandle, AppThemeSelection, AppThemeSource, AppThemeState, AppThemeView } from "../../shared/app-themes";
import type { StoredProposal } from "../extensions/manifest";
import { validateApp } from "./manifest";

interface Deps { file: string; themes(): AppThemeView[]; proposal(id: string): StoredProposal | null; changed(): void }
type Preview = NonNullable<AppThemeState["preview"]>;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Appearance preferences own no capabilities. Only reviewed bundle content can be selected. */
export class AppThemes {
  private selected: AppThemeSelection | null = null;
  private previews = new Map<number, Preview>();
  private version = 0;
  private catalog = "";
  private error: string | undefined;
  constructor(private deps: Deps) {
    if (!existsSync(deps.file)) return;
    try {
      if (statSync(deps.file).size > 4096) throw new Error("Appearance preference is too large.");
      const data = JSON.parse(readFileSync(deps.file, "utf8"));
      if (data.version !== 1 || !(data.selected === null || (record(data.selected) && typeof data.selected.key === "string" && typeof data.selected.hash === "string" && /^g~[a-z0-9][a-z0-9-]{0,63}$/.test(data.selected.key) && /^[a-f0-9]{64}$/.test(data.selected.hash)))) throw new Error("Invalid appearance selection.");
      this.selected = data.selected === null ? null : { key: data.selected.key, hash: data.selected.hash };
    } catch { this.error = "The saved app theme could not be read. CubiQ's palette is being used; the file was kept."; }
  }
  private save(): void {
    mkdirSync(dirname(this.deps.file), { recursive: true });
    const tmp = `${this.deps.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, selected: this.selected }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.deps.file);
  }
  private publish(): void { this.version++; try { this.deps.changed(); } catch { /* Saved state survives a notification failure. */ } }
  private list(): AppThemeView[] {
    try { return this.deps.themes(); }
    catch { this.error = "Plugin themes could not be read. CubiQ's palette is being used; plugin files were kept."; return []; }
  }
  private installed(source: AppThemeHandle): AppThemeView {
    const theme = this.list().find((t) => t.key === source.key && t.hash === source.hash && t.revision === source.revision);
    if (!theme?.enabled) throw new Error("This app theme is Off, unavailable or changed. Reload its current settings.");
    return theme;
  }
  private source(raw: unknown): { title: string; theme: AppThemeView["theme"] } {
    if (!record(raw)) throw new Error("Invalid app theme identity.");
    if ("proposalId" in raw) {
      if (Object.keys(raw).length !== 1 || typeof raw.proposalId !== "string" || raw.proposalId.length > 80) throw new Error("Invalid app theme proposal.");
      const p = this.deps.proposal(raw.proposalId);
      if (!p || !["staged", "failed"].includes(p.status) || p.scope.kind !== "global" || p.draft.kind !== "app") throw new Error("This theme proposal changed or is no longer awaiting review.");
      const checked = validateApp(p.draft.name, p.draft.files);
      if (!checked.ok) throw new Error(checked.errors.join("\n"));
      if (!checked.manifest.contributes?.appTheme) throw new Error("This proposal has no app theme.");
      return { title: checked.manifest.title, theme: checked.manifest.contributes.appTheme };
    }
    if (Object.keys(raw).length !== 3 || Object.keys(raw).some((k) => !["key", "revision", "hash"].includes(k)) || typeof raw.key !== "string" || typeof raw.revision !== "string" || typeof raw.hash !== "string") throw new Error("Invalid app theme handle.");
    return this.installed({ key: raw.key, revision: raw.revision, hash: raw.hash });
  }
  reconcile(): void {
    const themes = this.list(), catalog = JSON.stringify(themes);
    let changed = catalog !== this.catalog;
    this.catalog = catalog;
    if (this.selected && !themes.some((t) => t.enabled && t.key === this.selected!.key && t.hash === this.selected!.hash)) {
      this.selected = null;
      this.error = "The selected app theme changed or became unavailable. Reverted to CubiQ; apply its current palette separately.";
      try { this.save(); } catch { this.error += " The appearance preference could not be saved."; }
      changed = true;
    }
    for (const [id, p] of this.previews) {
      try { if (JSON.stringify(this.source(p.source).theme) !== JSON.stringify(p.theme)) throw new Error("Preview content changed."); }
      catch { this.previews.delete(id); changed = true; }
    }
    if (changed) this.publish();
  }
  state(windowId: number): AppThemeState {
    const themes = this.list();
    const selected = themes.find((t) => t.enabled && t.key === this.selected?.key && t.hash === this.selected?.hash);
    return { version: this.version, selected: this.selected, themes, active: selected?.theme ?? null, preview: this.previews.get(windowId) ?? null, ...(this.error ? { error: this.error } : {}) };
  }
  preview(windowId: number, raw: AppThemeSource): AppThemeState {
    const resolved = this.source(raw);
    this.previews.set(windowId, { token: randomUUID(), windowId, source: structuredClone(raw), ...resolved });
    this.error = undefined; this.publish(); return this.state(windowId);
  }
  apply(windowId: number, handle: AppThemeHandle, previewToken?: string): AppThemeState {
    this.source(handle);
    if ("proposalId" in handle) throw new Error("Install this theme before applying it.");
    if (previewToken !== undefined) {
      const p = this.previews.get(windowId);
      if (!p || p.token !== previewToken || JSON.stringify(p.source) !== JSON.stringify(handle)) throw new Error("This preview was superseded. Preview the current theme again.");
    }
    const before = this.selected;
    this.selected = { key: handle.key, hash: handle.hash };
    try { this.save(); } catch (error) { this.selected = before; throw error; }
    this.previews.clear(); this.error = undefined; this.publish(); return this.state(windowId);
  }
  revert(windowId: number): AppThemeState {
    const before = this.selected; this.selected = null;
    try { this.save(); } catch (error) { this.selected = before; throw error; }
    this.previews.clear(); this.error = undefined; this.publish(); return this.state(windowId);
  }
  cancel(windowId: number, token: string): AppThemeState {
    if (this.previews.get(windowId)?.token !== token) throw new Error("This preview was already cancelled or superseded.");
    this.previews.delete(windowId); this.publish(); return this.state(windowId);
  }
  closeWindow(windowId: number): void { if (this.previews.delete(windowId)) this.publish(); }
  cancelPreviews(): void { if (this.previews.size) { this.previews.clear(); this.publish(); } }
}
