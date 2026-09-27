import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The harness guide agents receive as instructions: the app's bundled copy,
 * then the user's own, then the project's. Each file is read once and cached by
 * its mtime, so repeated calls return the same text and the prompt cache isn't
 * broken by a re-read (which also means a guide edited mid-session is only
 * picked up on the next mtime change, not mid-turn).
 */
export function createGuide(opts: { bundled: string; global: string }): { forCwd(cwd: string): string } {
  const cache = new Map<string, { mtimeMs: number; text: string }>();

  /** A file's trimmed text, cached by mtime, or "" when it's missing or unreadable. */
  const read = (path: string): string => {
    try {
      const { mtimeMs } = statSync(path);
      const hit = cache.get(path);
      if (hit && hit.mtimeMs === mtimeMs) return hit.text;
      const text = readFileSync(path, "utf8").trim();
      cache.set(path, { mtimeMs, text });
      return text;
    } catch {
      return "";
    }
  };

  return {
    forCwd(cwd: string): string {
      return [read(opts.bundled), read(opts.global), read(join(cwd, ".agents", "HARNESS.md"))]
        .filter((text) => text.length > 0)
        .join("\n\n");
    },
  };
}
