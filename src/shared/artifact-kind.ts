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


/** Kinds a page or note is rendered into (a PDF, a Word file, a deck, a sheet). */
const EXPORTS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(["pdf", "docx", "pptx", "sheet"]);

/** A path's file name without its extension, lower-cased: output/pdf/Estimate.pdf -> estimate. */
function stem(path: string): string {
  return (path.split(/[/\\]/).pop() ?? path).replace(/\.[^.]+$/, "").toLowerCase();
}

/**
 * The files a turn wrote, less an HTML or Markdown source it rendered into an
 * export of the same name (estimate.html -> estimate.pdf): the export is the
 * deliverable, so it gets the card and the panel, not its source too.
 */
export function withoutExportSources(paths: readonly string[]): string[] {
  const exported = new Set(paths.filter((p) => EXPORTS.has(artifactKind(p))).map(stem));
  return paths.filter((p) => {
    const kind = artifactKind(p);
    return !((kind === "html" || kind === "md") && exported.has(stem(p)));
  });
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

/**
 * The thread's plan proposals, kept as artifact versions under a path that is
 * never a file (":" can't name one on Windows, and it never resolves inside the
 * project), so the panel reads every round from the store and nothing touches disk.
 */
export const PLAN_ARTIFACT = "cubiq:plan.md";

export function isPlanArtifact(path: string): boolean {
  return path === PLAN_ARTIFACT;
}

/** A design thread's critiques (design_critique_save), stored the same way as the plan. */
export const CRITIQUE_ARTIFACT = "cubiq:critique.md";

/**
 * A team member's result file, copied from the team workspace (outside the
 * project, in the app's data folder) into the version store when it's opened.
 */
export const TEAM_ARTIFACT_PREFIX = "cubiq:team/";

export function teamArtifact(name: string): string {
  return `${TEAM_ARTIFACT_PREFIX}${name}.md`;
}

/** Artifacts that live only in the version store: the plan, the design critique and team results. */
export function isPseudoArtifact(path: string): boolean {
  return path === PLAN_ARTIFACT || path === CRITIQUE_ARTIFACT || path.startsWith(TEAM_ARTIFACT_PREFIX);
}

/** The name a pseudo-artifact shows in the panel, or null for a real file. */
export function pseudoArtifactLabel(path: string): string | null {
  if (path.startsWith(TEAM_ARTIFACT_PREFIX)) return path.slice(TEAM_ARTIFACT_PREFIX.length);
  return path === PLAN_ARTIFACT ? "Plan" : path === CRITIQUE_ARTIFACT ? "Critique" : null;
}
