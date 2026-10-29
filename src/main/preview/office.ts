import { posix } from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

import type { OfficePreview, SheetPreview, SlidePreview } from "../../shared/types";

export type { OfficePreview, SheetPreview, SlidePreview };

/** Rows kept per sheet before a preview is marked truncated. */
export const MAX_ROWS = 5000;

/** How many bytes of images one deck may embed before the rest are dropped. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const SHEET_EXTENSIONS = new Set(["xlsx", "xls", "xlsm", "ods", "csv", "tsv"]);

/** The extension of a path, lowercased and without the dot, or null. */
function extensionOf(path: string): string | null {
  const match = /\.([^./\\]+)$/.exec(path);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/** Which preview a path's extension maps to, or null when unsupported. */
export function previewKind(path: string): "docx" | "sheet" | "pptx" | null {
  const ext = extensionOf(path);
  if (!ext) return null;
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  if (SHEET_EXTENSIONS.has(ext)) return "sheet";
  return null;
}

/**
 * Defence in depth only: strips the active-content shapes a docx can smuggle in,
 * so the sandboxed renderer gets a second line of defence. Regex-based on
 * purpose — it never has to parse, only to remove what it recognises.
 */
export function sanitizeHtml(html: string): string {
  return (
    html
      // Elements whose content is never safe: drop the whole element.
      .replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      // Anything left of those (unclosed or self-closed) as bare tags.
      .replace(/<\/?(?:script|style|iframe|object)\b[^>]*>/gi, "")
      // Void/head elements we never want to render.
      .replace(/<\/?(?:link|meta|embed)\b[^>]*\/?>/gi, "")
      // Keep a form's contents, but drop its tags.
      .replace(/<\/?form\b[^>]*>/gi, "")
      // Inline event handlers, quoted or not.
      .replace(/(?<![\w-])on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // Script-bearing URLs; data: is allowed only for raster image sources.
      .replace(
        /(?<![\w-])(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
        (match, attr: string, dq?: string, sq?: string, uq?: string) => {
          const value = dq ?? sq ?? uq ?? "";
          if (/^\s*(?:javascript|vbscript):/i.test(value)) return attr.toLowerCase() === "src" ? 'src=""' : 'href="#"';
          if (attr.toLowerCase() === "src" && /^\s*data:/i.test(value) && !/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i.test(value)) return 'src=""';
          return match;
        },
      )
  );
}

/** Convert a .docx buffer to sanitized HTML, with mammoth's messages as warnings. */
export async function docxToHtml(buf: Buffer): Promise<OfficePreview> {
  const { value, messages } = await mammoth.convertToHtml({ buffer: buf });
  return { kind: "docx", html: sanitizeHtml(value), warnings: messages.map((m) => m.message) };
}

/** Read a workbook (or delimited text) into per-sheet string rows, capped at maxRows. */
export function sheetsFrom(buf: Buffer, path: string, maxRows = MAX_ROWS): OfficePreview {
  const ext = extensionOf(path);
  const delimited = ext === "csv" || ext === "tsv";
  const workbook = delimited
    ? XLSX.read(buf.toString("utf8"), { type: "string", raw: true, FS: ext === "tsv" ? "\t" : undefined })
    : XLSX.read(buf, { type: "buffer", cellFormula: false, cellHTML: false, cellDates: true });

  const sheets: SheetPreview[] = workbook.SheetNames.map((name) => {
    const worksheet = workbook.Sheets[name];
    const aoa = worksheet ? XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: false, defval: "" }) : [];
    const all = aoa.map((row) => (Array.isArray(row) ? row : [row]).map((cell) => (cell == null ? "" : String(cell))));
    const truncated = all.length > maxRows;
    return { name, rows: truncated ? all.slice(0, maxRows) : all, totalRows: all.length, truncated };
  });
  return { kind: "sheet", sheets };
}

/** Decode the XML entities OOXML text runs carry, including numeric ones. */
function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code >= 0 && code <= 0x10ffff && !Number.isNaN(code) ? String.fromCodePoint(code) : match;
    }
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return match;
    }
  });
}

/** The non-empty paragraph texts of a run of OOXML, each paragraph's <a:t> runs joined. */
function paragraphTexts(xml: string): string[] {
  const texts: string[] = [];
  for (const para of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let text = "";
    for (const run of (para[1] ?? "").matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)) text += decodeXml(run[1] ?? "");
    if (text.trim() !== "") texts.push(text);
  }
  return texts;
}

/** The title placeholder's text, falling back to the shape with type title/ctrTitle. */
function slideTitle(xml: string): string {
  for (const shape of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
    const body = shape[0] ?? "";
    if (!/<p:ph\b[^>]*\btype\s*=\s*"(?:title|ctrTitle)"/i.test(body)) continue;
    const texts = paragraphTexts(body);
    if (texts.length > 0) return texts.join(" ");
  }
  return "";
}

/** The mime type for an image extension, or null for formats we do not inline. */
function imageMime(path: string): string | null {
  switch (extensionOf(path)) {
    case "png":
      return "image/png";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    default:
      return null;
  }
}

/** The image targets a slide's .rels file points at, resolved into the zip. */
async function slideImageTargets(zip: JSZip, slide: number): Promise<string[]> {
  const rels = zip.file(`ppt/slides/_rels/slide${slide}.xml.rels`);
  if (!rels) return [];
  const xml = await rels.async("string");
  const targets: string[] = [];
  for (const rel of xml.matchAll(/<Relationship\b[^>]*>/gi)) {
    const tag = rel[0] ?? "";
    const type = /\bType\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? "";
    if (!type.endsWith("/image")) continue;
    const target = /\bTarget\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (target) targets.push(posix.normalize(posix.join("ppt/slides", target)));
  }
  return targets;
}

/** Extract slide order, titles, text, and embedded images (as data: URIs) from a .pptx. */
export async function pptxSlides(buf: Buffer, opts?: { maxImageBytes?: number }): Promise<OfficePreview> {
  const zip = await JSZip.loadAsync(buf);
  const maxImageBytes = opts?.maxImageBytes ?? MAX_IMAGE_BYTES;

  const slideFiles = Object.values(zip.files)
    .map((file) => ({ file, number: /^ppt\/slides\/slide(\d+)\.xml$/i.exec(file.name)?.[1] }))
    .filter((entry): entry is { file: JSZip.JSZipObject; number: string } => entry.number !== undefined)
    .sort((a, b) => Number(a.number) - Number(b.number));

  const slides: SlidePreview[] = [];
  let totalImageBytes = 0;
  let imagesStopped = false;

  for (const { file, number } of slideFiles) {
    const xml = await file.async("string");
    const texts = paragraphTexts(xml);
    const images: string[] = [];

    if (!imagesStopped) {
      for (const target of await slideImageTargets(zip, Number(number))) {
        const mime = imageMime(target);
        const data = mime ? await zip.file(target)?.async("nodebuffer") : undefined;
        if (!mime || !data) continue;
        if (totalImageBytes + data.length > maxImageBytes) {
          imagesStopped = true;
          break;
        }
        totalImageBytes += data.length;
        images.push(`data:${mime};base64,${data.toString("base64")}`);
      }
    }

    slides.push({ index: Number(number), title: slideTitle(xml) || texts[0] || "", texts, images });
  }

  return { kind: "pptx", slides };
}

/** Render whatever previewKind recognises; rejects anything else. */
export async function renderOffice(buf: Buffer, path: string): Promise<OfficePreview> {
  switch (previewKind(path)) {
    case "docx":
      return docxToHtml(buf);
    case "sheet":
      return sheetsFrom(buf, path);
    case "pptx":
      return pptxSlides(buf);
    default:
      throw new Error("Can't preview this file type");
  }
}
