// Document tools for every thread and every agent: the model writes content
// (Markdown for Word, JSON for PowerPoint and Excel, HTML for PDF) and one call
// builds the file with all layout rules and checks applied. The work runs in
// the app (bundled scripts, bundled packages, an offscreen print window), so it
// behaves the same for Claude, Codex, OpenCode and provider agents, in any mode.

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import type { HarnessTool, ToolOutput } from "../agents/types";
import { resolveInside } from "../artifacts";
import { runDocScript, type ScriptResult } from "./run";

export interface DocumentToolDeps {
  /** The thread's working folder, or null when it has none. */
  folder(threadId: string): string | null;
  /** The bundled skills folder (holding docx/, pptx/ and xlsx/ with their scripts). */
  scriptsDir: string;
  /** Where the scripts' packages resolve from (the app's own node_modules). */
  packagesRoot: string;
  run?: typeof runDocScript;
  /** Print `htmlRel` (in the thread's folder) to `pdfRel`; the page's text and a PNG of page 1 come back. */
  printPdf(threadId: string, htmlRel: string, pdfRel: string): Promise<{ pages: number; text: string; png: Buffer }>;
  /** The HTML starter a PDF begins from (absolute path). */
  pdfTemplate: string;
}

type Format = "docx" | "pptx" | "xlsx" | "pdf";

const SCRIPT: Record<Exclude<Format, "pdf">, string> = { docx: "docx/scripts/docx.mjs", pptx: "pptx/scripts/deck.mjs", xlsx: "xlsx/scripts/sheet.mjs" };
const SOURCE_EXT: Record<Format, string> = { docx: ".md", pptx: ".json", xlsx: ".json", pdf: ".html" };
const MOJIBAKE = /â€|â†|Ã|Â |�/;
const PLACEHOLDER = /\b(TODO|TBD|lorem|ipsum|XXX)\b|\[insert/i;

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

const error = (text: string): ToolOutput => ({ text, isError: true });

/** The first garbled or placeholder snippet in `text`, or null. */
function badText(text: string): string | null {
  for (const re of [MOJIBAKE, PLACEHOLDER]) {
    const m = re.exec(text);
    if (m) return text.slice(Math.max(0, m.index - 20), m.index + 30).replace(/\s+/g, " ");
  }
  return null;
}

/** A script's answer as a tool result: its OK line, or its ERROR lines with what to do next. */
function scriptOutput(r: ScriptResult, again: string): ToolOutput {
  if (r.timedOut) return error("The document script took over two minutes and was stopped. Make the content smaller and try again.");
  if (r.code === 0) return { text: r.stdout || "OK" };
  return error(`${r.stderr || r.stdout || `The document script failed (exit ${r.code}).`}\n${again}`);
}

export function documentTools(deps: DocumentToolDeps, threadId: string): HarnessTool[] {
  const run = deps.run ?? runDocScript;
  const script = (f: Exclude<Format, "pdf">) => join(deps.scriptsDir, SCRIPT[f]);
  /** A path inside the thread's folder, relative to it; an error result otherwise. */
  const place = (p: string): { root: string; rel: string } | ToolOutput => {
    const root = deps.folder(threadId);
    if (!root) return error("This thread has no folder.");
    const rel = resolveInside(root, p.trim());
    return rel ? { root, rel } : error(`${p} is outside this thread's folder.`);
  };
  const isError = (v: unknown): v is ToolOutput => typeof v === "object" && v !== null && "isError" in v;

  /** The format a source file builds into. */
  const formatOf = (root: string, rel: string): Format | ToolOutput => {
    const ext = extname(rel).toLowerCase();
    if (ext === ".md" || ext === ".markdown") return "docx";
    if (ext === ".html" || ext === ".htm") return "pdf";
    if (ext !== ".json") return error(`${rel}: build a .docx from .md, a .pptx or .xlsx from .json, or a .pdf from .html.`);
    try {
      const data = JSON.parse(readFileSync(join(root, rel), "utf8")) as { slides?: unknown; sheets?: unknown };
      if (Array.isArray(data.slides)) return "pptx";
      if (Array.isArray(data.sheets)) return "xlsx";
    } catch (err) {
      return error(`${rel} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return error(`${rel}: the JSON needs a "slides" array (a deck) or a "sheets" array (a workbook). Start from document_template.`);
  };

  return [
    define({
      name: "document_template",
      description: "Start a Word, PowerPoint, Excel or PDF file: writes a filled-in example at path to edit, then call document_build. docx → .md, pptx/xlsx → .json, pdf → .html.",
      input: {
        format: z.enum(["docx", "pptx", "xlsx", "pdf"]).describe("The file type to make."),
        path: z.string().describe("Where to write the example, relative to the thread's folder, e.g. report.md, deck.json, budget.json, letter.html."),
      },
      autoAllow: true,
      effect: "mutate",
      async run({ format, path }) {
        const at = place(path);
        if (isError(at)) return at;
        if (extname(at.rel).toLowerCase() !== SOURCE_EXT[format]) return error(`A ${format} starts from a ${SOURCE_EXT[format]} file: name it like draft${SOURCE_EXT[format]}.`);
        if (existsSync(join(at.root, at.rel))) return error(`${at.rel} already exists: pick a new name, or edit it and call document_build.`);
        if (format === "pdf") {
          copyFileSync(deps.pdfTemplate, join(at.root, at.rel));
        } else {
          const r = await run(script(format), ["init", at.rel], at.root, deps.packagesRoot);
          if (r.code !== 0) return scriptOutput(r, "");
        }
        return { text: `Wrote ${at.rel}. Replace its example content with the real content (keep the structure), then call document_build with input "${at.rel}".` };
      },
    }),
    define({
      name: "document_build",
      description: "Build a .docx from Markdown, a .pptx or .xlsx from JSON, or a .pdf from HTML, with every layout rule and check applied. Fix every ERROR it reports and build again until it says OK.",
      input: {
        input: z.string().describe("The source file in the thread's folder: .md → .docx, .json → .pptx or .xlsx, .html → .pdf."),
        output: z.string().optional().describe("The file to write; defaults to the input's name with the new extension."),
      },
      autoAllow: true,
      effect: "mutate",
      async run({ input, output }) {
        const src = place(input);
        if (isError(src)) return src;
        if (!existsSync(join(src.root, src.rel))) return error(`${src.rel} doesn't exist yet. Call document_template first, or write it.`);
        const format = formatOf(src.root, src.rel);
        if (isError(format)) return format;
        const outRel = output ?? src.rel.replace(/\.[^./\\]+$/, `.${format}`);
        const out = place(outRel);
        if (isError(out)) return out;
        if (extname(out.rel).toLowerCase() !== `.${format}`) return error(`${src.rel} builds a .${format}; name the output like ${src.rel.replace(/\.[^./\\]+$/, `.${format}`)}.`);
        if (format !== "pdf") return scriptOutput(await run(script(format), ["build", src.rel, out.rel], src.root, deps.packagesRoot), "Fix these and call document_build again.");
        try {
          const printed = await deps.printPdf(threadId, src.rel, out.rel);
          const bad = badText(printed.text);
          if (bad) return error(`${out.rel}: garbled or placeholder text: "${bad}". Fix ${src.rel} (save it as UTF-8 with your file tools, replace placeholders) and call document_build again.`);
          if (!printed.text.trim()) return error(`${out.rel} has no text: check ${src.rel} has its content in the <body>.`);
          return { text: `OK: ${out.rel} — ${printed.pages} page${printed.pages === 1 ? "" : "s"}. Page 1 is attached: check nothing overlaps or is cut off.`, imagePng: printed.png.toString("base64") };
        } catch (err) {
          return error(`Printing ${src.rel} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    }),
    define({
      name: "document_check",
      description: "Check an existing .docx, .pptx or .xlsx for broken layout, garbled text, placeholders and missing formula results.",
      input: { path: z.string().describe("The file in the thread's folder.") },
      autoAllow: true,
      effect: "read",
      async run({ path }) {
        const at = place(path);
        if (isError(at)) return at;
        if (!existsSync(join(at.root, at.rel))) return error(`${at.rel} doesn't exist.`);
        const ext = extname(at.rel).toLowerCase().slice(1);
        if (ext === "pdf") return error("Check a PDF by building it from its HTML with document_build: that prints it and checks it.");
        if (ext !== "docx" && ext !== "pptx" && ext !== "xlsx") return error(`${at.rel} isn't a .docx, .pptx or .xlsx.`);
        return scriptOutput(await run(script(ext), ["check", at.rel], at.root, deps.packagesRoot), "Rebuild it from its source with document_build after fixing these.");
      },
    }),
  ];
}
