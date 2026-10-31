// Grep, the content-search tool: ripgrep when it is installed, an in-process
// fallback otherwise, over the same skip rules the file walker uses.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { onPath } from "../../agents/registry";
import { bound } from "./bound";
import { globToRegExp, walkFiles } from "./glob";
import { resolvePath, type ResolvedPath } from "./paths";
import { boolAny, intAny, strAny, ToolError, type NativeTool, type ToolContext } from "./types";

type OutputMode = "files_with_matches" | "content" | "count";

const MODES: OutputMode[] = ["files_with_matches", "content", "count"];
/** Spellings models use for the modes. */
const MODE_ALIASES: Record<string, OutputMode> = { files: "files_with_matches", lines: "content", counts: "count" };
/** Ceilings for the fallback, mirroring ripgrep's own taming of huge output. */
const MAX_FILES = 200;
const MAX_CONTENT_LINES = 250;
const MAX_LINE_CHARS = 300;
/** A script's content lines may be much longer (minified files, long rows). */
const SCRIPT_MAX_LINE_CHARS = 4000;
/** A script (code mode) gets up to this many files or lines as data; past it the call fails instead of cutting silently. */
export const SCRIPT_MAX_RESULTS = 5000;

/** The result caps for a call: an explicit limit wins, else the model's caps or the larger script ones. */
const capsOf = (ctx: ToolContext, limit: number | undefined): { files: number; lines: number } =>
  limit !== undefined ? { files: limit, lines: limit } : ctx.script ? { files: SCRIPT_MAX_RESULTS, lines: SCRIPT_MAX_RESULTS } : { files: MAX_FILES, lines: MAX_CONTENT_LINES };
const lineCapOf = (ctx: ToolContext): number => (ctx.script ? SCRIPT_MAX_LINE_CHARS : MAX_LINE_CHARS);
const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_SNIFF = 8 * 1024;
const MAX_CONTEXT = 20;

interface SearchOptions {
  target: ResolvedPath;
  glob?: string;
  ignoreCase: boolean;
  mode: OutputMode;
  /** Context lines around each content match (0 = none). */
  context: number;
  caps: { files: number; lines: number };
}

interface ContentRow {
  path: string;
  line: number;
  text: string;
  /** "line:text" rows around the match, only when context was asked for. */
  before?: string[];
  after?: string[];
}

type GrepData = string[] | Record<string, number> | ContentRow[];

/** Resolved ripgrep command per PATH (null = none). Electron's default PATH misses the usual brew locations, so those are checked too when no custom env overrides PATH. */
const rgCache = new Map<string, string | null>();
function rgPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, allowSystemPaths: boolean): string | null {
  const key = `${platform} ${allowSystemPaths ? "sys" : "env"} ${env.PATH ?? env.Path ?? ""}`;
  const cached = rgCache.get(key);
  if (cached !== undefined) return cached;
  let found: string | null = onPath("rg", env, platform) ? "rg" : null;
  if (!found && allowSystemPaths && platform !== "win32") {
    for (const candidate of ["/opt/homebrew/bin/rg", "/usr/local/bin/rg"]) {
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  }
  rgCache.set(key, found);
  return found;
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
function spawnRg(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
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

/** Content rows as text lines: matches as path:line:text, context rows (rg style) as path-line-text. */
function rowsToLines(rows: ContentRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const b of row.before ?? []) out.push(`${row.path}-${b}`);
    out.push(`${row.path}:${row.line}:${row.text}`);
    for (const a of row.after ?? []) out.push(`${row.path}-${a}`);
  }
  return out;
}

/** path:count lines as a path → count object. */
function countsData(lines: string[]): Record<string, number> {
  return Object.fromEntries(
    lines.map((line) => {
      const i = line.lastIndexOf(":");
      return [line.slice(0, i), Number(line.slice(i + 1))];
    }),
  );
}

/** Shape ripgrep's stdout into the mode's output (paths relative to cwd), capped; total is the pre-cap count. */
async function runRipgrep(command: string, pattern: string, opts: SearchOptions, ctx: ToolContext): Promise<{ lines: string[]; data: GrepData; total: number }> {
  const args = ["--no-heading", "--line-number", "--color", "never"];
  if (opts.ignoreCase) args.push("-i");
  if (opts.glob) args.push("--glob", opts.glob);
  if (opts.mode === "files_with_matches") args.push("-l");
  else if (opts.mode === "count") args.push("-c");
  else if (opts.context > 0) args.push("-C", String(opts.context));
  args.push("--regexp", pattern, opts.target.abs);

  const { code, stdout, stderr } = await spawnRg(command, args, ctx.cwd, ctx.signal);
  if (code === 1) return { lines: [], data: opts.mode === "count" ? {} : [], total: 0 };
  if (code !== 0) throw new ToolError(stderr.trim() || `ripgrep exited with code ${code ?? "null"}.`);

  const cap = lineCapOf(ctx);
  const lines = stdout.split(/\r?\n/).filter((line) => line !== "");
  if (opts.mode === "files_with_matches") {
    const hits = lines.map((line) => ({ rel: relToCwd(ctx.cwd, line), mtimeMs: 0 }));
    await Promise.all(
      hits.map(async (h) => {
        try {
          h.mtimeMs = (await stat(resolve(ctx.cwd, h.rel))).mtimeMs;
        } catch {
          // raced away: keep the oldest possible time
        }
      }),
    );
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const kept = hits.slice(0, opts.caps.files).map((h) => h.rel);
    return { lines: kept, data: kept, total: hits.length };
  }
  if (opts.mode === "count") {
    const out = lines.map((line) => {
      const i = line.lastIndexOf(":");
      return i < 0 ? line : `${relToCwd(ctx.cwd, line.slice(0, i))}:${line.slice(i + 1)}`;
    });
    return { lines: out, data: countsData(out), total: out.length };
  }
  const rows = parseContentLines(lines, opts.context, cap, ctx);
  const kept = rows.slice(0, opts.caps.lines);
  return { lines: rowsToLines(kept), data: kept, total: rows.length };
}

/** Parse rg's content output (with -C context rows when asked) into rows; context between matches attaches to the previous row's after. */
function parseContentLines(lines: string[], context: number, cap: number, ctx: ToolContext): ContentRow[] {
  const rows: ContentRow[] = [];
  let pending: string[] = [];
  let last: ContentRow | null = null;
  for (const line of lines) {
    if (line === "--") {
      pending = [];
      last = null;
      continue;
    }
    const m = /^(.*?):(\d+):(.*)$/.exec(line);
    if (m) {
      const row: ContentRow = { path: relToCwd(ctx.cwd, m[1]!), line: Number(m[2]), text: m[3]!.slice(0, cap) };
      if (pending.length) row.before = pending;
      pending = [];
      rows.push(row);
      last = row;
      continue;
    }
    if (context > 0) {
      const c = /^(.*?)-(\d+)-(.*)$/.exec(line);
      if (c) {
        const entry = `${c[2]}:${c[3]!.slice(0, cap)}`;
        if (last) (last.after ??= []).push(entry);
        else pending.push(entry);
      }
    }
  }
  return rows;
}

/** Join output, bound it, or report that nothing matched; a script gets the results as data instead. */
function finish(r: { lines: string[]; data: GrepData; total: number }, pattern: string, ctx: ToolContext, limit: number | undefined): { text: string; display: { summary: string }; data?: GrepData } {
  const display = { summary: pattern };
  if (ctx.script) {
    if (limit === undefined && r.total > SCRIPT_MAX_RESULTS) {
      throw new ToolError(`More than ${SCRIPT_MAX_RESULTS} results for ${pattern}; narrow the pattern, path or glob, set a limit, or use output_mode "files_with_matches" or "count".`);
    }
    return { text: r.lines.join("\n"), data: r.data, display };
  }
  return r.lines.length ? { text: bound(r.lines.join("\n"), ctx), display } : { text: `No matches for ${pattern}`, display };
}

const SCAN_BATCH = 16;

/** Read candidate files in concurrent batches and test the regex per line; skip big and binary files. */
async function scanFiles(
  re: RegExp,
  reMulti: RegExp,
  files: { abs: string; rel: string }[],
  opts: SearchOptions,
  ctx: ToolContext,
): Promise<{ lines: string[]; data: GrepData; total: number }> {
  const cap = lineCapOf(ctx);
  const fileHits: { rel: string; mtimeMs: number }[] = [];
  const countLines: string[] = [];
  const rows: ContentRow[] = [];
  for (let offset = 0; offset < files.length; offset += SCAN_BATCH) {
    if (ctx.signal.aborted) break;
    if (opts.mode === "content" && rows.length > opts.caps.lines) break;
    const batch = files.slice(offset, offset + SCAN_BATCH);
    const loaded = await Promise.all(
      batch.map(async (file) => {
        try {
          const st = await stat(file.abs);
          if (st.size > MAX_FILE_BYTES) return null;
          const buf = await readFile(file.abs);
          if (buf.subarray(0, BINARY_SNIFF).indexOf(0) !== -1) return null; // binary
          return { file, mtimeMs: st.mtimeMs, whole: buf.toString("utf8") };
        } catch {
          return null;
        }
      }),
    );
    for (const item of loaded) {
      if (!item) continue;
      // One multiline test over the whole file skips the line-array allocation on non-matching files.
      if (!reMulti.test(item.whole)) continue;
      if (opts.mode === "files_with_matches") {
        fileHits.push({ rel: item.file.rel, mtimeMs: item.mtimeMs });
        continue;
      }
      const lines = item.whole.split(/\r?\n/);
      if (opts.mode === "count") {
        const count = lines.reduce((n, line) => (re.test(line) ? n + 1 : n), 0);
        if (count > 0) countLines.push(`${item.file.rel}:${count}`);
        continue;
      }
      // One past the cap, so a script's too-broad query is detected (finish throws) instead of cutting silently.
      for (let i = 0; i < lines.length && rows.length <= opts.caps.lines; i++) {
        const line = lines[i]!;
        if (!re.test(line)) continue;
        const row: ContentRow = { path: item.file.rel, line: i + 1, text: line.slice(0, cap) };
        if (opts.context > 0) {
          const from = Math.max(0, i - opts.context);
          const before = lines.slice(from, i).map((l, k) => `${from + k + 1}:${l.slice(0, cap)}`);
          const after = lines.slice(i + 1, i + 1 + opts.context).map((l, k) => `${i + 2 + k}:${l.slice(0, cap)}`);
          if (before.length) row.before = before;
          if (after.length) row.after = after;
        }
        rows.push(row);
      }
    }
  }
  if (opts.mode === "files_with_matches") {
    fileHits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const kept = fileHits.slice(0, opts.caps.files).map((h) => h.rel);
    return { lines: kept, data: kept, total: fileHits.length };
  }
  if (opts.mode === "count") return { lines: countLines, data: countsData(countLines), total: countLines.length };
  const kept = rows.slice(0, opts.caps.lines);
  return { lines: rowsToLines(kept), data: kept, total: rows.length };
}

/** Search file contents by regular expression. */
export const grepTool: NativeTool = {
  name: "grep",
  displayName: "Grep",
  description:
    "Search file contents for a regular expression. By default it returns the paths of files with at least one match; output_mode \"content\" returns matching lines as path:line:text and \"count\" returns path:count per file. Set ignore_case for a case-insensitive search, glob to restrict which files are searched (for example \"*.ts\"), limit to cap the results, and context (0-20, content mode) for the lines around each match. Skips vendor and build folders, files over 1 MB, and binary files. Use it to find where something is defined or referenced.",
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
      limit: { type: "integer", description: "Cap the results returned (files or matching lines)." },
      context: { type: "integer", description: "Lines of context around each match, 0-20 (content mode only)." },
    },
    required: ["pattern"],
  },
  access: "read",
  returns: 'string[] /* files_with_matches */ | Record<string, number> /* count */ | { path: string; line: number; text: string; before?: string[]; after?: string[] }[] /* content */',
  summarize(args) {
    return strAny(args, ["pattern", "query", "regex"], true);
  },
  async run(args, ctx) {
    const pattern = strAny(args, ["pattern", "query", "regex"], true);
    const ignoreCase = boolAny(args, ["ignore_case", "ignoreCase", "case_insensitive"]);
    const glob = strAny(args, ["glob", "include", "filePattern"]);
    const rawMode = strAny(args, ["output_mode", "outputMode", "mode"]) ?? "files_with_matches";
    const modeArg = MODE_ALIASES[rawMode] ?? rawMode;
    if (!MODES.includes(modeArg as OutputMode)) {
      throw new ToolError(`Unknown output_mode "${modeArg}"; use files_with_matches, content, or count.`);
    }
    const mode = modeArg as OutputMode;
    const limit = intAny(args, ["limit"]);
    const context = Math.min(MAX_CONTEXT, Math.max(0, intAny(args, ["context"]) ?? 0));
    let re: RegExp;
    let reMulti: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
      reMulti = new RegExp(pattern, ignoreCase ? "im" : "m");
    } catch (e) {
      throw new ToolError(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }
    const target = resolvePath(ctx.cwd, strAny(args, ["path"]) ?? ".");
    const opts: SearchOptions = { target, ...(glob ? { glob } : {}), ignoreCase, mode, context, caps: capsOf(ctx, limit) };

    const rg = rgPath(ctx.env ?? process.env, ctx.platform ?? process.platform, ctx.env === undefined);
    if (rg) return finish(await runRipgrep(rg, pattern, opts, ctx), pattern, ctx, limit);

    // Fallback: gather the candidate files (skipping glob filters), then scan.
    let isFile = false;
    try {
      isFile = (await stat(target.abs)).isFile();
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
    return finish(await scanFiles(re, reMulti, files, opts, ctx), pattern, ctx, limit);
  },
};
