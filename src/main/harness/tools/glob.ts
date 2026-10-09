// Glob, the file-finder tool: walk a directory (skipping vendor and build
// folders) and match relative paths against a glob pattern.

import { statSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolvePath } from "./paths";
import { str, type NativeTool } from "./types";

/** Folders a search never descends into: they are large and never the target. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist-electron", "out", ".next"]);

/** At most this many matches are listed; the rest collapse to a hint. */
const MAX_MATCHES = 100;

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A glob's regex source (no anchors): "**", "*", "?", and "{a,b}" alternation. */
function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*"; // zero or more directories
          i += 2;
        } else {
          out += ".*"; // anything
          i += 1;
        }
      } else {
        out += "[^/]*"; // any chars except "/"
      }
    } else if (ch === "?") {
      out += "[^/]"; // one char except "/"
    } else if (ch === "{") {
      const close = glob.indexOf("}", i + 1);
      if (close === -1) {
        out += "\\{";
      } else {
        const alts = glob.slice(i + 1, close).split(",").map(globSource);
        out += `(?:${alts.join("|")})`;
        i = close;
      }
    } else {
      out += escapeRegExp(ch);
    }
  }
  return out;
}

/** Convert a glob into an anchored regex over forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob)}$`);
}

/**
 * Every file under `root` (recursive, "/" separators in `rel`), skipping the
 * vendor/build folders and never following symlinked directories; stops when
 * `signal` aborts.
 */
export async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<{ abs: string; rel: string }> {
  yield* walk(root, "");
  async function* walk(dir: string, prefix: string): AsyncGenerator<{ abs: string; rel: string }> {
    if (signal?.aborted) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or vanished: skip rather than fail the whole search
    }
    for (const entry of entries) {
      if (signal?.aborted) return;
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        yield* walk(abs, rel);
      } else if (entry.isFile()) {
        yield { abs, rel };
      }
      // A symlink is neither isFile() nor isDirectory(): it is skipped, so
      // symlinked directories are never followed.
    }
  }
}

/** Search files by glob pattern, newest first. */
export const globTool: NativeTool = {
  name: "glob",
  displayName: "Glob",
  description:
    "Find files by glob pattern. Matches the pattern against paths relative to the search directory: \"*.ts\" is top-level only while \"**/*.ts\" descends into subdirectories, and \"{a,b}\" lists alternatives. Skips common vendor and build folders (node_modules, .git, dist-electron, out, .next). Returns the newest matches first, one path per line. Use it to discover files before reading them.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. \"**/*.ts\"" },
      path: { type: "string", description: "Directory to search (default: the working directory)." },
    },
    required: ["pattern"],
  },
  access: "read",
  summarize(args) {
    return str(args, "pattern", true);
  },
  async run(args, ctx) {
    const pattern = str(args, "pattern", true);
    const dir = resolvePath(ctx.cwd, str(args, "path") ?? ".");
    const re = globToRegExp(pattern);
    const matches: { rel: string; mtimeMs: number }[] = [];
    for await (const file of walkFiles(dir.abs, ctx.signal)) {
      if (!re.test(file.rel)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(file.abs).mtimeMs;
      } catch {
        // raced away: keep it with the oldest possible time
      }
      matches.push({ rel: file.rel, mtimeMs });
    }
    const display = { summary: pattern };
    if (matches.length === 0) return { text: `No files match ${pattern}`, display };
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let text = matches.slice(0, MAX_MATCHES).map((m) => m.rel).join("\n");
    if (matches.length > MAX_MATCHES) text += `\n[${matches.length - MAX_MATCHES} more; narrow the pattern]`;
    return { text, display };
  },
};
