// The model's Read tool: numbered text lines with offset/limit paging, a
// directory listing, PNG images, and a refusal for binary files.

import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { extname } from "node:path";
import { bound } from "./bound";
import { noteRead, resolvePath, scopedReadPath } from "./paths";
import { ToolError, intAny, strAny, type NativeTool } from "./types";

const MAX_ENTRIES = 500;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_LINE_CHARS = 2000;
/** Files past this are read as a line stream, so only the window is held in memory. */
const STREAM_BYTES = 16 * 1024 * 1024;
/** The most a script (code mode) may read in one call without an offset/limit window. */
export const SCRIPT_MAX_READ_BYTES = 2 * 1024 * 1024;
/** The biggest file a script may page through with offset/limit at all; past it, grep. */
const SCRIPT_MAX_FILE_BYTES = 64 * 1024 * 1024;

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
  summarize: (args) => strAny(args, ["path", "file_path", "filePath"]) ?? "",
  run: async (args, ctx) => {
    const p = scopedReadPath(ctx, resolvePath(ctx.cwd, strAny(args, ["path", "file_path", "filePath"], true)));
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(p.abs);
    } catch {
      throw new ToolError(`No such file: ${p.shown}`);
    }

    if (st.isDirectory()) {
      const entries = (await readdir(p.abs, { withFileTypes: true }))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      if (ctx.script) return { text: entries.join("\n"), data: entries, display: { summary: p.shown } };
      const shown = entries.slice(0, MAX_ENTRIES);
      const more = entries.length - shown.length;
      const text = shown.join("\n") + (more > 0 ? `\n[${more} more entries]` : "");
      return { text, display: { summary: p.shown } };
    }

    if (extname(p.abs).toLowerCase() === ".png") {
      const buf = await readFile(p.abs);
      noteRead(ctx, p.abs, st.mtimeMs);
      return { text: `Image ${p.shown}`, imagePng: buf.toString("base64"), display: { summary: p.shown } };
    }

    // A script's window: offset/limit page a big file, as the refusals below say; without them the whole file must fit.
    const offset = intAny(args, ["offset", "start_line", "startLine"]);
    let scriptLimit = intAny(args, ["limit"]);
    const end = intAny(args, ["end_line", "endLine"]);
    if (scriptLimit === undefined && end !== undefined) scriptLimit = Math.max(1, end - Math.max(1, offset ?? 1) + 1);
    // Refused on the size alone, before anything is read.
    if (ctx.script) {
      if (st.size > SCRIPT_MAX_READ_BYTES && offset === undefined && scriptLimit === undefined) {
        throw new ToolError(`${p.shown} is over ${SCRIPT_MAX_READ_BYTES / 1024 / 1024} MB; read it with offset and limit, or grep it.`);
      }
      if (st.size > SCRIPT_MAX_FILE_BYTES) throw new ToolError(`${p.shown} is over ${SCRIPT_MAX_FILE_BYTES / 1024 / 1024} MB; grep it instead of reading it.`);
    }

    // A big file is sniffed from its head and read as a line stream, holding only the window.
    const buf = st.size > STREAM_BYTES ? null : await readFile(p.abs);
    const head = buf ? buf.subarray(0, BINARY_SNIFF_BYTES) : await readHead(p.abs, BINARY_SNIFF_BYTES);
    if (head.includes(0)) throw new ToolError(`${p.shown} is a binary file.`);

    // A script gets the raw text (or the offset/limit window of it), with no line numbers to strip.
    if (ctx.script) {
      const first = Math.max(1, offset ?? 1) - 1;
      const count = Math.max(1, scriptLimit ?? Number.MAX_SAFE_INTEGER);
      let raw: string;
      if (buf) {
        // CRLF files match what the non-script read shows, so a regex $ anchor works on them.
        const content = buf.toString("utf8").replace(/\r\n/g, "\n");
        raw = offset === undefined && scriptLimit === undefined ? content : content.split("\n").slice(first, first + count).join("\n");
      } else {
        raw = (await lineWindow(p.abs, first, count, ctx.signal)).lines.join("\n");
      }
      if (Buffer.byteLength(raw) > SCRIPT_MAX_READ_BYTES) throw new ToolError(`That window of ${p.shown} is over ${SCRIPT_MAX_READ_BYTES / 1024 / 1024} MB; use a smaller limit, or grep it.`);
      noteRead(ctx, p.abs, st.mtimeMs);
      return { text: raw, data: raw, display: { summary: p.shown } };
    }
    const first = Math.max(1, offset ?? 1);
    const limit = Math.max(1, intAny(args, ["limit"]) ?? 2000);
    const start = first - 1;
    let content: string | null = null;
    let window: string[];
    let total: number;
    if (buf) {
      content = buf.toString("utf8");
      const lines = content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
      // A final newline ends the last line; it doesn't start another.
      if (lines.length > 1 && lines.at(-1) === "") lines.pop();
      total = lines.length;
      window = lines.slice(start, start + limit);
    } else {
      ({ lines: window, total } = await lineWindow(p.abs, start, limit, ctx.signal));
    }
    let text = content === "" ? "(empty file)" : window.map((line, i) => {
      const n = start + i + 1;
      const cut = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
      return `${String(n).padStart(6)}\t${cut}`;
    }).join("\n");
    if (content !== "" && start + window.length < total) {
      const last = start + window.length;
      text += `\n\n[Lines ${first}-${last} of ${total}. Use offset=${last + 1} to read more.]`;
    }

    noteRead(ctx, p.abs, st.mtimeMs);
    return { text: bound(text, ctx), display: { summary: p.shown } };
  },
};

/** The first `n` bytes of a file. */
async function readHead(path: string, n: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(n), 0, n, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Lines [start, start + count) of a text file and its line count, streamed (CRLF and a final newline read as today's split does). */
async function lineWindow(path: string, start: number, count: number, signal?: AbortSignal): Promise<{ lines: string[]; total: number }> {
  const input = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const lines: string[] = [];
  let total = 0;
  try {
    for await (const line of rl) {
      if (signal?.aborted) throw new ToolError("Stopped.");
      if (total >= start && total < start + count) lines.push(line);
      total += 1;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return { lines, total };
}
