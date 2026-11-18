// Where installed Creator apps live and how a frame's key maps back to a folder. Global apps sit in CubiQ's own
// data folder; project apps in the project's `.cubiq/apps`. Nothing is ever read from or written to another agent's
// config. app.json is re-read only when its mtime changes.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppInfo } from "../../shared/types";
import { APP_MANIFEST, type AppManifest, parseAppManifest } from "./manifest";
import { appUrl } from "./serve";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export type AppKey = { scope: "global"; name: string } | { scope: "project"; projectId: string; name: string };

export function encodeAppKey(k: AppKey): string {
  return k.scope === "global" ? `g~${k.name}` : `p~${k.projectId}~${k.name}`;
}

export function decodeAppKey(key: string): AppKey | null {
  const parts = key.split("~");
  if (parts[0] === "g" && parts.length === 2 && NAME_RE.test(parts[1]!)) return { scope: "global", name: parts[1]! };
  if (parts[0] === "p" && parts.length === 3 && PROJECT_ID_RE.test(parts[1]!) && NAME_RE.test(parts[2]!)) return { scope: "project", projectId: parts[1]!, name: parts[2]! };
  return null;
}

export interface AppRegistryDeps {
  /** `<userData>/apps`. */
  globalDir: string;
  /** A real project's folder (not the Chats root), or null. */
  projectPath(projectId: string): string | null;
}

export const projectAppsDir = (projectPath: string): string => join(projectPath, ".cubiq", "apps");

export class AppRegistry {
  private cache = new Map<string, { mtime: number; manifest: AppManifest | null; error: string | null }>();

  constructor(private deps: AppRegistryDeps) {}

  dirOf(k: AppKey): string | null {
    if (k.scope === "global") return join(this.deps.globalDir, k.name);
    const p = this.deps.projectPath(k.projectId);
    return p ? join(projectAppsDir(p), k.name) : null;
  }

  /** The folder a frame key serves, only for an app whose app.json is valid. */
  root(key: string): string | null {
    const k = decodeAppKey(key);
    const dir = k ? this.dirOf(k) : null;
    return dir && this.read(dir).manifest ? dir : null;
  }

  manifest(key: string): AppManifest | null {
    const k = decodeAppKey(key);
    const dir = k ? this.dirOf(k) : null;
    return dir ? this.read(dir).manifest : null;
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
        const k = make(name);
        const dir = join(base, name);
        const { manifest, error } = this.read(dir);
        out.push({
          key: encodeAppKey(k),
          name,
          scope: k.scope,
          ...(k.scope === "project" ? { projectId: k.projectId } : {}),
          title: manifest?.title ?? name,
          description: manifest?.description ?? "",
          ...(manifest?.icon ? { icon: manifest.icon } : {}),
          grants: manifest?.grants ?? [],
          path: dir,
          url: appUrl(encodeAppKey(k), manifest?.entry ?? "index.html"),
          ...(error ? { error } : {}),
        });
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

  private read(dir: string): { manifest: AppManifest | null; error: string | null } {
    const file = join(dir, APP_MANIFEST);
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      this.cache.delete(dir);
      return { manifest: null, error: existsSync(dir) ? "app.json is missing." : "The app folder is gone." };
    }
    const hit = this.cache.get(dir);
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
    this.cache.set(dir, entry);
    return entry;
  }
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
