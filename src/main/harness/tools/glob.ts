// Glob, the file-finder tool: walk a directory (skipping vendor and build
// folders) and match relative paths against a glob pattern.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolvePath } from "./paths";
import { intAny, strAny, ToolError, type NativeTool } from "./types";

/** Folders a search never descends into: they are large and never the target. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist-electron", "out", ".next", "dist", "build", "coverage", ".turbo", ".cache", "target", ".venv", "venv", "__pycache__"]);

/** At most this many matches are listed; the rest collapse to a hint. */
const MAX_MATCHES = 100;
/** A script (code mode) gets every match up to this many, as data; past it the call fails instead of cutting silently. */
export const SCRIPT_MAX_MATCHES = 5000;
/** Directory listings in flight at once during a walk. */
const MAX_OPEN_DIRS = 8;

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
    "Find files by glob pattern. Matches the pattern against paths relative to the search directory: \"*.ts\" is top-level only while \"**/*.ts\" descends into subdirectories, and \"{a,b}\" lists alternatives. Skips common vendor and build folders (node_modules, .git, dist, build, out, target, .next and the like). Returns the newest matches first, one path per line. Use it to discover files before reading them.",
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
    const dir = resolvePath(ctx.cwd, strAny(args, ["path", "dir", "directory"]) ?? ".");
    const limit = intAny(args, ["limit"]);
    const re = globToRegExp(pattern);
    const matches: { rel: string; mtimeMs: number }[] = [];
    for await (const file of walkFiles(dir.abs, ctx.signal)) {
      if (re.test(file.rel)) matches.push({ rel: file.rel, mtimeMs: 0 });
    }
    // mtimes fill in concurrently, newest first; a file that raced away sorts oldest.
    await Promise.all(
      matches.map(async (m) => {
        try {
          m.mtimeMs = (await stat(join(dir.abs, m.rel))).mtimeMs;
        } catch {
          // keep the oldest possible time
        }
      }),
    );
    const display = { summary: pattern };
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (ctx.script) {
      if (limit === undefined && matches.length > SCRIPT_MAX_MATCHES) throw new ToolError(`More than ${SCRIPT_MAX_MATCHES} files match ${pattern}; narrow the pattern or the path, or set a limit.`);
      const paths = matches.slice(0, limit ?? SCRIPT_MAX_MATCHES).map((m) => m.rel);
      return { text: paths.join("\n"), data: paths, display };
    }
    if (matches.length === 0) return { text: `No files match ${pattern}`, display };
    const cap = limit !== undefined ? Math.max(1, limit) : MAX_MATCHES;
    let text = matches.slice(0, cap).map((m) => m.rel).join("\n");
    if (matches.length > cap) text += `\n[${matches.length - cap} more; narrow the pattern]`;
    return { text, display };
  },
};
