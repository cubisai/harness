/** Most reference images one message carries. */
export const MAX_REFS = 4;

const REF_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** The pasted or dropped files that can be a design's reference image (png, jpg, webp, gif). */
export function imageFiles(files: ArrayLike<File> | null | undefined): File[] {
  return Array.from(files ?? []).filter((f) => REF_TYPES.has(f.type));
}

/**
 * The message with its reference images: each as an `@path` line (so the transcript shows it and the agent is told
 * where it is). An empty message still says what to do with them.
 */
export function withRefs(body: string, refs: string[]): string {
  if (!refs.length) return body;
  const lines = refs.map((r) => `Reference image: @${r}`).join("\n");
  return body ? `${body}\n\n${lines}` : `Design from this reference.\n\n${lines}`;
}

/** A short label for a reference chip: "Reference 2" for `…/refs/ref-2.png`. */
export function refLabel(path: string): string {
  const m = /ref-(\d+)\.[a-z]+$/i.exec(path);
  return m ? `Reference ${m[1]}` : "Reference";
}

/** A small data-URL thumbnail of an image file for its chip ("" when it can't be drawn). */
export async function refThumb(file: File, size = 40): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/png");
  } catch {
    return "";
  }
}
