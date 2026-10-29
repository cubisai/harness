import { cpSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Chromium's per-profile caches and lock files. They are regenerated on first
 * run and a copied lock can wedge the new profile, so a migration carries the
 * user's own files (database, settings, skills, agents) and leaves these behind.
 */
const SKIP_TOP_LEVEL = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "Crashpad",
  "DevToolsActivePort",
]);

export interface MigrateLegacyDataOptions {
  /** The parent of the legacy and current data folders (Electron's appData path). */
  appData: string;
  /** The current data folder (Electron's userData path). */
  target: string;
  /** Old product names to look under, in order of preference. */
  legacyNames: string[];
}

/**
 * One-shot adoption of a pre-rename data folder. Runs before anything reads
 * userData: if the target has no database yet, the first legacy folder that
 * does is copied into it in full (minus Chromium's caches and locks). The
 * legacy folder is never modified or deleted, so a downgrade still works.
 * Returns the legacy folder it copied from, or null when there was nothing to do.
 */
export function migrateLegacyData(opts: MigrateLegacyDataOptions): string | null {
  const { appData, target, legacyNames } = opts;
  if (existsSync(join(target, "unskilled.db"))) return null;
  for (const name of legacyNames) {
    const legacy = join(appData, name);
    if (!existsSync(join(legacy, "unskilled.db"))) continue;
    cpSync(legacy, target, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (src) => {
        // The caches sit at the folder's root; a nested folder of the same name is the user's.
        if (dirname(src) !== legacy) return true;
        const entry = basename(src);
        return !SKIP_TOP_LEVEL.has(entry) && !entry.startsWith("Singleton");
      },
    });
    return legacy;
  }
  return null;
}
