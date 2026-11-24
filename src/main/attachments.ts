import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Attachment, AttachmentSource } from "../shared/types";
import { imageKind } from "./design/refs";
import { assertContained } from "./extensions/install";

/** At most this many files per message. */
export const MAX_ATTACHMENTS = 10;
/** The largest file a message may carry, in bytes. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** The largest image sent to an agent as image input; bigger ones go as a path only. */
export const INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** Where a thread's attachments are copied, relative to its folder (posix). */
export const ATTACHMENTS_DIR = ".cubiq/attachments";

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  svg: "image/svg+xml",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** A file name safe on every OS: no folders, no reserved characters, at most 80 characters. */
export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, "/"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!base) return "file";
  if (base.length <= 80) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : "";
  return base.slice(0, 80 - ext.length) + ext;
}

/** The media type of a file: images by their magic numbers (whatever the name says), the rest by extension. */
export function mediaTypeOf(name: string, bytes: Uint8Array): string {
  const kind = imageKind(bytes);
  if (kind) return IMAGE_TYPES[kind]!;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return BY_EXT[ext] ?? "application/octet-stream";
}

function readSource(source: AttachmentSource): { name: string; bytes: Uint8Array } {
  if (typeof source !== "object" || source === null) throw new Error("Unreadable attachment.");
  const rawName = typeof source.name === "string" ? source.name : "";
  if ("path" in source && typeof source.path === "string") {
    const stat = statSync(source.path);
    if (!stat.isFile()) throw new Error(`${rawName || basename(source.path)} isn't a file.`);
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`${rawName || basename(source.path)} is over 20 MB.`);
    return { name: rawName || basename(source.path), bytes: readFileSync(source.path) };
  }
  if ("bytes" in source && source.bytes instanceof Uint8Array) {
    if (source.bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`${rawName || "The file"} is over 20 MB.`);
    return { name: rawName, bytes: source.bytes };
  }
  throw new Error("Unreadable attachment.");
}

/**
 * Copy files into `<root>/.cubiq/attachments/` as `<id>-<name>` and describe them.
 * All or nothing: a file that fails removes the ones this call already wrote.
 */
export function saveAttachments(root: string, sources: unknown): Attachment[] {
  if (!Array.isArray(sources) || sources.length === 0) return [];
  if (sources.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} files per message.`);
  const dir = join(root, ...ATTACHMENTS_DIR.split("/"));
  mkdirSync(dir, { recursive: true });
  // The folder must stay in the thread's folder, even if .cubiq was replaced with a symlink.
  assertContained(root, dir, "attachments folder");
  try {
    writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx" });
  } catch {
    // Already there.
  }
  const written: string[] = [];
  try {
    return sources.map((source: AttachmentSource) => {
      const { name: raw, bytes } = readSource(source);
      const name = safeName(raw);
      const file = `${randomUUID().slice(0, 8)}-${name}`;
      const target = join(dir, file);
      writeFileSync(target, bytes, { flag: "wx" });
      written.push(target);
      return { path: `${ATTACHMENTS_DIR}/${file}`, name, size: bytes.length, mediaType: mediaTypeOf(name, bytes) };
    });
  } catch (err) {
    for (const path of written) rmSync(path, { force: true });
    throw err;
  }
}

/** The attachments of a send that are real files this thread holds; anything else is dropped. */
export function checkedAttachments(root: string, list: unknown): Attachment[] {
  if (!Array.isArray(list)) return [];
  const out: Attachment[] = [];
  for (const a of list.slice(0, MAX_ATTACHMENTS)) {
    if (typeof a !== "object" || a === null) continue;
    const { path, name, mediaType } = a as Record<string, unknown>;
    if (typeof path !== "string" || typeof name !== "string" || typeof mediaType !== "string") continue;
    const rest = path.startsWith(`${ATTACHMENTS_DIR}/`) ? path.slice(ATTACHMENTS_DIR.length + 1) : "";
    if (!rest || rest.includes("/") || rest.includes("\\") || rest === ".." || rest.startsWith(".")) continue;
    let size: number;
    try {
      const abs = assertContained(root, join(root, ...path.split("/")), "attachment");
      const stat = statSync(abs);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    out.push({ path, name: safeName(name), size, mediaType });
  }
  return out;
}

/** The images an agent may take as image input: png, jpeg, gif or webp, at most 5 MB each. Paths are absolute. */
export function inlineImages(root: string, attachments: Attachment[]): { path: string; mediaType: string }[] {
  return attachments
    .filter((a) => Object.values(IMAGE_TYPES).includes(a.mediaType) && a.size <= INLINE_IMAGE_BYTES)
    .map((a) => ({ path: join(root, ...a.path.split("/")), mediaType: a.mediaType }));
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The prompt's note listing what the user attached; "" when nothing. */
export function attachmentNote(attachments: Attachment[]): string {
  if (!attachments.length) return "";
  const lines = attachments.map((a) => `- ${a.path} (${a.name}, ${a.mediaType}, ${sizeLabel(a.size)})`);
  return `\n\nThe user attached these files (paths relative to your working folder). Read them with your own tools when you need their contents; images are also included as images when you can see them:\n${lines.join("\n")}`;
}
