import type { ArtifactKind } from "./types";

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "zsh", "bash", "ps1", "css", "scss", "less", "sql",
  "yaml", "yml", "toml", "xml", "vue", "svelte", "lua", "dart", "r",
]);

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  md: "md", markdown: "md", mdx: "md",
  html: "html", htm: "html",
  svg: "svg",
  pdf: "pdf",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image",
  csv: "csv", tsv: "csv",
  docx: "docx",
  xlsx: "sheet", xls: "sheet", ods: "sheet",
  pptx: "pptx",
};

/** The artifact kind for a path, from its extension (case-insensitive). */
export function artifactKind(path: string): ArtifactKind {
  const ext = (/\.([^./\\]+)$/.exec(path)?.[1] ?? "").toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) return "code";
  return KIND_BY_EXT[ext] ?? "text";
}

/** Every kind the panel can render; code and text fall back to a plain source view. */
export const PREVIEWABLE: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(["md", "html", "svg", "pdf", "image", "csv", "docx", "sheet", "pptx"]);

/** Whether the panel has a real renderer for this path. */
export function isPreviewable(path: string): boolean {
  return PREVIEWABLE.has(artifactKind(path));
}


/**
 * Kinds that open the panel on their own when a turn ends. Markdown and code
 * don't (user decision 2026-10-02): their file card has a Preview button instead.
 */
export const AUTO_OPEN: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(["html", "svg", "pdf", "image", "csv", "docx", "sheet", "pptx"]);

/** Whether a file the agent wrote should open the panel by itself at turn end. */
export function opensByItself(path: string): boolean {
  return AUTO_OPEN.has(artifactKind(path));
}
