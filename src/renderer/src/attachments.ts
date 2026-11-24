import type { AttachmentSource } from "../../shared/types";
import { refThumb } from "./design/refs";

/** Most files one message carries (the main process enforces it too). */
export const MAX_ATTACHMENTS = 10;
/** The largest attachment, in bytes. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** A file in the composer, not yet copied into the thread: by path when it has one, else its bytes. */
export interface PendingAttachment {
  id: string;
  name: string;
  size: number;
  /** A small data-URL thumbnail for images that have one; "" otherwise. */
  thumb: string;
  source: AttachmentSource;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const isImageType = (type: string): boolean => IMAGE_TYPES.has(type);

/** "12 KB", "3.4 MB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let next = 0;
const newId = (): string => `att-${Date.now().toString(36)}-${(next++).toString(36)}`;

/**
 * Turn pasted, dropped or picked files into pending attachments, keeping to the limits.
 * `room` is how many more the message may take; what doesn't fit or is too big is named in `refused`.
 */
export async function pendingFrom(
  files: ArrayLike<File>,
  room: number,
  pathForFile: (file: File) => string,
): Promise<{ added: PendingAttachment[]; refused: string[] }> {
  const added: PendingAttachment[] = [];
  const refused: string[] = [];
  for (const file of Array.from(files)) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      refused.push(`${file.name || "a file"} (over 20 MB)`);
      continue;
    }
    if (added.length >= room) {
      refused.push(`${file.name || "a file"} (at most ${MAX_ATTACHMENTS} files per message)`);
      continue;
    }
    const name = file.name || (isImageType(file.type) ? `pasted.${file.type.split("/")[1]?.replace("jpeg", "jpg")}` : "pasted-file");
    const path = pathForFile(file);
    let source: AttachmentSource;
    try {
      source = path ? { name, path } : { name, bytes: new Uint8Array(await file.arrayBuffer()) };
    } catch {
      refused.push(`${name} (couldn't be read)`);
      continue;
    }
    const thumb = isImageType(file.type) ? await refThumb(file, 64) : "";
    added.push({ id: newId(), name, size: file.size, thumb, source });
  }
  return { added, refused };
}

/** Pending attachments for files the native picker returned (by path, no thumbnail). */
export function pendingFromPicked(picked: { name: string; path: string; size: number }[], room: number): { added: PendingAttachment[]; refused: string[] } {
  const added: PendingAttachment[] = [];
  const refused: string[] = [];
  for (const p of picked) {
    if (p.size > MAX_ATTACHMENT_BYTES) refused.push(`${p.name} (over 20 MB)`);
    else if (added.length >= room) refused.push(`${p.name} (at most ${MAX_ATTACHMENTS} files per message)`);
    else added.push({ id: newId(), name: p.name, size: p.size, thumb: "", source: { name: p.name, path: p.path } });
  }
  return { added, refused };
}

/** A long file name cut in the middle so its extension stays readable: "quarterly-rep…final.xlsx". */
export function shortName(name: string, max = 26): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, dot) : name;
  const room = max - ext.length - 1;
  const head = Math.ceil(room * 0.65);
  return `${stem.slice(0, head)}…${stem.slice(stem.length - (room - head))}${ext}`;
}

export type FileKind = "image" | "pdf" | "doc" | "sheet" | "slides" | "archive" | "code" | "text" | "audio" | "video" | "file";

const KIND_BY_EXT: Record<string, FileKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", heic: "image", bmp: "image", tiff: "image",
  pdf: "pdf",
  doc: "doc", docx: "doc", rtf: "doc", odt: "doc", pages: "doc",
  xls: "sheet", xlsx: "sheet", csv: "sheet", tsv: "sheet", ods: "sheet", numbers: "sheet",
  ppt: "slides", pptx: "slides", odp: "slides", key: "slides",
  zip: "archive", gz: "archive", tgz: "archive", tar: "archive", rar: "archive", "7z": "archive",
  js: "code", ts: "code", tsx: "code", jsx: "code", py: "code", rb: "code", go: "code", rs: "code", java: "code", c: "code", cpp: "code", h: "code", cs: "code", swift: "code", kt: "code", sh: "code", json: "code", html: "code", htm: "code", css: "code", xml: "code", yaml: "code", yml: "code", sql: "code",
  txt: "text", md: "text", log: "text",
  mp3: "audio", wav: "audio", m4a: "audio", flac: "audio", ogg: "audio",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video",
};

/** What kind of file this is, for its icon: by extension, else by media type. */
export function fileKind(name: string, mediaType = ""): FileKind {
  const dot = name.lastIndexOf(".");
  const byExt = dot > 0 ? KIND_BY_EXT[name.slice(dot + 1).toLowerCase()] : undefined;
  if (byExt) return byExt;
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType.startsWith("text/")) return "text";
  return "file";
}
