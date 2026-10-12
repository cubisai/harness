import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The largest reference image CubiQ accepts, in bytes. */
export const MAX_REF_BYTES = 10 * 1024 * 1024;

/** The image formats a pasted reference screenshot may arrive in. */
export type RefKind = "png" | "jpg" | "webp" | "gif";

const startsWith = (bytes: Uint8Array, sig: number[], at = 0): boolean =>
  bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** The kind of image these bytes are from their magic numbers, or null when it is none of png, jpg, webp or gif. */
export function imageKind(bytes: Uint8Array): RefKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "webp";
  return null;
}

const REF_RE = /^ref-(\d+)\./;

/** Saves a pasted reference image under `<root>/refs/` and returns its path relative to the design folder. */
export function saveRef(root: string, bytes: Uint8Array): string {
  if (bytes.length > MAX_REF_BYTES) throw new Error("Image is over 10 MB.");
  const kind = imageKind(bytes);
  if (!kind) throw new Error("Not an image (png, jpg, webp or gif).");
  const dir = join(root, "refs");
  mkdirSync(dir, { recursive: true });
  let max = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const m = REF_RE.exec(entry.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const name = `ref-${max + 1}.${kind}`;
  writeFileSync(join(dir, name), bytes);
  return `refs/${name}`;
}
