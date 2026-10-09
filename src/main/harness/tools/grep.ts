// Grep, the content-search tool: ripgrep when it is installed, an in-process
// fallback otherwise, over the same skip rules the file walker uses.

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { onPath } from "../../agents/registry";
import { bound } from "./bound";
import { globToRegExp, walkFiles } from "./glob";
import { resolvePath, type ResolvedPath } from "./paths";
import { bool, str, ToolError, type NativeTool, type ToolContext } from "./types";

type OutputMode = "files_with_matches" | "content" | "count";

const MODES: OutputMode[] = ["files_with_matches", "content", "count"];
/** Ceilings for the fallback, mirroring ripgrep's own taming of huge output. */
const MAX_FILES = 200;
const MAX_CONTENT_LINES = 250;
const MAX_LINE_CHARS = 300;
const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_SNIFF = 8 * 1024;

interface SearchOptions {
  target: ResolvedPath;
  glob?: string;
  ignoreCase: boolean;
  mode: OutputMode;
}

/** A path shown relative to `cwd` with "/" separators. */
function relToCwd(cwd: string, p: string): string {
  const rel = relative(cwd, resolve(cwd, p));
  return (rel === "" ? "." : rel).split(sep).join("/");
}

/** A file filter: a glob with "/" matches the relative path, without it the basename. */
function passesGlob(glob: string, rel: string): boolean {
  if (glob.includes("/")) return globToRegExp(glob).test(rel);
  return globToRegExp(glob).test(rel.slice(rel.lastIndexOf("/") + 1));
}

/** Run ripgrep and collect its output; resolves (never rejects) so the caller reads the exit code. */
function spawnRg(args: string[], cwd: string, signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn("rg", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const kill = () => child.kill();
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });
    child.on("error", (err) => {
      signal.removeEventListener("abort", kill);
      done({ code: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      done({ code, stdout, stderr });
    });
  });
}

/** Shape ripgrep's stdout into the mode's output lines (paths relative to cwd). */
async function runRipgrep(pattern: string, opts: SearchOptions, ctx: ToolContext): Promise<{ text: string; display: { summary: string } }> {
  const args = ["--no-heading", "--line-number", "--color", "never"];
  if (opts.ignoreCase) args.push("-i");
  if (opts.glob) args.push("--glob", opts.glob);
  if (opts.mode === "files_with_matches") args.push("-l");
  else if (opts.mode === "count") args.push("-c");
  args.push("--regexp", pattern, opts.target.abs);

  const display = { summary: pattern };
  const { code, stdout, stderr } = await spawnRg(args, ctx.cwd, ctx.signal);
  if (code === 1) return { text: `No matches for ${pattern}`, display };
  if (code !== 0) throw new ToolError(stderr.trim() || `ripgrep exited with code ${code ?? "null"}.`);

  const lines = stdout.split(/\r?\n/).filter((line) => line !== "");
  if (opts.mode === "files_with_matches") {
    const hits = lines.map((line) => {
      const rel = relToCwd(ctx.cwd, line);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(resolve(ctx.cwd, rel)).mtimeMs;
      } catch {
        // raced away: keep the oldest possible time
      }
      return { rel, mtimeMs };
    });
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return finish(hits.slice(0, MAX_FILES).map((h) => h.rel), pattern, display, ctx);
  }
  if (opts.mode === "count") {
    const out = lines.map((line) => {
      const i = line.lastIndexOf(":");
      return i < 0 ? line : `${relToCwd(ctx.cwd, line.slice(0, i))}:${line.slice(i + 1)}`;
    });
    return finish(out, pattern, display, ctx);
  }
  const out = lines.slice(0, MAX_CONTENT_LINES).map((line) => {
    const m = /^(.*?):(\d+):(.*)$/.exec(line);
    return m ? `${relToCwd(ctx.cwd, m[1]!)}:${m[2]}:${m[3]!.slice(0, MAX_LINE_CHARS)}` : line;
  });
  return finish(out, pattern, display, ctx);
}

/** Join output lines, bound them, or report that nothing matched. */
function finish(lines: string[], pattern: string, display: { summary: string }, ctx: ToolContext): { text: string; display: { summary: string } } {
  return lines.length ? { text: bound(lines.join("\n"), ctx), display } : { text: `No matches for ${pattern}`, display };
}

/** Read each candidate file and test the regex per line; skip big and binary files. */
function scanFiles(
  pattern: string,
  re: RegExp,
  files: { abs: string; rel: string }[],
  mode: OutputMode,
  ctx: ToolContext,
): { text: string; display: { summary: string } } {
  const display = { summary: pattern };
  const fileHits: { rel: string; mtimeMs: number }[] = [];
  const countLines: string[] = [];
  const contentLines: string[] = [];
  for (const file of files) {
    if (ctx.signal.aborted) break;
    let st;
    try {
      st = statSync(file.abs);
    } catch {
      continue;
    }
    if (st.size > MAX_FILE_BYTES) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(file.abs);
    } catch {
      continue;
    }
    if (buf.subarray(0, BINARY_SNIFF).indexOf(0) !== -1) continue; // binary
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (mode === "files_with_matches") {
      if (lines.some((line) => re.test(line))) fileHits.push({ rel: file.rel, mtimeMs: st.mtimeMs });
    } else if (mode === "count") {
      const count = lines.reduce((n, line) => (re.test(line) ? n + 1 : n), 0);
      if (count > 0) countLines.push(`${file.rel}:${count}`);
    } else {
      for (let i = 0; i < lines.length && contentLines.length < MAX_CONTENT_LINES; i++) {
        const line = lines[i]!;
        if (re.test(line)) contentLines.push(`${file.rel}:${i + 1}:${line.slice(0, MAX_LINE_CHARS)}`);
      }
    }
  }
  if (mode === "files_with_matches") {
    fileHits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return finish(fileHits.slice(0, MAX_FILES).map((h) => h.rel), pattern, display, ctx);
  }
  return finish(mode === "count" ? countLines : contentLines, pattern, display, ctx);
}

/** Search file contents by regular expression. */
export const grepTool: NativeTool = {
  name: "grep",
  displayName: "Grep",
  description:
    "Search file contents for a regular expression. By default it returns the paths of files with at least one match; output_mode \"content\" returns matching lines as path:line:text and \"count\" returns path:count per file. Set ignore_case for a case-insensitive search, and glob to restrict which files are searched (for example \"*.ts\"). Skips vendor and build folders, files over 1 MB, and binary files. Use it to find where something is defined or referenced.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "File or directory to search (default: the working directory)." },
      glob: { type: "string", description: "Only search files whose name or relative path matches this glob, e.g. \"*.tsx\"." },
      ignore_case: { type: "boolean", description: "Case-insensitive match." },
      output_mode: {
        type: "string",
        enum: ["files_with_matches", "content", "count"],
        description: "files_with_matches (default), content, or count.",
      },
    },
    required: ["pattern"],
  },
  access: "read",
  summarize(args) {
    return str(args, "pattern", true);
  },
  async run(args, ctx) {
    const pattern = str(args, "pattern", true);
    const ignoreCase = bool(args, "ignore_case");
    const glob = str(args, "glob");
    const modeArg = str(args, "output_mode") ?? "files_with_matches";
    if (!MODES.includes(modeArg as OutputMode)) {
      throw new ToolError(`Unknown output_mode "${modeArg}"; use files_with_matches, content, or count.`);
    }
    const mode = modeArg as OutputMode;
    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (e) {
      throw new ToolError(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }
    const target = resolvePath(ctx.cwd, str(args, "path") ?? ".");

    if (onPath("rg", ctx.env ?? process.env)) return runRipgrep(pattern, { target, glob, ignoreCase, mode }, ctx);

    // Fallback: gather the candidate files (skipping glob filters), then scan.
    let isFile = false;
    try {
      isFile = statSync(target.abs).isFile();
    } catch {
      // gone or unreadable: no candidates
    }
    const files: { abs: string; rel: string }[] = [];
    if (isFile) {
      const rel = relToCwd(ctx.cwd, target.abs);
      if (!glob || passesGlob(glob, rel)) files.push({ abs: target.abs, rel });
    } else {
      for await (const file of walkFiles(target.abs, ctx.signal)) {
        const rel = relToCwd(ctx.cwd, file.abs);
        if (glob && !passesGlob(glob, rel)) continue;
        files.push({ abs: file.abs, rel });
      }
    }
    return scanFiles(pattern, re, files, mode, ctx);
  },
};
