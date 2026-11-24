// Hot reload for a previewed Creator draft: one recursive fs watch per draft folder, debounced, so the open preview
// reloads its frame shortly after the agent writes a file. Bounded: the oldest watch closes past the cap.

import { type FSWatcher, watch } from "node:fs";

export const DRAFT_WATCH_DEBOUNCE_MS = 100;
export const DRAFT_WATCH_MAX = 8;

export type WatchFn = (dir: string, onChange: () => void) => { close(): void };

const fsWatch: WatchFn = (dir, onChange) => {
  const w: FSWatcher = watch(dir, { recursive: true }, () => onChange());
  w.on("error", () => {});
  return w;
};

export class DraftWatcher {
  private watches = new Map<string, { threadId: string; dir: string; handle: { close(): void }; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(
    private onReload: (key: string) => void,
    private watchFn: WatchFn = fsWatch,
    private debounceMs = DRAFT_WATCH_DEBOUNCE_MS,
  ) {}

  /** Watch `dir` for the draft `key` (idempotent); past the cap, the oldest watch is closed. */
  watch(key: string, threadId: string, dir: string): void {
    const cur = this.watches.get(key);
    if (cur && cur.dir === dir) return;
    if (cur) this.close(key);
    while (this.watches.size >= DRAFT_WATCH_MAX) this.close(this.watches.keys().next().value!);
    let handle: { close(): void };
    try {
      handle = this.watchFn(dir, () => this.changed(key));
    } catch {
      return;
    }
    this.watches.set(key, { threadId, dir, handle, timer: null });
  }

  /** Close every watch a thread started (thread deleted, or the app quits). */
  forgetThread(threadId: string): void {
    for (const [key, w] of [...this.watches]) if (w.threadId === threadId) this.close(key);
  }

  closeAll(): void {
    for (const key of [...this.watches.keys()]) this.close(key);
  }

  get size(): number {
    return this.watches.size;
  }

  private changed(key: string): void {
    const w = this.watches.get(key);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.timer = null;
      if (this.watches.get(key) === w) this.onReload(key);
    }, this.debounceMs);
  }

  private close(key: string): void {
    const w = this.watches.get(key);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    try {
      w.handle.close();
    } catch {
      // Already closed.
    }
    this.watches.delete(key);
  }
}
