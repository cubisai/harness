// Glob, the file-finder tool: walk a directory (skipping vendor and build
// folders) and match relative paths against a glob pattern.

import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolvePath, scopedReadPath } from "./paths";
import { intAny, strAny, ToolError, type NativeTool } from "./types";

/** Folders a search never descends into: they are large and never the target. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist-electron", "out", ".next", "dist", "build", "coverage", ".turbo", ".cache", "target", ".venv", "venv", "__pycache__"]);

/** At most this many matches are listed; the rest collapse to a hint. */
const MAX_MATCHES = 100;
/** A script (code mode) gets every match up to this many, as data; past it the call fails instead of cutting silently. */
export const SCRIPT_MAX_MATCHES = 5000;
/** Directory listings in flight at once during a walk. */
const MAX_OPEN_DIRS = 8;
/** Stats in flight at once while sorting matches by mtime. */
const STAT_CONCURRENCY = 64;

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

const GLOB_CHARS = /[*?{]/;

/**
 * A pattern that can't match a path relative to the search folder (absolute,
 * like "/repo/src/*.ts" or "C:\\repo\\*.ts", or climbing out with "../"):
 * its literal leading folders become the folder to search and the rest stays
 * the glob. Undefined for an ordinary relative pattern.
 */
export function splitPattern(pattern: string): { dir: string; glob: string } | undefined {
  const winDrive = /^[A-Za-z]:[\\/]/.test(pattern);
  if (!isAbsolute(pattern) && !winDrive && !/^\.\.(?:[\\/]|$)/.test(pattern)) return undefined;
  // On Windows (or a drive path) backslashes are separators; elsewhere a glob has no escapes, so "/" is the only one.
  const norm = winDrive || process.platform === "win32" ? pattern.replace(/\\/g, "/") : pattern;
  const parts = norm.split("/");
  let cut = parts.findIndex((seg) => GLOB_CHARS.test(seg));
  // All literal: a file path, so search its folder for its name.
  if (cut === -1) cut = parts.length - 1;
  const dir = parts.slice(0, cut).join("/") || (norm.startsWith("/") ? "/" : ".");
  return { dir: winDrive && cut === 1 ? `${dir}/` : dir, glob: parts.slice(cut).join("/") };
}

/**
 * Every file under `root` (recursive, "/" separators in `rel`), skipping the
 * vendor/build folders and never following symlinked directories; stops when
 * `signal` aborts. Sibling directories list concurrently.
 */
export async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<{ abs: string; rel: string }> {
  const pendingDirs: string[] = [""];
  const inFlight = new Set<Promise<void>>();
  const queue: { abs: string; rel: string }[] = [];
  const pump = (): void => {
    while (pendingDirs.length > 0 && inFlight.size < MAX_OPEN_DIRS) {
      const rel = pendingDirs.shift()!;
      const listing = readdir(join(root, rel), { withFileTypes: true }).then(
        (entries) => {
          inFlight.delete(listing);
          for (const entry of entries) {
            const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              if (!SKIP_DIRS.has(entry.name)) pendingDirs.push(entryRel);
            } else if (entry.isFile()) {
              queue.push({ abs: join(root, entryRel), rel: entryRel });
            }
            // A symlink is neither isFile() nor isDirectory(): it is skipped, so
            // symlinked directories are never followed.
          }
        },
        () => {
          // Unreadable or vanished: skip rather than fail the whole search.
          inFlight.delete(listing);
        },
      );
      inFlight.add(listing);
    }
  };
  for (;;) {
    if (signal?.aborted) return;
    // Newly listed subdirectories join the walk here; a round can end with
    // everything in flight done but pendingDirs non-empty.
    pump();
    const next = queue.shift();
    if (next) {
      yield next;
      continue;
    }
    if (inFlight.size === 0) return;
    await Promise.race(inFlight);
  }
}

/** Search files by glob pattern, newest first. */
export const globTool: NativeTool = {
  name: "glob",
  displayName: "Glob",
  description:
    "Find files by glob pattern. Matches the pattern against paths relative to the search directory: \"*.ts\" is top-level only while \"**/*.ts\" descends into subdirectories, and \"{a,b}\" lists alternatives; an absolute pattern searches from its own folder. Skips common vendor and build folders (node_modules, .git, dist, build, out, target, .next and the like). Returns the newest matches first, one path per line, each one you can pass to read as is. Use it to discover files before reading them.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. \"**/*.ts\"" },
      path: { type: "string", description: "Directory to search (default: the working directory)." },
      limit: { type: "integer", description: "Cap the matches returned (default: all, up to the usual cap)." },
    },
    required: ["pattern"],
  },
  access: "read",
  returns: "string[]",
  summarize(args) {
    return strAny(args, ["pattern", "glob"], true);
  },
  async run(args, ctx) {
    const pattern = strAny(args, ["pattern", "glob"], true);
    const split = splitPattern(pattern);
    const base = resolvePath(ctx.cwd, strAny(args, ["path", "dir", "directory"]) ?? ".");
    const dir = scopedReadPath(ctx, split ? resolvePath(base.abs, split.dir) : base);
    const limit = intAny(args, ["limit"]);
    const re = globToRegExp(split ? split.glob : pattern);
    // Paths come back the way read resolves them: relative to the thread's folder, or absolute outside it.
    const atCwd = dir.abs === resolvePath(ctx.cwd, ".").abs;
    const shown = (rel: string): string => (atCwd ? rel : resolvePath(ctx.cwd, join(dir.abs, rel)).shown);
    const matches: { rel: string; mtimeMs: number }[] = [];
    // A script without a limit gets an error past the cap anyway: stop walking there, before any stat.
    const refuseAt = ctx.script && limit === undefined ? SCRIPT_MAX_MATCHES : Infinity;
    for await (const file of walkFiles(dir.abs, ctx.signal)) {
      if (!re.test(file.rel)) continue;
      matches.push({ rel: file.rel, mtimeMs: 0 });
      if (matches.length > refuseAt) throw new ToolError(`More than ${SCRIPT_MAX_MATCHES} files match ${pattern}; narrow the pattern or the path, or set a limit.`);
    }
    // mtimes fill in a few at a time, newest first; a file that raced away sorts oldest.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < matches.length) {
        const m = matches[next++]!;
        try {
          m.mtimeMs = (await stat(join(dir.abs, m.rel))).mtimeMs;
        } catch {
          // keep the oldest possible time
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, matches.length) }, worker));
    const display = { summary: pattern };
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (ctx.script) {
      const paths = matches.slice(0, limit ?? SCRIPT_MAX_MATCHES).map((m) => shown(m.rel));
      return { text: paths.join("\n"), data: paths, display };
    }
    if (matches.length === 0) return { text: `No files match ${pattern}`, display };
    const cap = limit !== undefined ? Math.max(1, limit) : MAX_MATCHES;
    let text = matches.slice(0, cap).map((m) => shown(m.rel)).join("\n");
    if (matches.length > cap) text += `\n[${matches.length - cap} more; narrow the pattern]`;
    return { text, display };
  },
};
