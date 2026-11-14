// Downloads a design kit, checks it against a hash baked into the app, unpacks
// it, validates it, and only then switches the pointer. The order matters: a
// bad or hostile archive never reaches the disk, and a failed install leaves
// the version that was working in place.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import JSZip from "jszip";
import { KIT_EXTENSIONS, KIT_LIMITS, validateKitDir, type KitManifest } from "./kit-schema";
import { KIT_HOSTS } from "./kit-catalog";
import type { KitCatalogEntry } from "./kit-catalog";

export type KitInstallCode = "offline" | "blocked" | "hash" | "archive" | "invalid";

/** A failed install, tagged with the reason so the caller can word its message. */
export class KitInstallError extends Error {
  readonly code: KitInstallCode;

  constructor(code: KitInstallCode, message: string) {
    super(message);
    this.name = "KitInstallError";
    this.code = code;
  }
}

/** One file's declared sizes, read off JSZip's private data object. */
interface DeclaredSizes {
  uncompressedSize?: number;
  compressedSize?: number;
}

/** Above this, a lopsided ratio is worth refusing: small text files can legitimately compress well. */
const RATIO_FLOOR = 64 * 1024;

/** Redirect hops allowed before a URL is treated as a loop. */
const MAX_REDIRECTS = 5;

/**
 * Download `url`, refusing anything but https on `hosts`, and refusing to read
 * more than `maxBytes`. Every hop, the first included, is checked before its
 * request goes out, so a redirect cannot smuggle in another host or scheme.
 */
export async function fetchKitArchive(
  url: string,
  options: { hosts: readonly string[]; maxBytes: number; fetch?: typeof fetch; signal?: AbortSignal },
): Promise<Uint8Array> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let current = url;
  let redirects = 0;

  for (;;) {
    checkAllowed(current, options.hosts);

    let response: Response;
    try {
      response = await doFetch(current, { redirect: "manual", credentials: "omit", signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new KitInstallError("offline", `Could not download ${current}.`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new KitInstallError("blocked", `The download from ${current} went nowhere.`);
      if (redirects >= MAX_REDIRECTS) throw new KitInstallError("blocked", `Too many redirects for ${url}.`);
      redirects += 1;
      try {
        current = new URL(location, current).href;
      } catch {
        throw new KitInstallError("blocked", `A bad redirect from ${current}.`);
      }
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new KitInstallError("offline", `The download from ${current} failed with status ${response.status}.`);
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      throw new KitInstallError("archive", `The kit download is over ${options.maxBytes} bytes.`);
    }
    return readCapped(response, options.maxBytes);
  }
}

/** Refuse anything a kit download must never touch: another scheme, another host, or embedded credentials. */
function checkAllowed(target: string, hosts: readonly string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new KitInstallError("blocked", `Not a web address: ${target}`);
  }
  if (parsed.protocol !== "https:") throw new KitInstallError("blocked", `A kit must be downloaded over https: ${target}`);
  if (parsed.username || parsed.password) throw new KitInstallError("blocked", `A kit address carries credentials: ${target}`);
  if (!hosts.includes(parsed.hostname)) throw new KitInstallError("blocked", `${parsed.hostname} is not a kit host.`);
}

/** Read the body, stopping the moment it passes `maxBytes` rather than after it lands. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new KitInstallError("archive", `The kit download is over ${maxBytes} bytes.`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new KitInstallError("archive", `The kit download is over ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof KitInstallError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new KitInstallError("offline", "The kit download broke off.");
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Whether a file's extension is one a kit may ship, compared case insensitively. */
function allowedExtension(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return KIT_EXTENSIONS.some((e) => e.toLowerCase() === ext);
}

/** Refuse a name that could step outside the kit folder or mean something other than a plain file. */
function checkName(name: string): void {
  if (!name) throw new KitInstallError("archive", `An entry has no name: ${name}`);
  if (name.includes("\0")) throw new KitInstallError("archive", `An entry name has a NUL byte: ${name}`);
  if (name.includes("\\")) throw new KitInstallError("archive", `An entry name uses a backslash: ${name}`);
  if (name.startsWith("/")) throw new KitInstallError("archive", `An entry name is absolute: ${name}`);
  if (/^[A-Za-z]:/.test(name)) throw new KitInstallError("archive", `An entry name has a drive letter: ${name}`);
}

/**
 * Names Windows treats specially, refused on every platform so a kit behaves the same everywhere: a colon opens an
 * alternate data stream, a trailing dot or space is silently dropped, and CON or NUL name a device whatever follows.
 */
const WINDOWS_UNSAFE_CHAR = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

function checkSegmentForWindows(segment: string, name: string): void {
  if (WINDOWS_UNSAFE_CHAR.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment)) {
    throw new KitInstallError("archive", `An entry name isn't safe on every platform: ${name}`);
  }
}

/**
 * The entry count the archive's own directory declares, or null when its end record can't be found. JSZip keeps only
 * the last of two same-named entries, so comparing against this is the one way to see a duplicate.
 */
function declaredEntryCount(bytes: Uint8Array): number | null {
  const END_RECORD = 22;
  const lowest = Math.max(0, bytes.length - END_RECORD - 0xffff);
  for (let at = bytes.length - END_RECORD; at >= lowest; at--) {
    if (bytes[at] === 0x50 && bytes[at + 1] === 0x4b && bytes[at + 2] === 0x05 && bytes[at + 3] === 0x06) {
      return (bytes[at + 10] ?? 0) | ((bytes[at + 11] ?? 0) << 8);
    }
  }
  return null;
}

/** The path segments of an entry, with a directory's trailing slash dropped. */
function segmentsOf(name: string): string[] {
  const parts = name.split("/");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Unpack `bytes` into `destDir`, refusing any archive that could write outside
 * it, blow up in memory, or carry files a kit never holds. Everything that can
 * be judged from the index is judged before a single byte is written.
 */
export async function unpackKitArchive(bytes: Uint8Array, destDir: string): Promise<void> {
  if (bytes.byteLength > KIT_LIMITS.archiveBytes) {
    throw new KitInstallError("archive", `The kit archive is over ${KIT_LIMITS.archiveBytes} bytes.`);
  }

  // Checked before parsing, so a hostile directory never gets walked.
  const declared = declaredEntryCount(bytes);
  if (declared !== null && declared > KIT_LIMITS.entries) {
    throw new KitInstallError("archive", `The kit archive has ${declared} entries, over the ${KIT_LIMITS.entries} allowed.`);
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new KitInstallError("archive", "The download is not a zip archive.");
  }

  const entries = Object.values(zip.files);
  if (entries.length > KIT_LIMITS.entries) {
    throw new KitInstallError("archive", `The kit archive has ${entries.length} entries, over the ${KIT_LIMITS.entries} allowed.`);
  }
  if (declared !== null && declared !== entries.length) {
    throw new KitInstallError("archive", "The kit archive holds two entries with the same name.");
  }

  const root = resolve(destDir);
  const seen = new Set<string>();
  const jobs: { entry: JSZip.JSZipObject; name: string }[] = [];
  let declaredTotal = 0;

  for (const entry of entries) {
    // JSZip cleans `.name` on load, so only the original says what the archive asked for.
    const raw = (entry as { unsafeOriginalName?: string }).unsafeOriginalName;
    const name = raw ?? entry.name;

    checkName(name);
    const parts = segmentsOf(name);
    for (const segment of parts) {
      if (segment === "") throw new KitInstallError("archive", `An entry path has an empty segment: ${name}`);
      if (segment === ".") throw new KitInstallError("archive", `An entry path has a "." segment: ${name}`);
      if (segment === "..") throw new KitInstallError("archive", `An entry path has a ".." segment: ${name}`);
      if (segment.startsWith(".")) throw new KitInstallError("archive", `An entry path has a dotfile: ${name}`);
      checkSegmentForWindows(segment, name);
    }
    if (parts.length > KIT_LIMITS.maxDepth) {
      throw new KitInstallError("archive", `An entry is nested deeper than ${KIT_LIMITS.maxDepth}: ${name}`);
    }
    // Folders are not written, so only files are held to the rest.
    if (entry.dir || name.endsWith("/")) continue;

    const mode = entry.unixPermissions;
    if (typeof mode === "number" && (mode & 0o170000) === 0o120000) {
      throw new KitInstallError("archive", `An entry is a symlink: ${name}`);
    }

    const key = name.toLowerCase();
    if (seen.has(key)) throw new KitInstallError("archive", `An entry name repeats, ignoring case: ${name}`);
    seen.add(key);

    if (!allowedExtension(name)) throw new KitInstallError("archive", `An entry is not a kit file: ${name}`);

    const sizes = (entry as unknown as { _data?: DeclaredSizes })._data;
    const uncompressed = sizes?.uncompressedSize ?? 0;
    const compressed = sizes?.compressedSize ?? 0;
    if (uncompressed > KIT_LIMITS.fileBytes) {
      throw new KitInstallError("archive", `An entry declares ${uncompressed} bytes, over ${KIT_LIMITS.fileBytes}: ${name}`);
    }
    declaredTotal += uncompressed;
    if (declaredTotal > KIT_LIMITS.expandedBytes) {
      throw new KitInstallError("archive", `The kit expands past ${KIT_LIMITS.expandedBytes} bytes at ${name}.`);
    }
    if (uncompressed > RATIO_FLOOR && uncompressed / Math.max(compressed, 1) > KIT_LIMITS.maxRatio) {
      throw new KitInstallError("archive", `An entry compresses too much to trust: ${name}`);
    }

    const target = resolve(root, name);
    if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new KitInstallError("archive", `An entry would land outside the kit folder: ${name}`);
    }

    jobs.push({ entry, name });
  }

  // Inflate one file at a time, counting real bytes: the declared sizes can lie.
  let actualTotal = 0;
  for (const job of jobs) {
    const data = await inflateEntry(job.entry, job.name, KIT_LIMITS.fileBytes, () => actualTotal);
    actualTotal += data.byteLength;
    if (actualTotal > KIT_LIMITS.expandedBytes) {
      throw new KitInstallError("archive", `The kit expands past ${KIT_LIMITS.expandedBytes} bytes at ${job.name}.`);
    }
    const target = resolve(root, job.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

/** Collect one entry's bytes, stopping as soon as it or the running total passes its limit. */
function inflateEntry(entry: JSZip.JSZipObject, name: string, fileLimit: number, totalSoFar: () => number): Promise<Uint8Array> {
  return new Promise((resolveBytes, rejectBytes) => {
    const stream = (
      entry as unknown as { internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array> }
    ).internalStream("uint8array");
    const chunks: Uint8Array[] = [];
    let read = 0;
    let settled = false;

    const fail = (error: KitInstallError): void => {
      if (settled) return;
      settled = true;
      stream.pause();
      rejectBytes(error);
    };

    stream
      .on("data", (chunk: Uint8Array) => {
        if (settled) return;
        read += chunk.byteLength;
        if (read > fileLimit) {
          fail(new KitInstallError("archive", `An entry inflates past ${fileLimit} bytes: ${name}`));
          return;
        }
        if (totalSoFar() + read > KIT_LIMITS.expandedBytes) {
          fail(new KitInstallError("archive", `The kit expands past ${KIT_LIMITS.expandedBytes} bytes at ${name}.`));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (error: Error) => {
        fail(new KitInstallError("archive", `An entry could not be read: ${name} (${error.message})`));
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        const out = new Uint8Array(read);
        let at = 0;
        for (const chunk of chunks) {
          out.set(chunk, at);
          at += chunk.byteLength;
        }
        resolveBytes(out);
      })
      .resume();
  });
}

interface ActiveEntry {
  version: string;
  sha256: string;
  source: string;
}

/** Numeric compare of two x.y.z versions: negative, 0, or positive like a sort comparator. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((n) => Number(n));
  const right = b.split(".").map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const KIT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KIT_VERSION = /^\d+\.\d+\.\d+$/;

/** Whether a value read back from active.json is worth keeping. Its id and version become a folder path. */
function isActiveEntry(value: unknown): value is ActiveEntry {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.version === "string" && KIT_VERSION.test(o.version) && typeof o.sha256 === "string" && typeof o.source === "string";
}

/** Rename, retrying the transient Windows locks that make a good rename look like a failure. */
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
  }
}

/** Remove a path, ignoring any failure: cleanup never turns a success into an error. */
export function removeQuietly(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Leftover files get cleaned up next time cleanStaging runs.
  }
}

/**
 * The installed kits on disk: immutable version folders plus active.json, the
 * pointer saying which version each kit runs. A pointer write that lands is the
 * moment an install becomes real.
 */
export class KitStore {
  private readonly packsDir: string;

  constructor(packsDir: string) {
    this.packsDir = packsDir;
  }

  private get stagingDir(): string {
    return join(this.packsDir, "staging");
  }

  private get kitsDir(): string {
    return join(this.packsDir, "kits");
  }

  private get pointerFile(): string {
    return join(this.packsDir, "active.json");
  }

  /** Drop staging folders from installs that were interrupted. */
  cleanStaging(): void {
    try {
      if (!existsSync(this.stagingDir)) return;
      for (const name of readdirSync(this.stagingDir)) removeQuietly(join(this.stagingDir, name));
    } catch {
      // Best effort only.
    }
  }

  /** Which version of each kit is active. A missing or corrupt file reads as none. */
  active(): Record<string, ActiveEntry> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.pointerFile, "utf-8"));
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ActiveEntry> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (KIT_ID.test(id) && isActiveEntry(value)) out[id] = { version: value.version, sha256: value.sha256, source: value.source };
    }
    return out;
  }

  /** The active version's folder for `id`, or null when the pointer or the folder is gone. */
  activeDir(id: string): string | null {
    const entry = this.active()[id];
    if (!entry) return null;
    const dir = join(this.kitsDir, `${id}@${entry.version}`);
    return existsSync(dir) ? dir : null;
  }

  /**
   * Install one catalog entry: download, hash, unpack to a staging folder, and
   * validate all happen before anything visible changes. The rename and pointer
   * write come last, so a failure leaves the old version running.
   */
  async install(
    entry: KitCatalogEntry,
    options: { hosts?: readonly string[]; fetch?: typeof fetch; signal?: AbortSignal } = {},
  ): Promise<{ dir: string; manifest: KitManifest; reused: boolean }> {
    let staging: string | null = null;
    try {
      // The id and version become folder names, so they are held to that.
      if (!KIT_ID.test(entry.id)) throw new KitInstallError("invalid", `Not a kit id: ${entry.id}`);
      if (!KIT_VERSION.test(entry.version)) throw new KitInstallError("invalid", `Not a kit version: ${entry.version}`);
      if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new KitInstallError("invalid", "The kit hash is not a lowercase sha256.");

      const current = this.active()[entry.id];
      if (current && compareVersions(current.version, entry.version) > 0) {
        throw new KitInstallError("invalid", `Kit ${entry.id} is at ${current.version}, newer than ${entry.version}.`);
      }

      const finalDir = join(this.kitsDir, `${entry.id}@${entry.version}`);
      if (current && current.version === entry.version && current.sha256 === entry.sha256 && existsSync(finalDir)) {
        const check = validateKitDir(finalDir, entry.id);
        if (check.ok) return { dir: finalDir, manifest: check.manifest, reused: true };
      }

      const bytes = await fetchKitArchive(entry.url, {
        hosts: options.hosts ?? KIT_HOSTS,
        maxBytes: KIT_LIMITS.archiveBytes,
        fetch: options.fetch,
        signal: options.signal,
      });

      // Nothing below this line may run on bytes that failed the hash.
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== entry.sha256) throw new KitInstallError("hash", `Kit ${entry.id} does not match its hash.`);

      staging = join(this.stagingDir, randomUUID());
      mkdirSync(staging, { recursive: true });
      await unpackKitArchive(bytes, staging);

      const check = validateKitDir(staging, entry.id);
      if (!check.ok) throw new KitInstallError("invalid", `Kit ${entry.id} is not valid: ${check.errors.join("; ")}`);
      if (check.manifest.version !== entry.version) {
        throw new KitInstallError("invalid", `Kit ${entry.id} says ${check.manifest.version}, not ${entry.version}.`);
      }

      mkdirSync(this.kitsDir, { recursive: true });
      if (existsSync(finalDir)) {
        // A leftover that did not pass the reuse check, or a rebuild of the same version.
        const aside = join(this.stagingDir, `${randomUUID()}-old`);
        renameWithRetry(finalDir, aside);
        renameWithRetry(staging, finalDir);
        removeQuietly(aside);
      } else {
        renameWithRetry(staging, finalDir);
      }
      staging = null;

      const next: Record<string, ActiveEntry> = { ...this.active(), [entry.id]: { version: entry.version, sha256: entry.sha256, source: entry.url } };
      this.writeActive(next);

      // Only a different version's folder is now dead; the same one was just replaced.
      if (current && current.version !== entry.version) removeQuietly(join(this.kitsDir, `${entry.id}@${current.version}`));

      return { dir: finalDir, manifest: check.manifest, reused: false };
    } catch (error) {
      if (staging) removeQuietly(staging);
      if (error instanceof KitInstallError || options.signal?.aborted) throw error;
      throw new KitInstallError("invalid", error instanceof Error ? error.message : String(error));
    }
  }

  /** Write the pointer through a temp file and a rename, so it is never half written. */
  private writeActive(next: Record<string, ActiveEntry>): void {
    mkdirSync(this.packsDir, { recursive: true });
    const tmp = `${this.pointerFile}.tmp.${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameWithRetry(tmp, this.pointerFile);
  }
}
