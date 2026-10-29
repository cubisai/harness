import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { artifactKind, isPseudoArtifact, opensByItself, PLAN_ARTIFACT, pseudoArtifactLabel } from "../shared/artifact-kind";
import { unifiedDiff } from "../shared/diff";
import { canonicalTool } from "../shared/tools";
import type { ArtifactContent, ArtifactFile, ArtifactKind, ArtifactVersion, StoredEvent } from "../shared/types";
import type { PreviewResult } from "./preview/host";

/** A saved file bigger than this is not versioned or served. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
/** Text served to the panel is cut here; the response then sets `truncated`. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** How many leading bytes are scanned for a NUL when guessing binary. */
const NUL_SCAN_BYTES = 8000;

export { artifactKind, CRITIQUE_ARTIFACT, isPlanArtifact, isPreviewable, isPseudoArtifact, opensByItself, PLAN_ARTIFACT, PREVIEWABLE } from "../shared/artifact-kind";

/** Kinds whose only servable form is the newest one on disk. */
const LATEST_ONLY: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(["pdf", "image", "csv", "docx", "sheet", "pptx"]);

/** Kinds the diff view can render as text. */
const DIFFABLE: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(["md", "html", "svg", "code", "text", "csv"]);

/**
 * The files an agent wrote in the current turn: from every successful Edit
 * tool-use after the last user event. A file edited again moves to the end.
 */
export function editedFilesInTurn(events: StoredEvent[]): string[] {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.event.kind === "user") {
      start = i + 1;
      break;
    }
  }

  const errors = new Map<string, boolean>();
  for (let i = start; i < events.length; i++) {
    const ev = events[i]!.event;
    if (ev.kind === "tool-result") errors.set(ev.toolUseId, ev.isError);
  }

  const files = new Map<string, true>();
  for (let i = start; i < events.length; i++) {
    const ev = events[i]!.event;
    if (ev.kind !== "tool-use" || canonicalTool(ev.name) !== "Edit") continue;
    // The call counts only when its matching result came back without an error.
    if (errors.get(ev.toolUseId) !== false) continue;
    for (const file of ev.summary.split(", ").filter(Boolean)) {
      // A clipped summary can't be trusted to name a real path.
      if (file.endsWith("…")) continue;
      files.delete(file);
      files.set(file, true);
    }
  }
  return [...files.keys()];
}

/** Folders the turn-end scan never enters: VCS, dependencies and build output. */
const SCAN_SKIP = new Set(["node_modules", "dist", "out", "build", "target", "__pycache__", "venv"]);
const SCAN_MAX_DEPTH = 6;
const SCAN_MAX_ENTRIES = 20_000;
const SCAN_MAX_FILES = 20;

/**
 * Deliverables (the kinds that open by themselves: docx, pdf, images…) under
 * `root` modified at or after `sinceMs`, oldest first. These are the files an
 * agent wrote with a command, a script or a skill, which no Edit tool-use
 * names. The walk is bounded and skips dot-folders, build output and the
 * `skipDirs` (relative, "/"-separated: other threads' design folders); never throws.
 */
export function filesWrittenSince(root: string, sinceMs: number, skipDirs: readonly string[] = []): string[] {
  const skip = new Set(skipDirs);
  const found: { rel: string; mtime: number }[] = [];
  let entries = 0;
  const walk = (dir: string, rel: string, depth: number): void => {
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list) {
      if (++entries > SCAN_MAX_ENTRIES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < SCAN_MAX_DEPTH && !entry.name.startsWith(".") && !SCAN_SKIP.has(entry.name) && !skip.has(childRel)) walk(join(dir, entry.name), childRel, depth + 1);
      } else if (entry.isFile() && opensByItself(entry.name)) {
        try {
          const mtime = statSync(join(dir, entry.name)).mtimeMs;
          if (mtime >= sinceMs) found.push({ rel: childRel, mtime });
        } catch {
          // Gone between readdir and stat.
        }
      }
    }
  };
  walk(root, "", 0);
  return found
    .sort((a, b) => a.mtime - b.mtime)
    .slice(-SCAN_MAX_FILES)
    .map((f) => f.rel);
}

/** Resolve `p` inside `root`, following symlinks; null when it escapes or can't be resolved. */
export function resolveInside(root: string, p: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const target = isAbsolute(p) ? p : resolve(root, p);
  const real = realpathOf(target);
  if (!real) return null;
  const rel = relative(realRoot, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** realpath a path, or its real parent plus the basename when the file itself doesn't exist yet. */
function realpathOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return null;
    }
  }
}

/** The main-process services the artifacts module leans on; injected so it stays testable. */
export interface ArtifactDeps {
  addVersion(threadId: string, path: string, sha256: string, bytes: number, turnSeq: number): ArtifactVersion | null;
  listVersions(threadId: string): { path: string; versions: ArtifactVersion[] }[];
  writeBlob(sha256: string, content: Buffer): void;
  readBlob(sha256: string): Buffer;
  gitHead(root: string, relPath: string): Promise<string | null>;
  preview(absPath: string): Promise<PreviewResult>;
  fileUrl(threadId: string, relPath: string): string;
}

/**
 * Save a version of every file an agent edited this turn, plus, when
 * `turnStartedAt` is given, every deliverable it wrote some other way (see
 * `filesWrittenSince`; `skipDirs` keeps out what other threads in the same
 * folder write meanwhile). Unreadable, missing, oversized or escaping files are
 * skipped; `changed` names the files that got a new version, while `files` is
 * every file that was recorded.
 */
export function recordTurnArtifacts(
  deps: ArtifactDeps,
  input: { threadId: string; root: string; events: StoredEvent[]; turnSeq: number; turnStartedAt?: number; skipDirs?: readonly string[] },
): { files: string[]; changed: string[] } {
  const files: string[] = [];
  const changed: string[] = [];
  const edits = editedFilesInTurn(input.events);
  const named = new Set(edits.map((p) => resolveInside(input.root, p)));
  const written = input.turnStartedAt === undefined ? [] : filesWrittenSince(input.root, input.turnStartedAt, input.skipDirs).filter((rel) => !named.has(rel));
  for (const edited of [...edits, ...written]) {
    try {
      const rel = resolveInside(input.root, edited);
      if (!rel) continue;
      const abs = join(input.root, rel);
      const stat = statSync(abs);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) continue;
      const buf = readFileSync(abs);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      deps.writeBlob(sha256, buf);
      const version = deps.addVersion(input.threadId, rel, sha256, buf.length, input.turnSeq);
      files.push(rel);
      if (version) changed.push(rel);
    } catch {
      // An unreadable file is not worth failing the turn over.
    }
  }
  return { files, changed };
}

/** Save a plan proposal as the next version of the thread's plan artifact; an unchanged plan adds none. Never throws. */
export function recordPlan(deps: ArtifactDeps, input: { threadId: string; text: string; turnSeq: number }): ArtifactVersion | null {
  return recordPseudo(deps, PLAN_ARTIFACT, input);
}

/** Save text as the next version of a store-only artifact (plan, critique); unchanged or blank text adds none. Never throws. */
export function recordPseudo(deps: ArtifactDeps, path: string, input: { threadId: string; text: string; turnSeq: number }): ArtifactVersion | null {
  if (!input.text.trim()) return null;
  try {
    const buf = Buffer.from(input.text, "utf-8");
    const sha256 = createHash("sha256").update(buf).digest("hex");
    deps.writeBlob(sha256, buf);
    return deps.addVersion(input.threadId, path, sha256, buf.length, input.turnSeq);
  } catch {
    return null;
  }
}

/** A store-only artifact read from the store: the newest version unless one is named. */
function readPseudo(deps: ArtifactDeps, threadId: string, path: string, version: number | null): ArtifactContent {
  const versions = deps.listVersions(threadId).find((v) => v.path === path)?.versions ?? [];
  const entry = version === null ? versions.at(-1) : versions.find((v) => v.version === version);
  if (!entry) return { ok: false, error: version === null ? `No ${(pseudoArtifactLabel(path) ?? "version").toLowerCase()} yet` : "No such version" };
  const bytes = deps.readBlob(entry.sha256);
  return { ok: true, path, kind: "md", bytes: bytes.length, version, ...cutText(bytes) };
}

/** The thread's artifacts, with their kinds; the store's order is kept. */
export function listArtifacts(deps: ArtifactDeps, threadId: string): ArtifactFile[] {
  return deps.listVersions(threadId).map(({ path, versions }) => ({ path, kind: artifactKind(path), versions }));
}

/** Read a file for the panel: the disk copy, or one saved version. Never throws. */
export async function readArtifact(
  deps: ArtifactDeps,
  input: { threadId: string; root: string; path: string; version?: number | null },
): Promise<ArtifactContent> {
  const version = input.version ?? null;
  if (isPseudoArtifact(input.path)) {
    try {
      return readPseudo(deps, input.threadId, input.path, version);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  try {
    const rel = resolveInside(input.root, input.path);
    if (!rel) return { ok: false, error: "Outside the project folder" };
    const kind = artifactKind(rel);
    const versions = deps.listVersions(input.threadId).find((v) => v.path === rel)?.versions ?? [];
    const latest = versions.length ? versions[versions.length - 1]!.version : null;

    let bytes: Buffer;
    if (version !== null) {
      const entry = versions.find((v) => v.version === version);
      if (!entry) return { ok: false, error: "No such version" };
      if (LATEST_ONLY.has(kind) && version !== latest) return { ok: false, error: "Only the latest version can be previewed" };
      bytes = deps.readBlob(entry.sha256);
    } else {
      const abs = join(realpathSync(input.root), rel);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        return { ok: false, error: "File not found" };
      }
      if (!stat.isFile()) return { ok: false, error: "File not found" };
      if (stat.size > MAX_ARTIFACT_BYTES) return { ok: false, error: "Too large to preview" };
      bytes = readFileSync(abs);
    }

    const base = { ok: true as const, path: rel, kind, bytes: bytes.length, version };

    if (kind === "md" || kind === "html" || kind === "svg" || kind === "code" || kind === "text") {
      if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) return { ok: false, error: "Binary file" };
      const cut = cutText(bytes);
      const doc = kind === "html" ? inlineStylesheets(cut.text, input.root, rel) : null;
      return { ...base, ...cut, ...(doc !== null ? { doc } : {}) };
    }

    if (kind === "pdf" || kind === "image") {
      return { ...base, url: deps.fileUrl(input.threadId, rel) };
    }

    // csv, docx, sheet and pptx are rendered by the preview worker.
    const preview = await deps.preview(join(realpathSync(input.root), rel));
    if (!preview.ok) return { ok: false, error: preview.error };
    if (kind === "csv") return { ...base, office: preview.result, ...cutText(bytes) };
    return { ...base, office: preview.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Stylesheets inlined into one HTML preview, in total; past this a link is left as it is. */
const MAX_INLINE_CSS_BYTES = 1024 * 1024;

/**
 * The page with its relative `<link rel="stylesheet">` files (inside the root) inlined as `<style>`, for the panel's
 * sandboxed srcdoc preview, which can't load them itself (a design page's `system/tokens.css`). Null when none apply.
 */
export function inlineStylesheets(html: string, root: string, rel: string): string | null {
  let budget = MAX_INLINE_CSS_BYTES;
  let changed = false;
  const out = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\srel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) return tag;
    const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const raw = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    // Only a plain relative file: no scheme, protocol-relative, root-absolute or data URL.
    if (!raw || /^[a-z][a-z0-9+.-]*:|^[/\\#]/i.test(raw)) return tag;
    let path: string;
    try {
      path = decodeURIComponent(raw.replace(/[?#].*$/, ""));
    } catch {
      return tag;
    }
    const target = resolveInside(root, join(dirname(rel), path));
    if (!target) return tag;
    try {
      const abs = join(realpathSync(root), target);
      const stat = statSync(abs);
      if (!stat.isFile() || stat.size > budget) return tag;
      budget -= stat.size;
      changed = true;
      const media = /\smedia\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const mediaAttr = media ? ` media="${(media[1] ?? media[2] ?? "").replace(/"/g, "&quot;")}"` : "";
      return `<style${mediaAttr}>${readFileSync(abs, "utf-8").replace(/<\/style/gi, "<\\/style")}</style>`;
    } catch {
      return tag;
    }
  });
  return changed ? out : null;
}

/** A version cut to MAX_TEXT_BYTES, decoded as UTF-8. */
function cutText(bytes: Buffer): { text: string; truncated?: boolean } {
  if (bytes.length > MAX_TEXT_BYTES) return { text: bytes.subarray(0, MAX_TEXT_BYTES).toString("utf-8"), truncated: true };
  return { text: bytes.toString("utf-8") };
}

/** Unified diff of one saved version against the one before it, or git HEAD for the first. Null for non-text. */
export async function artifactDiff(
  deps: ArtifactDeps,
  input: { threadId: string; root: string; path: string; version?: number | null },
): Promise<string | null> {
  try {
    // A plan (or critique) has no disk or git copy: its first version diffs against nothing.
    const plan = isPseudoArtifact(input.path);
    const rel = plan ? input.path : resolveInside(input.root, input.path);
    if (!rel) return null;
    if (!DIFFABLE.has(artifactKind(rel))) return null;

    const versions = deps.listVersions(input.threadId).find((v) => v.path === rel)?.versions ?? [];

    if (!versions.length) {
      if (plan) return null;
      const abs = join(input.root, rel);
      if (statSync(abs).size > MAX_TEXT_BYTES) return null;
      const current = readFileSync(abs, "utf-8");
      return unifiedDiff(rel, (await deps.gitHead(input.root, rel)) ?? "", current);
    }

    const want = input.version ?? null;
    const index = want === null ? versions.length - 1 : versions.findIndex((v) => v.version === want);
    if (index < 0) return null;

    const target = versions[index]!;
    const newText = deps.readBlob(target.sha256).toString("utf-8");
    const oldText = index > 0 ? deps.readBlob(versions[index - 1]!.sha256).toString("utf-8") : plan ? "" : ((await deps.gitHead(input.root, rel)) ?? "");
    return unifiedDiff(plan ? (pseudoArtifactLabel(rel) ?? rel) : rel, oldText, newText);
  } catch {
    return null;
  }
}
