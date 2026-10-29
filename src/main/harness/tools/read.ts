// The model's Read tool: numbered text lines with offset/limit paging, a
// directory listing, PNG images, and a refusal for binary files.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { bound } from "./bound";
import { noteRead, resolvePath } from "./paths";
import { ToolError, str, int, type NativeTool } from "./types";

const MAX_ENTRIES = 500;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_LINE_CHARS = 2000;
/** The most a script (code mode) may read in one call. */
export const SCRIPT_MAX_READ_BYTES = 2 * 1024 * 1024;

/** Read a file (or list a directory) for the model to see its contents. */
export const readTool: NativeTool = {
  name: "read",
  displayName: "Read",
  access: "read",
  returns: "string /* a file's raw text */ | string[] /* a directory's entries */",
  description:
    "Read a file from the thread's folder, or list a directory when the path is a directory. " +
    "Text files come back as numbered lines and can be paged with offset and limit; when the window leaves lines behind, the result says how to read the rest. " +
    "PNG images are returned as images, and binary files are refused. " +
    "Paths resolve against the thread's working folder.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory path, relative to the thread's working folder or absolute." },
      offset: { type: "integer", description: "The 1-based line to start from (default 1)." },
      limit: { type: "integer", description: "The maximum number of lines to return (default 2000)." },
    },
    required: ["path"],
  },
  summarize: (args) => str(args, "path") ?? "",
  run: async (args, ctx) => {
    const p = resolvePath(ctx.cwd, str(args, "path", true));
    let isDir = false;
    try {
      isDir = statSync(p.abs).isDirectory();
    } catch {
      throw new ToolError(`No such file: ${p.shown}`);
    }

    if (isDir) {
      const entries = readdirSync(p.abs, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      if (ctx.script) return { text: entries.join("\n"), data: entries, display: { summary: p.shown } };
      const shown = entries.slice(0, MAX_ENTRIES);
      const more = entries.length - shown.length;
      const text = shown.join("\n") + (more > 0 ? `\n[${more} more entries]` : "");
      return { text, display: { summary: p.shown } };
    }

    const buf = readFileSync(p.abs);
    if (extname(p.abs).toLowerCase() === ".png") {
      noteRead(ctx, p.abs);
      return { text: `Image ${p.shown}`, imagePng: buf.toString("base64"), display: { summary: p.shown } };
    }
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new ToolError(`${p.shown} is a binary file.`);

    const content = buf.toString("utf8");
    // A script gets the raw text (or the offset/limit window of it), with no line numbers to strip.
    if (ctx.script) {
      if (buf.length > SCRIPT_MAX_READ_BYTES) throw new ToolError(`${p.shown} is over ${SCRIPT_MAX_READ_BYTES / 1024 / 1024} MB; read it with offset and limit, or grep it.`);
      const offset = int(args, "offset");
      const limit = int(args, "limit");
      const raw =
        offset === undefined && limit === undefined
          ? content
          : content
              .split("\n")
              .slice(Math.max(1, offset ?? 1) - 1, Math.max(1, offset ?? 1) - 1 + Math.max(1, limit ?? Number.MAX_SAFE_INTEGER))
              .join("\n");
      noteRead(ctx, p.abs);
      return { text: raw, data: raw, display: { summary: p.shown } };
    }
    const lines = content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    // A final newline ends the last line; it doesn't start another.
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    const total = lines.length;
    const first = Math.max(1, int(args, "offset") ?? 1);
    const limit = Math.max(1, int(args, "limit") ?? 2000);
    const start = first - 1;
    const window = lines.slice(start, start + limit);
    let text = content === "" ? "(empty file)" : window.map((line, i) => {
      const n = start + i + 1;
      const cut = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
      return `${String(n).padStart(6)}\t${cut}`;
    }).join("\n");
    if (content !== "" && start + window.length < total) {
      const last = start + window.length;
      text += `\n\n[Lines ${first}-${last} of ${total}. Use offset=${last + 1} to read more.]`;
    }

    noteRead(ctx, p.abs);
    return { text: bound(text, ctx), display: { summary: p.shown } };
  },
};
