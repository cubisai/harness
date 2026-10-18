import { existsSync, mkdirSync, rmdirSync, watch as fsWatch } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

/** The watcher a {@link DesignWatcher} holds, opened by the injected `watchFn`. */
export interface WatchHandle {
  close(): void;
  on?(event: "error", cb: () => void): unknown;
}

/** The listener gets the changed file's path relative to the folder, when the platform reports it. */
export type DesignWatchFn = (dir: string, listener: (file?: string) => void) => WatchHandle;

/** Files CubiQ itself keeps at the top of a design folder: writing them is bookkeeping, not a design change. */
export const UNWATCHED = new Set(["comments.json", ".tier"]);

/** How many distinct paths a burst may name before the change is treated as unknown (reload everything). */
const MAX_PATHS = 200;

/** Whether a reported change is CubiQ's own bookkeeping (no reload for it). */
export function ignoredChange(file: string | undefined): boolean {
  return file !== undefined && UNWATCHED.has(file.replace(/\\/g, "/"));
}

export interface DesignWatcherOptions {
  /** `paths` lists the burst's changed files relative to the folder, or is null when they're unknown. */
  onChange(threadId: string, paths: string[] | null): void;
  debounceMs?: number;
  watchFn?: DesignWatchFn;
}

interface Entry {
  handle: WatchHandle;
  count: number;
  timer: ReturnType<typeof setTimeout> | null;
  dir: string;
  /** The topmost folder the watch created, if any: removed again on close while it's still empty. */
  created: string | null;
  /** The current burst's changed paths, normalized to `/` with no duplicates. */
  paths: Set<string>;
  /** An event in the burst had no reported path, so its files are unknown. */
  unknown: boolean;
  /** The burst named more than MAX_PATHS distinct paths. */
  overflow: boolean;
}

/**
 * Watches each design thread's folder and reports a debounced change once per
 * burst. Watches are reference counted: a second `watch` of the same thread
 * only increments the count, and the folder is created on first watch.
 */
export class DesignWatcher {
  private readonly onChange: (threadId: string, paths: string[] | null) => void;
  private readonly debounceMs: number;
  private readonly watchFn: DesignWatchFn;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: DesignWatcherOptions) {
    this.onChange = opts.onChange;
    this.debounceMs = opts.debounceMs ?? 150;
    this.watchFn = opts.watchFn ?? ((dir, listener) => fsWatch(dir, { recursive: true }, (_event, file) => listener(file ?? undefined)));
  }

  /** Whether a thread's folder is currently watched. */
  has(threadId: string): boolean {
    return this.entries.has(threadId);
  }

  /** Start (or join) a watch on a thread's design folder. Never throws. */
  watch(threadId: string, dir: string): void {
    const existing = this.entries.get(threadId);
    if (existing) {
      existing.count += 1;
      return;
    }
    let handle: WatchHandle;
    let created: string | null = null;
    try {
      created = firstCreated(dir);
      mkdirSync(dir, { recursive: true });
      handle = this.watchFn(dir, (file) => {
        if (!ignoredChange(file)) this.bump(threadId, file);
      });
    } catch (err) {
      console.warn(`DesignWatcher: can't watch ${dir}`, err);
      if (created) removeEmpty(dir, created);
      return;
    }
    const entry: Entry = { handle, count: 1, timer: null, dir, created, paths: new Set(), unknown: false, overflow: false };
    this.entries.set(threadId, entry);
    handle.on?.("error", () => this.forget(threadId));
  }

  /** Drop one reference; the last one closes the watcher and cancels its timer. */
  unwatch(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    this.closeEntry(threadId, entry);
  }

  /** Close every watcher and cancel every pending timer. */
  closeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      try {
        entry.handle.close();
      } catch {
        // Already closed.
      }
      if (entry.created) removeEmpty(entry.dir, entry.created);
    }
    this.entries.clear();
  }

  /** Reset a thread's debounce timer; it fires `onChange` with the burst's paths once the burst ends. */
  private bump(threadId: string, file?: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    if (file === undefined) entry.unknown = true;
    else {
      const rel = file.replace(/\\/g, "/");
      if (entry.paths.size < MAX_PATHS) entry.paths.add(rel);
      else if (!entry.paths.has(rel)) entry.overflow = true;
    }
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const current = this.entries.get(threadId);
      if (current !== entry) return;
      entry.timer = null;
      const paths = entry.unknown || entry.overflow ? null : [...entry.paths];
      entry.paths.clear();
      entry.unknown = false;
      entry.overflow = false;
      this.onChange(threadId, paths);
    }, this.debounceMs);
  }

  private closeEntry(threadId: string, entry: Entry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      entry.handle.close();
    } catch {
      // Already closed.
    }
    if (entry.created) removeEmpty(entry.dir, entry.created);
    if (this.entries.get(threadId) === entry) this.entries.delete(threadId);
  }

  /** A watcher that emitted "error" can't fire again: close and drop it. */
  private forget(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      entry.handle.close();
    } catch {
      // Already failed.
    }
    this.entries.delete(threadId);
  }
}

/**
 * The topmost folder `mkdirSync(dir, { recursive: true })` would create: the
 * shallowest missing ancestor. Computed from `dir` itself, not from the value
 * `mkdirSync` returns (its spelling differs on Windows, which made
 * `removeEmpty` keep walking past the folder the watch actually created).
 */
function firstCreated(dir: string): string | null {
  const missing: string[] = [];
  for (let d = dir; !existsSync(d); ) {
    missing.push(d);
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return missing.at(-1) ?? null;
}

/**
 * Remove `dir` and its parents up to `top` (the folder the watch created) while they're empty, so a design thread
 * that never wrote anything leaves no empty `designs/<id>` behind. A folder with anything in it stays.
 */
function removeEmpty(dir: string, top: string): void {
  for (let d = dir; ; d = dirname(d)) {
    const rel = relative(top, d);
    // Above the topmost folder we created, or sharing no root with it: stop.
    if (rel.startsWith("..") || isAbsolute(rel)) return;
    try {
      rmdirSync(d);
    } catch {
      return;
    }
    if (d === top) return;
  }
}
