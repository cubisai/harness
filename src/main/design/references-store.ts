// Downloads GradientDeck's design references, an index plus one Markdown file
// per style and variant, into a folder on disk. Files are fetched through the
// same host checks a kit download uses, written as .part and renamed into place,
// and only swapped into current/ once the whole set has landed. An interrupted
// run keeps its complete files in staging so the next run resumes.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchKitArchive, KitInstallError, removeQuietly, renameWithRetry } from "./kit-install";

export const REFERENCE_HOST = "ui.gradientdeck.com";
export const REFERENCE_ORIGIN = `https://${REFERENCE_HOST}`;
export const REFERENCE_FILE_MAX = 256 * 1024;
export const REFERENCE_INDEX_MAX = 4 * 1024 * 1024;
export const REFERENCE_MAX_ENTRIES = 5000;
/** One Markdown request may take this long; a file that never answers is recorded missing instead of stalling the run. */
export const REFERENCE_FILE_TIMEOUT_MS = 20_000;

export type ReferenceVariant = "compact" | "extended";
export const REFERENCE_VARIANTS: readonly ReferenceVariant[] = ["compact", "extended"];
export type ReferenceTheme = "light" | "dark" | "mixed";
export type ReferenceColor = { name: string; hex: string };

export type ReferenceIndexEntry = {
  slug: string;
  name: string;
  nickname?: string;
  industry?: string;
  theme: ReferenceTheme;
  host?: string;
  colors: ReferenceColor[];
  fonts?: string[];
};

export type ReferenceFile = { sha256: string; bytes: number };
export type ReferenceMissing = { slug: string; variant: ReferenceVariant; reason: string };

export type ReferenceManifest = {
  version: 1;
  source: string;
  fetchedAt: string;
  index: ReferenceFile;
  files: Record<string, Partial<Record<ReferenceVariant, ReferenceFile>>>;
  missing: ReferenceMissing[];
};

export type ReferenceStatus =
  | { state: "none" }
  | { state: "installed"; count: number; fetchedAt: string; missing: number; bytes: number };

export type ReferenceProgress = { done: number; total: number; bytes: number };

export type ReferenceDownloadCode = "offline" | "invalid" | "cancelled";

/** A failed reference download, tagged with the reason so the caller can word its message. */
export class ReferenceDownloadError extends Error {
  readonly code: ReferenceDownloadCode;

  constructor(code: ReferenceDownloadCode, message: string) {
    super(message);
    this.name = "ReferenceDownloadError";
    this.code = code;
  }
}

const REFERENCE_SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const REFERENCE_HEX = /^#[0-9a-f]{3,8}$/i;

/** Whether a slug is safe to use as a folder name and a URL segment. */
export function isReferenceSlug(slug: string): boolean {
  return REFERENCE_SLUG.test(slug);
}

/** The Markdown URL for one style, refusing a slug that could step outside the styles folder. */
export function referenceUrl(slug: string, variant: ReferenceVariant): string {
  if (!isReferenceSlug(slug)) throw new ReferenceDownloadError("invalid", `Not a design reference slug: ${slug}`);
  const file = variant === "compact" ? "design.md" : "design-extended.md";
  return `${REFERENCE_ORIGIN}/styles/${slug}/${file}`;
}

/** Whether a body starts like a web page, which means a proxy or a login screen answered instead. */
export function looksLikeHtml(bytes: Uint8Array): boolean {
  const text = new TextDecoder("utf-8").decode(bytes.subarray(0, 512));
  const head = text.replace(/^[\s\uFEFF]+/, "").toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<body");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVariant(value: unknown): value is ReferenceVariant {
  return value === "compact" || value === "extended";
}

function isTheme(value: unknown): value is ReferenceTheme {
  return value === "light" || value === "dark" || value === "mixed";
}

/** The colors worth keeping: a name and a plain hex value, at most sixteen. */
function readColors(value: unknown): ReferenceColor[] {
  if (!Array.isArray(value)) return [];
  const out: ReferenceColor[] = [];
  for (const item of value) {
    if (out.length >= 16) break;
    if (!isRecord(item)) continue;
    if (typeof item.name !== "string" || typeof item.hex !== "string") continue;
    if (!REFERENCE_HEX.test(item.hex)) continue;
    out.push({ name: item.name, hex: item.hex });
  }
  return out;
}

/** The font names worth keeping, whether the index sends strings or objects, at most eight. */
function readFonts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (out.length >= 8) break;
    if (typeof item === "string") {
      out.push(item);
    } else if (isRecord(item)) {
      if (typeof item.name === "string") out.push(item.name);
      else if (typeof item.family === "string") out.push(item.family);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Read the index, keeping only the fields this app uses. A malformed entry is
 * dropped rather than failing the whole download, but a body that is not a list
 * is a hard error: it means the wrong thing was served.
 */
export function parseReferenceIndex(text: string): ReferenceIndexEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReferenceDownloadError("invalid", "The design reference index is not JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new ReferenceDownloadError("invalid", "The design reference index is not a list.");
  }

  const out: ReferenceIndexEntry[] = [];
  const seen = new Set<string>();

  for (const value of parsed) {
    if (!isRecord(value)) continue;

    const slug = value.slug;
    if (typeof slug !== "string" || !isReferenceSlug(slug) || seen.has(slug)) continue;

    const name = value.name;
    if (typeof name !== "string" || name.trim() === "") continue;

    const theme = value.theme;
    if (!isTheme(theme)) continue;

    seen.add(slug);
    const entry: ReferenceIndexEntry = {
      slug,
      name: name.slice(0, 200),
      theme,
      colors: readColors(value.colors),
    };
    const nickname = value.nickname;
    const industry = value.industry;
    const host = value.host;
    if (typeof nickname === "string") entry.nickname = nickname.slice(0, 200);
    if (typeof industry === "string") entry.industry = industry.slice(0, 200);
    if (typeof host === "string") entry.host = host.slice(0, 200);
    const fonts = readFonts(value.fonts);
    if (fonts) entry.fonts = fonts;
    out.push(entry);
  }

  if (out.length > REFERENCE_MAX_ENTRIES) {
    throw new ReferenceDownloadError("invalid", `The design reference index has over ${REFERENCE_MAX_ENTRIES} entries.`);
  }
  return out;
}

function isFileRef(value: unknown): value is ReferenceFile {
  return isRecord(value) && typeof value.sha256 === "string" && typeof value.bytes === "number" && Number.isFinite(value.bytes);
}

/** A manifest read off disk, or null when it is absent or not the shape this app wrote. */
function parseManifestText(text: string): ReferenceManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null;

  const source = parsed.source;
  const fetchedAt = parsed.fetchedAt;
  const index = parsed.index;
  const rawFiles = parsed.files;
  const rawMissing = parsed.missing;
  if (typeof source !== "string" || typeof fetchedAt !== "string") return null;
  if (!isFileRef(index)) return null;
  if (!isRecord(rawFiles) || !Array.isArray(rawMissing)) return null;

  const files: Record<string, Partial<Record<ReferenceVariant, ReferenceFile>>> = {};
  for (const [slug, value] of Object.entries(rawFiles)) {
    if (!isReferenceSlug(slug) || !isRecord(value)) continue;
    const per: Partial<Record<ReferenceVariant, ReferenceFile>> = {};
    for (const variant of REFERENCE_VARIANTS) {
      const file = value[variant];
      if (isFileRef(file)) per[variant] = { sha256: file.sha256, bytes: file.bytes };
    }
    if (Object.keys(per).length > 0) files[slug] = per;
  }

  const missing: ReferenceMissing[] = [];
  for (const value of rawMissing) {
    if (!isRecord(value)) continue;
    const slug = value.slug;
    const variant = value.variant;
    const reason = value.reason;
    if (typeof slug !== "string" || !isVariant(variant) || typeof reason !== "string") continue;
    missing.push({ slug, variant, reason });
  }

  return { version: 1, source, fetchedAt, index, files, missing };
}

/** Write a file through a .part name and a rename, so a complete-looking file is always complete. */
function writeThroughPart(file: string, bytes: Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const part = `${file}.part`;
  writeFileSync(part, bytes);
  renameWithRetry(part, file);
}

/** One item's outcome: saved bytes, a recorded miss, or the whole run stopping. */
type CollectResult = { kind: "saved"; bytes: number } | { kind: "missing"; reason: string } | { kind: "aborted" };

/**
 * The installed reference set on disk: a current/ folder holding the index, its
 * manifest and the Markdown files, plus a staging/ folder that survives an
 * interrupted run so the next one resumes.
 */
export class ReferenceStore {
  private readonly root: string;
  private cachedManifest: ReferenceManifest | null | undefined;
  private cachedIndex: ReferenceIndexEntry[] | undefined;

  constructor(root: string) {
    this.root = root;
  }

  /** Forget the parsed files after the set on disk changes. */
  private clearCaches(): void {
    this.cachedManifest = undefined;
    this.cachedIndex = undefined;
  }

  private get currentDir(): string {
    return join(this.root, "current");
  }

  private get stagingDir(): string {
    return join(this.root, "staging");
  }

  private get currentManifestFile(): string {
    return join(this.currentDir, "manifest.json");
  }

  private get currentLibraryFile(): string {
    return join(this.currentDir, "library.json");
  }

  private get stagingManifestFile(): string {
    return join(this.stagingDir, "manifest.json");
  }

  private get stagingLibraryFile(): string {
    return join(this.stagingDir, "library.json");
  }

  /** Where one variant of one style lives under `dir`; the s- prefix keeps Windows-reserved names safe. */
  private styleFile(dir: string, slug: string, variant: ReferenceVariant): string {
    return join(dir, "styles", `s-${slug}`, variant === "compact" ? "compact.md" : "extended.md");
  }

  /** What is installed right now. A missing or unreadable manifest reads as none. */
  status(): ReferenceStatus {
    const manifest = this.manifest();
    if (!manifest) return { state: "none" };

    let count = 0;
    let bytes = manifest.index.bytes;
    for (const per of Object.values(manifest.files)) {
      if (Object.keys(per).length === 0) continue;
      count += 1;
      for (const file of Object.values(per)) if (file) bytes += file.bytes;
    }
    return { state: "installed", count, fetchedAt: manifest.fetchedAt, missing: manifest.missing.length, bytes };
  }

  /** The installed manifest, or null when it is absent or malformed. */
  manifest(): ReferenceManifest | null {
    if (this.cachedManifest !== undefined) return this.cachedManifest;
    let manifest: ReferenceManifest | null;
    try {
      manifest = parseManifestText(readFileSync(this.currentManifestFile, "utf-8"));
    } catch {
      manifest = null;
    }
    this.cachedManifest = manifest;
    return manifest;
  }

  /** The installed index, or an empty list when it is absent or unreadable. */
  index(): ReferenceIndexEntry[] {
    if (this.cachedIndex !== undefined) return this.cachedIndex;
    let entries: ReferenceIndexEntry[];
    try {
      entries = parseReferenceIndex(readFileSync(this.currentLibraryFile, "utf-8"));
    } catch {
      entries = [];
    }
    this.cachedIndex = entries;
    return entries;
  }

  /** One Markdown file, but only when its bytes still match the manifest. */
  read(slug: string, variant: ReferenceVariant): string | null {
    if (!isReferenceSlug(slug)) return null;
    const manifest = this.manifest();
    if (!manifest) return null;
    const expected = manifest.files[slug]?.[variant];
    if (!expected) return null;

    let bytes: Uint8Array;
    try {
      bytes = readFileSync(this.styleFile(this.currentDir, slug, variant));
    } catch {
      return null;
    }
    if (bytes.byteLength !== expected.bytes) return null;
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expected.sha256) return null;
    return new TextDecoder("utf-8").decode(bytes);
  }

  /** Drop half-written files from an interrupted run, keeping every complete file for resume. */
  cleanStaging(): void {
    const walk = (dir: string): void => {
      const entries = (() => {
        try {
          return readdirSync(dir, { withFileTypes: true });
        } catch {
          return [];
        }
      })();
      for (const entry of entries) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith(".part")) removeQuietly(child);
      }
    };
    walk(this.stagingDir);
  }

  /** Remove every installed and staged reference. */
  remove(): void {
    removeQuietly(this.root);
    this.clearCaches();
  }

  /**
   * Download the index and every Markdown file into staging, reusing what is
   * already there and what the installed set already holds, then swap staging
   * into current. Nothing visible changes until the swap.
   */
  async download(
    options: { fetch?: typeof fetch; signal?: AbortSignal; onProgress?: (p: ReferenceProgress) => void; concurrency?: number; fileTimeoutMs?: number } = {},
  ): Promise<ReferenceStatus> {
    const { fetch: doFetch, signal, onProgress, concurrency = 8, fileTimeoutMs = REFERENCE_FILE_TIMEOUT_MS } = options;
    if (signal?.aborted) throw new ReferenceDownloadError("cancelled", "The design reference download was cancelled.");

    let indexBytes: Uint8Array;
    try {
      indexBytes = await fetchKitArchive(`${REFERENCE_ORIGIN}/library.json`, {
        hosts: [REFERENCE_HOST],
        maxBytes: REFERENCE_INDEX_MAX,
        fetch: doFetch,
        signal,
      });
    } catch {
      if (signal?.aborted) throw new ReferenceDownloadError("cancelled", "The design reference download was cancelled.");
      throw new ReferenceDownloadError("offline", "Could not download the design reference index.");
    }

    if (looksLikeHtml(indexBytes)) {
      throw new ReferenceDownloadError("invalid", "The design reference index is a web page, not JSON.");
    }
    const entries = parseReferenceIndex(new TextDecoder("utf-8").decode(indexBytes));
    if (entries.length === 0) throw new ReferenceDownloadError("invalid", "The design reference index is empty.");

    mkdirSync(this.stagingDir, { recursive: true });
    this.cleanStaging();
    writeThroughPart(this.stagingLibraryFile, indexBytes);

    // The old index decides which files can be copied instead of downloaded.
    const oldManifest = this.manifest();
    const oldEntries = new Map<string, string>();
    for (const entry of this.index()) oldEntries.set(entry.slug, JSON.stringify(entry));

    const list: { entry: ReferenceIndexEntry; variant: ReferenceVariant }[] = [];
    for (const entry of entries) for (const variant of REFERENCE_VARIANTS) list.push({ entry, variant });

    const total = list.length;
    const missing: ReferenceMissing[] = [];
    const width = Math.max(1, Math.floor(concurrency));
    let next = 0;
    let done = 0;
    let bytesSaved = 0;
    let aborted = false;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (aborted || signal?.aborted) {
          aborted = true;
          return;
        }
        const at = next;
        next += 1;
        if (at >= list.length) return;
        const item = list[at];
        if (!item) return;

        const result = await this.collect(item, oldManifest, oldEntries, doFetch, signal, fileTimeoutMs);
        if (result.kind === "aborted") {
          aborted = true;
          return;
        }
        if (result.kind === "missing") {
          missing.push({ slug: item.entry.slug, variant: item.variant, reason: result.reason });
        } else {
          bytesSaved += result.bytes;
        }
        done += 1;
        onProgress?.({ done, total, bytes: bytesSaved });
      }
    };

    await Promise.all(Array.from({ length: Math.min(width, list.length || 1) }, () => worker()));

    if (aborted || signal?.aborted) {
      this.cleanStaging();
      throw new ReferenceDownloadError("cancelled", "The design reference download was cancelled.");
    }

    // Hash only what is actually in staging: a reused file and a fresh one look the same here.
    const files: Record<string, Partial<Record<ReferenceVariant, ReferenceFile>>> = {};
    for (const entry of entries) {
      const per: Partial<Record<ReferenceVariant, ReferenceFile>> = {};
      for (const variant of REFERENCE_VARIANTS) {
        let bytes: Uint8Array;
        try {
          bytes = readFileSync(this.styleFile(this.stagingDir, entry.slug, variant));
        } catch {
          continue;
        }
        per[variant] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
      }
      if (Object.keys(per).length > 0) files[entry.slug] = per;
    }

    if (Object.keys(files).length === 0) {
      throw new ReferenceDownloadError("offline", "Could not download any design references.");
    }

    const manifest: ReferenceManifest = {
      version: 1,
      source: REFERENCE_ORIGIN,
      fetchedAt: new Date().toISOString(),
      index: { sha256: createHash("sha256").update(indexBytes).digest("hex"), bytes: indexBytes.byteLength },
      files,
      missing,
    };
    writeThroughPart(this.stagingManifestFile, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));

    // The swap: the old set is moved aside, staging takes its place, the old folder goes.
    // Caches are dropped even when a rename throws, since the old set may already be moved aside.
    try {
      if (existsSync(this.currentDir)) renameWithRetry(this.currentDir, join(this.root, `old-${randomUUID()}`));
      renameWithRetry(this.stagingDir, this.currentDir);
    } finally {
      this.clearCaches();
    }
    this.removeOldFolders();

    return this.status();
  }

  /** Save one file, preferring a staged copy, then an unchanged installed copy, then a download. */
  private async collect(
    item: { entry: ReferenceIndexEntry; variant: ReferenceVariant },
    oldManifest: ReferenceManifest | null,
    oldEntries: Map<string, string>,
    doFetch: typeof fetch | undefined,
    signal: AbortSignal | undefined,
    fileTimeoutMs: number,
  ): Promise<CollectResult> {
    const { entry, variant } = item;
    const target = this.styleFile(this.stagingDir, entry.slug, variant);

    // a. A complete file from an earlier run is already the answer.
    try {
      if (existsSync(target)) return { kind: "saved", bytes: readFileSync(target).byteLength };
    } catch {
      // Unreadable is not reusable; fall through to the next choice.
    }

    // b. An entry the new index did not change still matches its installed file.
    const unchanged = oldEntries.get(entry.slug) === JSON.stringify(entry);
    if (oldManifest && unchanged && oldManifest.files[entry.slug]?.[variant]) {
      try {
        const source = this.styleFile(this.currentDir, entry.slug, variant);
        if (existsSync(source)) {
          const bytes = readFileSync(source);
          writeThroughPart(target, bytes);
          return { kind: "saved", bytes: bytes.byteLength };
        }
      } catch {
        // Fall through to a download when the old copy cannot be read.
      }
    }

    // c. Download, retrying a real failure exactly once. A miss never fails the whole run.
    const url = referenceUrl(entry.slug, variant);
    let reason = "offline";
    for (let attempt = 0; attempt < 2; attempt++) {
      const timeout = AbortSignal.timeout(fileTimeoutMs);
      try {
        const bytes = await fetchKitArchive(url, {
          hosts: [REFERENCE_HOST],
          maxBytes: REFERENCE_FILE_MAX,
          fetch: doFetch,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (bytes.byteLength === 0) return { kind: "missing", reason: "empty" };
        if (looksLikeHtml(bytes)) return { kind: "missing", reason: "html" };
        writeThroughPart(target, bytes);
        return { kind: "saved", bytes: bytes.byteLength };
      } catch (error) {
        if (signal?.aborted) return { kind: "aborted" };
        if (timeout.aborted) return { kind: "missing", reason: "timeout" };
        reason = error instanceof KitInstallError ? error.code : "offline";
        // A refused host or an oversize body fails the same way twice: only a network failure is worth a retry.
        if (reason === "blocked" || reason === "archive") break;
      }
    }
    return { kind: "missing", reason };
  }

  /** Remove folders left by an earlier swap that did not finish cleaning up. */
  private removeOldFolders(): void {
    const names = (() => {
      try {
        return readdirSync(this.root);
      } catch {
        return [];
      }
    })();
    for (const name of names) {
      if (name.startsWith("old-")) removeQuietly(join(this.root, name));
    }
  }
}
