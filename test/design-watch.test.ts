import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesignWatcher } from "../src/main/design/watch";
import { tempDir } from "./helpers";

/** A DesignWatcher with a fake fs watcher whose listener the test can fire. */
function harness(): {
  watcher: DesignWatcher;
  watchFn: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onChange: ReturnType<typeof vi.fn>;
  fire: (file?: string) => void;
  opened: () => number;
} {
  const listeners: ((file?: string) => void)[] = [];
  const close = vi.fn();
  const watchFn = vi.fn((_dir: string, listener: (file?: string) => void) => {
    listeners.push(listener);
    return { close };
  });
  const onChange = vi.fn();
  const watcher = new DesignWatcher({ onChange, watchFn, debounceMs: 150 });
  return { watcher, watchFn, close, onChange, fire: (file) => listeners[0]?.(file), opened: () => listeners.length };
}

describe("DesignWatcher", () => {
  it("debounces a burst into one change with the thread id", () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.watcher.watch("t", tempDir());
      expect(h.watchFn).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) h.fire();
      expect(h.onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(149);
      expect(h.onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(h.onChange).toHaveBeenCalledTimes(1);
      // No path was reported, so the burst's files are unknown (null).
      expect(h.onChange).toHaveBeenCalledWith("t", null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names a burst's changed paths, normalized, and reports null when any event has no file", () => {
    vi.useFakeTimers();
    try {
      const a = harness();
      a.watcher.watch("t", tempDir());
      a.fire("a.html");
      a.fire("sub\\b.html");
      vi.advanceTimersByTime(150);
      expect(a.onChange).toHaveBeenCalledWith("t", ["a.html", "sub/b.html"]);

      const b = harness();
      b.watcher.watch("t", tempDir());
      b.fire("a.html");
      b.fire();
      vi.advanceTimersByTime(150);
      expect(b.onChange).toHaveBeenCalledWith("t", null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an atomic write's temp file out, so the burst names just the page", () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.watcher.watch("t", tempDir());
      // Claude's Write/Edit: the temp file appears, then is renamed onto the page.
      h.fire("index.html.tmp.40323.56af1717c752");
      h.fire("index.html");
      h.fire("sub\\about.html.tmp.7.abc");
      vi.advanceTimersByTime(150);
      expect(h.onChange).toHaveBeenCalledWith("t", ["index.html"]);
      // A file that only looks a bit like one still counts.
      h.fire("notes.tmp.html");
      vi.advanceTimersByTime(150);
      expect(h.onChange).toHaveBeenLastCalledWith("t", ["notes.tmp.html"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports null once a burst names more than 200 paths", () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.watcher.watch("t", tempDir());
      for (let i = 0; i < 201; i++) h.fire(`p${i}.html`);
      vi.advanceTimersByTime(150);
      expect(h.onChange).toHaveBeenCalledWith("t", null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reference-counts watches per thread", () => {
    const h = harness();
    const dir = tempDir();
    h.watcher.watch("t", dir);
    h.watcher.watch("t", dir);
    expect(h.watchFn).toHaveBeenCalledTimes(1);
    expect(h.watcher.has("t")).toBe(true);
    h.watcher.unwatch("t");
    expect(h.watcher.has("t")).toBe(true);
    expect(h.close).not.toHaveBeenCalled();
    h.watcher.unwatch("t");
    expect(h.watcher.has("t")).toBe(false);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("closes every watcher and drops pending timers", () => {
    vi.useFakeTimers();
    try {
      const closes = [vi.fn(), vi.fn()];
      const listeners: (() => void)[] = [];
      const watchFn = vi.fn((_dir: string, listener: () => void) => {
        listeners.push(listener);
        return { close: closes[listeners.length - 1]! };
      });
      const onChange = vi.fn();
      const watcher = new DesignWatcher({ onChange, watchFn });
      watcher.watch("a", tempDir());
      watcher.watch("b", tempDir());
      for (const listener of listeners) listener();
      watcher.closeAll();
      expect(watcher.has("a")).toBe(false);
      expect(watcher.has("b")).toBe(false);
      expect(closes[0]).toHaveBeenCalledTimes(1);
      expect(closes[1]).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't reload for CubiQ's own bookkeeping files (comments, tier marker)", () => {
    vi.useFakeTimers();
    try {
      let listener: (file?: string) => void = () => {};
      const onChange = vi.fn();
      const watcher = new DesignWatcher({
        onChange,
        watchFn: (_dir, l) => {
          listener = l;
          return { close: () => {} };
        },
      });
      watcher.watch("t", tempDir());
      listener("comments.json");
      listener(".tier");
      vi.advanceTimersByTime(1000);
      expect(onChange).not.toHaveBeenCalled();
      // A page, a nested comments.json, or a change with no name still reloads.
      listener("index.html");
      vi.advanceTimersByTime(1000);
      listener("sub\\comments.json");
      vi.advanceTimersByTime(1000);
      listener();
      vi.advanceTimersByTime(1000);
      expect(onChange).toHaveBeenCalledTimes(3);
      // Only the real page and the nested (not top-level) bookkeeping file are named.
      expect(onChange.mock.calls.map((c) => c[1])).toEqual([["index.html"], ["sub/comments.json"], null]);
      watcher.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates the watched folder on first watch", () => {
    const dir = join(tempDir(), "nested", "design");
    const watcher = new DesignWatcher({ onChange: () => {}, watchFn: () => ({ close: () => {} }) });
    watcher.watch("t", dir);
    expect(existsSync(dir)).toBe(true);
    watcher.closeAll();
  });

  it("fires on a real file write with the default watcher", async () => {
    const dir = join(tempDir(), "watched");
    const onChange = vi.fn();
    const watcher = new DesignWatcher({ onChange, debounceMs: 30 });
    try {
      watcher.watch("t", dir);
      // macOS's FSEvents can miss a write made the instant the watch starts, so keep writing (as an agent does).
      const deadline = Date.now() + 3000;
      for (let i = 0; Date.now() < deadline && onChange.mock.calls.length === 0; i++) {
        writeFileSync(join(dir, "index.html"), `<p>hi ${i}</p>`);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(onChange.mock.calls.at(-1)?.[0]).toBe("t");
    } finally {
      watcher.closeAll();
    }
  });

  it("removes the folders it created when nothing was written there, and keeps them otherwise", () => {
    const fake = () => ({ close: () => {} });
    const project = tempDir();
    const watcher = new DesignWatcher({ onChange: () => {}, watchFn: fake });
    const empty = join(project, "designs", "aaaa1111");
    watcher.watch("a", empty);
    expect(existsSync(empty)).toBe(true);
    watcher.unwatch("a");
    expect(existsSync(join(project, "designs"))).toBe(false);
    expect(existsSync(project)).toBe(true);

    const used = join(project, "designs", "bbbb2222");
    watcher.watch("b", used);
    writeFileSync(join(used, "index.html"), "<p>hi</p>");
    watcher.closeAll();
    expect(existsSync(join(used, "index.html"))).toBe(true);
  });
});
