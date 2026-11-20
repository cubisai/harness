// Where installed Creator apps live and how a frame's key maps back to a folder. Global apps sit in CubiQ's own
// data folder; project apps in the project's `.cubiq/apps`. Nothing is ever read from or written to another agent's
// config. app.json is re-read only when its mtime changes.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppInfo } from "../../shared/types";
import { APP_MANIFEST, APP_MAX_FILE_BYTES, APP_MAX_FILES, type AppManifest, parseAppManifest } from "./manifest";
import { appUrl } from "./serve";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export type AppKey =
  | { scope: "global"; name: string }
  | { scope: "project"; projectId: string; name: string }
  /** A Creator thread's work in progress, previewed before it is proposed. */
  | { scope: "draft"; threadId: string; name: string };

export function encodeAppKey(k: AppKey): string {
  return k.scope === "global" ? `g~${k.name}` : k.scope === "project" ? `p~${k.projectId}~${k.name}` : `d~${k.threadId}~${k.name}`;
}

export function decodeAppKey(key: string): AppKey | null {
  const parts = key.split("~");
  if (parts[0] === "g" && parts.length === 2 && NAME_RE.test(parts[1]!)) return { scope: "global", name: parts[1]! };
  if (parts[0] === "p" && parts.length === 3 && PROJECT_ID_RE.test(parts[1]!) && NAME_RE.test(parts[2]!)) return { scope: "project", projectId: parts[1]!, name: parts[2]! };
  if (parts[0] === "d" && parts.length === 3 && PROJECT_ID_RE.test(parts[1]!) && NAME_RE.test(parts[2]!)) return { scope: "draft", threadId: parts[1]!, name: parts[2]! };
  return null;
}

export interface AppRegistryDeps {
  /** `<userData>/apps`. */
  globalDir: string;
  /** Enable state lives outside app files so it doesn't change their install hashes. */
  stateFile?: string;
  /** Favourites (key → when starred), its own file so the enable-state file keeps the format older versions read. */
  favoritesFile?: string;
  /** A real project's folder (not the Chats root), or null. */
  projectPath(projectId: string): string | null;
  /** A Creator thread's drafts folder (`<thread folder>/.cubiq/app-drafts`), or null when it isn't a Creator thread. */
  draftsDir?(threadId: string): string | null;
  /** Reviewed bundle recovery/integrity gate. Drafts and ordinary apps keep their existing behaviour. */
  installedError?(key: string): string | null;
  installedParts?(key: string): import("../../shared/plugin-parts").PluginPartView[];
}

export const projectAppsDir = (projectPath: string): string => join(projectPath, ".cubiq", "apps");
export const appDraftsDir = (threadFolder: string): string => join(threadFolder, ".cubiq", "app-drafts");
/** Edit sessions must not overwrite another Creator thread's draft of the same installed app. */
export const appEditDraftsDir = (threadFolder: string, threadId: string): string => join(appDraftsDir(threadFolder), ".edits", threadId);

export class AppRegistry {
  private cache = new Map<string, { mtime: number; manifest: AppManifest | null; error: string | null }>();
  private disabled = new Set<string>();
  private favorites = new Map<string, number>();

  constructor(private deps: AppRegistryDeps) {
    if (deps.favoritesFile) {
      try {
        const raw: unknown = JSON.parse(readFileSync(deps.favoritesFile, "utf-8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const [key, at] of Object.entries(raw)) {
            const k = decodeAppKey(key);
            if (k && k.scope !== "draft" && typeof at === "number" && Number.isFinite(at)) this.favorites.set(key, at);
          }
        }
      } catch {
        // No favourites yet.
      }
    }
    if (deps.stateFile) {
      try {
        const keys: unknown = JSON.parse(readFileSync(deps.stateFile, "utf-8"));
        if (Array.isArray(keys)) for (const key of keys) if (typeof key === "string" && decodeAppKey(key)?.scope !== "draft" && decodeAppKey(key)) this.disabled.add(key);
      } catch {
        // A new profile has no enable state yet.
      }
    }
  }

  isEnabled(key: string): boolean {
    return !this.disabled.has(key);
  }

  setEnabled(key: string, enabled: boolean): void {
    const k = decodeAppKey(key);
    if (!k || k.scope === "draft") throw new Error("Only installed apps can be enabled or disabled.");
    const dir = this.dirOf(k);
    if (!dir || !existsSync(dir)) throw new Error("App not found.");
    this.writeEnabled(key, enabled);
  }

  resetEnabled(key: string): void {
    if (this.disabled.has(key)) this.writeEnabled(key, true);
    if (this.favorites.has(key)) this.setFavorite(key, false);
  }

  /** Star or unstar an installed app; the sidebar lists starred apps first, oldest star first. */
  setFavorite(key: string, on: boolean, now = Date.now()): void {
    const k = decodeAppKey(key);
    if (!k || k.scope === "draft") throw new Error("Only installed apps can be favourites.");
    const next = new Map(this.favorites);
    if (on) {
      if (next.has(key)) return;
      next.set(key, now);
    } else if (!next.delete(key)) return;
    if (this.deps.favoritesFile) {
      mkdirSync(dirname(this.deps.favoritesFile), { recursive: true });
      const tmp = `${this.deps.favoritesFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries([...next].sort((a, b) => a[1] - b[1]))), { mode: 0o600 });
      renameSync(tmp, this.deps.favoritesFile);
    }
    this.favorites = next;
  }

  private writeEnabled(key: string, enabled: boolean): void {
    const next = new Set(this.disabled);
    if (enabled) next.delete(key); else next.add(key);
    if (this.deps.stateFile) {
      mkdirSync(dirname(this.deps.stateFile), { recursive: true });
      const tmp = `${this.deps.stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify([...next].sort()), { mode: 0o600 });
      renameSync(tmp, this.deps.stateFile);
    }
    this.disabled = next;
  }

  dirOf(k: AppKey): string | null {
    if (k.scope === "global") return join(this.deps.globalDir, k.name);
    if (k.scope === "draft") {
      const d = this.deps.draftsDir?.(k.threadId) ?? null;
      return d ? join(d, k.name) : null;
    }
    const p = this.deps.projectPath(k.projectId);
    return p ? join(projectAppsDir(p), k.name) : null;
  }

  /** One app's listing entry (a draft included), or null when the key names nothing. */
  info(key: string): AppInfo | null {
    const k = decodeAppKey(key);
    const dir = k ? this.dirOf(k) : null;
    if (!k || !dir) return null;
    return this.entry(k, dir);
  }

  /** Re-read app.json on the next request even if its mtime looks unchanged (a draft rewritten within the same tick). */
  forget(dir: string): void {
    this.cache.delete(dir);
  }

  /** The folder a frame key serves, only for an app whose app.json is valid. */
  root(key: string): string | null {
    if (!this.isEnabled(key)) return null;
    const k = decodeAppKey(key);
    if (k && k.scope !== "draft" && this.deps.installedError?.(key)) return null;
    const dir = k ? this.dirOf(k) : null;
    return dir && this.read(dir, k!.scope !== "draft").manifest ? dir : null;
  }

  manifest(key: string): AppManifest | null {
    if (!this.isEnabled(key)) return null;
    const k = decodeAppKey(key);
    if (k && k.scope !== "draft" && this.deps.installedError?.(key)) return null;
    const dir = k ? this.dirOf(k) : null;
    return dir ? this.read(dir, k!.scope !== "draft").manifest : null;
  }

  /** Global apps, then the project's own (a project app shadows a global one of the same name). */
  list(projectId: string | null): AppInfo[] {
    const out: AppInfo[] = [];
    const scan = (base: string, make: (name: string) => AppKey) => {
      let names: string[];
      try {
        names = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME_RE.test(d.name)).map((d) => d.name);
      } catch {
        return;
      }
      for (const name of names.sort()) {
        out.push(this.entry(make(name), join(base, name)));
      }
    };
    const projectPath = projectId ? this.deps.projectPath(projectId) : null;
    const own = new Set<string>();
    if (projectId && projectPath) {
      scan(projectAppsDir(projectPath), (name) => ({ scope: "project", projectId, name }));
      for (const a of out) own.add(a.name);
    }
    const before = out.length;
    scan(this.deps.globalDir, (name) => ({ scope: "global", name }));
    return [...out.slice(before).filter((a) => !own.has(a.name)), ...out.slice(0, before)];
  }

  private entry(k: AppKey, dir: string): AppInfo {
    const { manifest, error } = this.read(dir, k.scope !== "draft");
    const key = encodeAppKey(k), runtimeError = k.scope !== "draft" ? this.deps.installedError?.(key) : null;
    const parts = k.scope !== "draft" ? this.deps.installedParts?.(key) : undefined;
    return {
      key: encodeAppKey(k),
      name: k.name,
      scope: k.scope,
      ...(k.scope === "project" ? { projectId: k.projectId } : {}),
      title: manifest?.title ?? k.name,
      description: manifest?.description ?? "",
      ...(manifest?.icon ? { icon: manifest.icon } : {}),
      grants: manifest?.grants ?? [],
      ...(this.isEnabled(encodeAppKey(k)) ? {} : { enabled: false }),
      ...(this.favorites.has(encodeAppKey(k)) ? { favorite: this.favorites.get(encodeAppKey(k))! } : {}),
      path: dir,
      url: appUrl(encodeAppKey(k), manifest?.entry ?? "index.html"),
      ...(runtimeError || error ? { error: runtimeError || error! } : {}),
      ...(parts?.length ? { parts } : {}),
      ...(manifest?.placement === "floating" ? { placement: "floating" as const, ...(manifest.size ? { size: manifest.size } : {}) } : {}),
      ...(manifest?.placement === "page" ? { placement: "page" as const } : {}),
      ...(manifest?.placement === "dock" || manifest?.placement === "panel" ? { placement: manifest.placement, ...(manifest.height ? { height: manifest.height } : {}) } : {}),
      ...(manifest?.style === "own" ? { style: "own" as const } : {}),
      ...(manifest?.tools?.length ? { tools: manifest.tools } : {}),
      ...(manifest?.cards?.length ? { cards: manifest.cards } : {}),
    };
  }

  /** A draft is being written while it is shown: its entry page can appear after app.json, so it is never cached. */
  private read(dir: string, cached = true): { manifest: AppManifest | null; error: string | null } {
    const file = join(dir, APP_MANIFEST);
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      this.cache.delete(dir);
      return { manifest: null, error: existsSync(dir) ? "app.json is missing." : "The app folder is gone." };
    }
    const hit = cached ? this.cache.get(dir) : undefined;
    if (hit && hit.mtime === mtime) return hit;
    let entry: { mtime: number; manifest: AppManifest | null; error: string | null };
    try {
      const paths = new Set(listFiles(dir));
      const name = dir.split(/[\\/]/).pop()!;
      const r = parseAppManifest(readFileSync(file, "utf-8"), paths, name);
      entry = { mtime, manifest: r.manifest, error: r.manifest ? null : r.errors.join(" ") };
    } catch (e) {
      entry = { mtime, manifest: null, error: (e as Error).message };
    }
    if (cached) this.cache.set(dir, entry);
    return entry;
  }
}

/**
 * An app folder's files as a proposal carries them (text, forward-slash paths), for validateApp. Dot entries are
 * skipped; a symlink or a file that isn't UTF-8 text is an error, never followed or read as bytes.
 */
export function readAppFiles(dir: string): { files: { path: string; content: string }[]; errors: string[] } {
  const files: { path: string; content: string }[] = [];
  const errors: string[] = [];
  const walk = (rel: string): void => {
    for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (d.name.startsWith(".")) continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (files.length + errors.length > APP_MAX_FILES) return;
      if (d.isSymbolicLink()) errors.push(`"${p}" is a symlink; apps hold plain files only.`);
      else if (d.isDirectory()) walk(p);
      else if (d.isFile()) {
        const abs = join(dir, ...p.split("/"));
        if (statSync(abs).size > APP_MAX_FILE_BYTES) {
          errors.push(`"${p}" is over ${APP_MAX_FILE_BYTES / 1024} KB.`);
          continue;
        }
        const buf = readFileSync(abs);
        const content = buf.toString("utf-8");
        if (content.includes("\uFFFD") || content.includes("\0")) errors.push(`"${p}" is not UTF-8 text.`);
        else files.push({ path: p, content });
      }
    }
  };
  try {
    walk("");
  } catch (e) {
    errors.push(`Couldn't read the app folder: ${(e as Error).message}`);
  }
  return { files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), errors };
}

/** Relative file paths under `dir` (forward slashes), skipping dot entries; bounded so a huge folder can't stall. */
function listFiles(dir: string, rel = "", out: string[] = []): string[] {
  if (out.length > 500) return out;
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (d.name.startsWith(".")) continue;
    const p = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) listFiles(dir, p, out);
    else if (d.isFile()) out.push(p);
  }
  return out;
}
