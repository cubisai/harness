import { mkdirSync, rmdirSync, watch as fsWatch } from "node:fs";
import { dirname, relative } from "node:path";

/** The watcher a {@link DesignWatcher} holds, opened by the injected `watchFn`. */
export interface WatchHandle {
  close(): void;
  on?(event: "error", cb: () => void): unknown;
}

export type DesignWatchFn = (dir: string, listener: () => void) => WatchHandle;

export interface DesignWatcherOptions {
  onChange(threadId: string): void;
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
}

/**
 * Watches each design thread's folder and reports a debounced change once per
 * burst. Watches are reference counted: a second `watch` of the same thread
 * only increments the count, and the folder is created on first watch.
 */
export class DesignWatcher {
  private readonly onChange: (threadId: string) => void;
  private readonly debounceMs: number;
  private readonly watchFn: DesignWatchFn;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: DesignWatcherOptions) {
    this.onChange = opts.onChange;
    this.debounceMs = opts.debounceMs ?? 150;
    this.watchFn = opts.watchFn ?? ((dir, listener) => fsWatch(dir, { recursive: true }, () => listener()));
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
      created = mkdirSync(dir, { recursive: true }) ?? null;
      handle = this.watchFn(dir, () => this.bump(threadId));
    } catch (err) {
      console.warn(`DesignWatcher: can't watch ${dir}`, err);
      if (created) removeEmpty(dir, created);
      return;
    }
    const entry: Entry = { handle, count: 1, timer: null, dir, created };
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

  /** Reset a thread's debounce timer; it fires `onChange` once the burst ends. */
  private bump(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const current = this.entries.get(threadId);
      if (current !== entry) return;
      entry.timer = null;
      this.onChange(threadId);
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
 * Remove `dir` and its parents up to `top` (the folder the watch created) while they're empty, so a design thread
 * that never wrote anything leaves no empty `designs/<id>` behind. A folder with anything in it stays.
 */
function removeEmpty(dir: string, top: string): void {
  for (let d = dir; ; d = dirname(d)) {
    if (relative(top, d).startsWith("..")) return;
    try {
      rmdirSync(d);
    } catch {
      return;
    }
    if (d === top) return;
  }
}
