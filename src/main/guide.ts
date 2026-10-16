import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The project's guide: `.cubiq/CUBIQ.md`, or the older `.agents/HARNESS.md`
 * when there's no CUBIQ.md. Never both, so nothing is sent twice.
 */
export function projectGuidePath(cwd: string): string {
  const own = join(cwd, ".cubiq", "CUBIQ.md");
  const legacy = join(cwd, ".agents", "HARNESS.md");
  return !existsSync(own) && existsSync(legacy) ? legacy : own;
}

/**
 * The user's own guide in the app data folder, `CUBIQ.md`. A `HARNESS.md` from
 * before the rename is moved over once; best effort, a failed move reads nothing.
 */
export function userGuidePath(dataDir: string): string {
  const own = join(dataDir, "CUBIQ.md");
  const legacy = join(dataDir, "HARNESS.md");
  if (!existsSync(own) && existsSync(legacy)) {
    try {
      renameSync(legacy, own);
    } catch {
      // Left where it was; the user can move it.
    }
  }
  return own;
}

/**
 * What a design thread's agent is told when the bundled Design mode guide
 * (`DESIGN-MODE.md`) is missing: where to build, and that the canvas has no
 * network. Stable per thread, so the prompt cache holds.
 */
export function designNote(dir: string): string {
  return [
    "# Design thread",
    `This thread is a design. Build it as one self-contained web page at \`${dir}/index.html\` (relative to the working folder); put any extra CSS, JS, images or fonts beside it in \`${dir}/\` and link them with relative paths.`,
    "The page shows live in CubiQ's canvas, which reloads as you write and has no network: no CDN scripts, web fonts, remote images or fetch calls. Inline scripts and styles work.",
  ].join("\n\n");
}

/**
 * The inline UI block catalog (renderer: src/renderer/src/genui), sent only when
 * Settings › Interactive answers is on. Teaches only the shorter line form; a
 * JSON body still renders. Kept to one line: it rides in every session's stable
 * prefix.
 */
export const UI_BLOCKS_NOTE =
  "- **UI blocks** (only when clearer than prose; max 2 per reply): a ```ui:<name> fence, one item per line, `|` between fields, optional `# Title` line. `checklist`: `[x] text`; `compare`: header row, then rows, `*` before the best row; `timeline`: `time | title | detail`; `chart`: `label | number`, optional `unit: $`; `calculator`: `id | label | value | unit` lines, then `= formula`.";

/**
 * The harness guide agents receive as instructions: the app's bundled copy,
 * then the user's own, then the project's; a design thread's ends with Design
 * mode's guide (`designMode`) for its folder. Each file is read once and cached by
 * its mtime, so repeated calls return the same text and the prompt cache isn't
 * broken by a re-read (which also means a guide edited mid-session is only
 * picked up on the next mtime change, not mid-turn).
 */
export function createGuide(opts: { bundled: string; global: string; designMode?: string; uiBlocks?: () => boolean }): {
  forCwd(cwd: string, design?: string): string;
  partsForCwd(cwd: string): { source: "bundled" | "user" | "project"; path: string; text: string }[];
} {
  const cache = new Map<string, { mtimeMs: number; text: string }>();

  /** A file's trimmed text, cached by mtime, or "" when it's missing or unreadable. */
  const read = (path: string): string => {
    try {
      const { mtimeMs } = statSync(path);
      const hit = cache.get(path);
      if (hit && hit.mtimeMs === mtimeMs) return hit.text;
      // LF only: a CRLF checkout (git autocrlf on Windows) would otherwise inflate the prompt and its estimate.
      const text = readFileSync(path, "utf8").replace(/\r\n?/g, "\n").trim();
      cache.set(path, { mtimeMs, text });
      return text;
    } catch {
      return "";
    }
  };

  /** The three guide files as parts, in the order agents receive them, omitting empty ones. */
  const partsForCwd = (cwd: string): { source: "bundled" | "user" | "project"; path: string; text: string }[] => {
    const sources: { source: "bundled" | "user" | "project"; path: string }[] = [
      { source: "bundled", path: opts.bundled },
      { source: "user", path: opts.global },
      { source: "project", path: projectGuidePath(cwd) },
    ];
    const parts = sources.map((s) => ({ ...s, text: read(s.path) })).filter((p) => p.text.length > 0);
    // The opt-in UI block catalog follows the app's own guide.
    if (!opts.uiBlocks?.()) return parts;
    const at = parts.filter((p) => p.source === "bundled").length;
    return [...parts.slice(0, at), { source: "bundled" as const, path: "ui-blocks", text: UI_BLOCKS_NOTE }, ...parts.slice(at)];
  };

  /** Design mode's guide with the thread's folder filled in; the short note when the file is missing. */
  const designGuide = (dir: string): string => {
    const text = opts.designMode ? read(opts.designMode) : "";
    return text ? text.replaceAll("{dir}", dir) : designNote(dir);
  };

  return {
    forCwd(cwd: string, design?: string): string {
      return [...partsForCwd(cwd).map((p) => p.text), ...(design ? [designGuide(design)] : [])].join("\n\n");
    },
    partsForCwd,
  };
}
